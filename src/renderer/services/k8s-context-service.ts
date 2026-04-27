/**
 * Copyright (c) 2026 Freelens K8s SRE Assistant Authors.
 * Licensed under MIT License.
 *
 * Kubernetes Context Service - gathers cluster information
 * using the Freelens extensions API.
 *
 * Freelens stores are LAZY — they only hold resources the user has browsed.
 * To get a full cluster view we call `KubeApi.list()` directly, which
 * queries the K8s API server for ALL resources across all namespaces.
 * The store is used as a fallback only.
 */

import { Renderer } from "@freelensapp/extensions";
import type {
  ClusterContext,
  PodRelations,
} from "../../common/types";
import { extractContainerSummaries } from "./context/k8s-compressor";

/* ─── helpers ─── */

/** Safely get the K8sApi bag */
function api(): any {
  return Renderer.K8sApi as any;
}

/**
 * Fetch the full list of a resource kind via KubeApi.list().
 * Returns raw JSON items array or null on failure.
 */
async function listViaApi(apiInstance: any, namespace?: string): Promise<any[] | null> {
  if (!apiInstance) return null;
  try {
    // KubeApi.list() returns a string (JSON text) or parsed object depending on version
    const result = await apiInstance.list({ namespace });
    // Some Freelens versions return the raw string, others the parsed list
    if (typeof result === "string") {
      const parsed = JSON.parse(result);
      return parsed?.items ?? parsed ?? null;
    }
    // Already an array of KubeObjects
    if (Array.isArray(result)) return result;
    // Or a list wrapper { items: [...] }
    if (result?.items && Array.isArray(result.items)) return result.items;
    return null;
  } catch (e: any) {
    console.warn("[K8s SRE] listViaApi failed:", e?.message ?? e);
    return null;
  }
}

/**
 * Fallback: get items from the in-memory store via apiManager.
 */
function getStoreItems(pluralKey: string): any[] | null {
  const a = api();
  if (!a?.apiManager) return null;

  const apiMap: Record<string, string> = {
    pods:        "podsApi",
    deployments: "deploymentApi",
    services:    "serviceApi",
    nodes:       "nodesApi",
    events:      "eventApi",
  };
  const apiName = apiMap[pluralKey];
  if (!apiName || !a[apiName]) return null;

  try {
    const store = a.apiManager.getStore(a[apiName]);
    if (store?.items?.length) return store.items;
  } catch { /* ignore */ }
  return null;
}

/**
 * Strip noisy labels from K8s objects for token-efficient AI context.
 * Keeps only short, meaningful labels; drops hashes, helm internals, etc.
 */
function cleanLabels(obj: any): Record<string, string> | undefined {
  const labels = obj?.metadata?.labels ?? obj?.labels;
  if (!labels || typeof labels !== "object") return undefined;

  // Label keys that are usually just noise for an AI summary
  const SKIP_KEYS = new Set([
    "pod-template-hash",
    "controller-revision-hash",
    "chart",
    "helm.sh/chart",
    "app.kubernetes.io/managed-by",
    "app.kubernetes.io/part-of",
  ]);

  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (typeof v !== "string") continue;
    if (v.length > 63) continue;          // overly long values
    if (SKIP_KEYS.has(k)) continue;       // known noise
    clean[k] = v;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/* ── Collection limits ── */
// No cap on pods/deployments/services — compressForPrompt() handles token budget.
// Only events are capped here; groupEventsByReason() further reduces them to ≤20 groups.
const MAX_EVENTS = 60;

/* ─── Pod log helpers ────────────────────────────────────────────────────── */

const LOG_SIGNAL_RE = /error|fatal|panic|exception|warn|failed|traceback|critical|oom|killed|segfault|abort|stack trace/i;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.,\d]*Z?\s*/;

/**
 * Compress raw log text: strip timestamps, deduplicate repeated lines,
 * keep only lines containing diagnostic signals, cap at 25 lines.
 */
export function compressLogs(raw: string): string {
  const lines = raw.split("\n").map((l) => l.replace(TIMESTAMP_RE, "").trim()).filter(Boolean);
  const seen = new Set<string>();
  const filtered: string[] = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    if (LOG_SIGNAL_RE.test(line)) {
      filtered.push(line);
      if (filtered.length >= 25) break;
    }
  }
  // If no signal lines found fall back to last 10 lines (the crash is likely at the end)
  if (filtered.length === 0) {
    return lines.slice(-10).join("\n");
  }
  return filtered.join("\n");
}

/**
 * Fetch the last N log lines from a terminated/crashing container.
 * Uses `previous=true` to read the crashed instance, not the restarting one.
 * Called ONLY after explicit user approval in the HiL flow.
 */
export async function fetchPodLogs(
  podsApi: any,
  name: string,
  namespace: string,
  container: string,
): Promise<string | null> {
  try {
    const logText = await podsApi.getLogs(
      { name, namespace },
      { container, tailLines: 30, previous: true },
    );
    if (typeof logText !== "string" || !logText.trim()) return null;
    return compressLogs(logText);
  } catch {
    // If `previous=true` fails (container never had a previous run), try current
    try {
      const logText = await podsApi.getLogs(
        { name, namespace },
        { container, tailLines: 30 },
      );
      if (typeof logText !== "string" || !logText.trim()) return null;
      return compressLogs(logText);
    } catch {
      return null;
    }
  }
}

/* ─── Relationship resolver ──────────────────────────────────────────────── */

/**
 * Render a probe spec into a compact string: "httpGet:/path:port" or "exec:cmd".
 */
function renderProbe(probe: any): string | undefined {
  if (!probe) return undefined;
  if (probe.httpGet) {
    const path = probe.httpGet.path ?? "/";
    const port = probe.httpGet.port ?? "";
    return `httpGet:${path}:${port}`;
  }
  if (probe.tcpSocket) return `tcpSocket:${probe.tcpSocket.port ?? ""}`;
  if (probe.exec?.command) return `exec:${probe.exec.command.join(" ").slice(0, 40)}`;
  return undefined;
}

/**
 * Resolve the full relationship graph for one anomalous pod.
 * Pure in-memory — all data comes from already-fetched API responses.
 * Never fetches Secret/ConfigMap values — only checks name existence.
 */
export function resolveRelations(
  rawPod: any,
  allDeployments: any[],
  allServices: any[],
  allIngresses: any[],
  allHpas: any[],
  allPvcs: any[],
  secretNames: Set<string>,
  configMapNames: Set<string>,
  /** The namespace currently being observed — used as fallback when metadata.namespace is absent. */
  contextNamespace?: string,
): PodRelations {
  const podNs: string =
    rawPod.getNs?.() ?? rawPod.metadata?.namespace ?? rawPod.namespace ?? contextNamespace ?? "default";
  const podMeta = rawPod.metadata ?? rawPod;
  const podLabels: Record<string, string> = podMeta.labels ?? rawPod.labels ?? {};

  const relations: PodRelations = {
    pvcs: [],
    missingRefs: [],
    presentRefs: [],
  };

  // ── 1. Owner controller ──
  const ownerRef = (podMeta.ownerReferences ?? [])[0];
  if (ownerRef) {
    let ownerKind: string = ownerRef.kind ?? "Unknown";
    let ownerName: string = ownerRef.name ?? "unknown";

    // ownerRef kind=ReplicaSet → walk up to the Deployment
    if (ownerKind === "ReplicaSet") {
      const dep = allDeployments.find((d) => {
        const dNs = d.getNs?.() ?? d.metadata?.namespace ?? d.namespace ?? "default";
        if (dNs !== podNs) return false;
        const selector: Record<string, string> = d.spec?.selector?.matchLabels ?? {};
        return Object.entries(selector).every(([k, v]) => podLabels[k] === v);
      });
      if (dep) {
        ownerKind = "Deployment";
        ownerName = dep.getName?.() ?? dep.metadata?.name ?? dep.name ?? ownerName;
        const ready = dep.status?.readyReplicas ?? 0;
        const desired = dep.spec?.replicas ?? 0;
        relations.ownerRef = {
          kind: ownerKind,
          name: ownerName,
          replicas: `${ready}/${desired}`,
          strategy: dep.spec?.strategy?.type,
        };
      }
    } else {
      // StatefulSet or DaemonSet — ownerRef points directly
      relations.ownerRef = { kind: ownerKind, name: ownerName };
    }
  } else {
    // No ownerRef — try deployment label selector matching directly
    const dep = allDeployments.find((d) => {
      const dNs = d.getNs?.() ?? d.metadata?.namespace ?? d.namespace ?? "default";
      if (dNs !== podNs) return false;
      const selector: Record<string, string> = d.spec?.selector?.matchLabels ?? {};
      if (Object.keys(selector).length === 0) return false;
      return Object.entries(selector).every(([k, v]) => podLabels[k] === v);
    });
    if (dep) {
      const ready = dep.status?.readyReplicas ?? 0;
      const desired = dep.spec?.replicas ?? 0;
      relations.ownerRef = {
        kind: "Deployment",
        name: dep.getName?.() ?? dep.metadata?.name ?? dep.name ?? "unknown",
        replicas: `${ready}/${desired}`,
        strategy: dep.spec?.strategy?.type,
      };
    }
  }

  // ── 2. Volumes → PVCs and ConfigMaps ──
  for (const vol of rawPod.spec?.volumes ?? []) {
    if (vol.persistentVolumeClaim?.claimName) {
      const claimName: string = vol.persistentVolumeClaim.claimName;
      const pvc = allPvcs.find(
        (p) =>
          (p.getName?.() ?? p.metadata?.name ?? p.name) === claimName &&
          (p.getNs?.() ?? p.metadata?.namespace ?? p.namespace ?? "default") === podNs,
      );
      relations.pvcs.push({ name: claimName, phase: pvc?.status?.phase ?? "Unknown" });
    }
    if (vol.configMap?.name) {
      const cmName: string = vol.configMap.name;
      if (configMapNames.has(`${podNs}/${cmName}`)) {
        relations.presentRefs.push({ kind: "ConfigMap", name: cmName, refType: "volume" });
      } else {
        relations.missingRefs.push({ kind: "ConfigMap", name: cmName, refType: "volume" });
      }
    }
  }

  // ── 3. Container env / envFrom refs ──
  for (const container of rawPod.spec?.containers ?? []) {
    for (const env of container.env ?? []) {
      if (env.valueFrom?.secretKeyRef?.name) {
        const sName: string = env.valueFrom.secretKeyRef.name;
        if (secretNames.has(`${podNs}/${sName}`)) {
          relations.presentRefs.push({ kind: "Secret", name: sName, refType: "env" });
        } else {
          relations.missingRefs.push({ kind: "Secret", name: sName, refType: "env" });
        }
      }
      if (env.valueFrom?.configMapKeyRef?.name) {
        const cmName: string = env.valueFrom.configMapKeyRef.name;
        if (configMapNames.has(`${podNs}/${cmName}`)) {
          relations.presentRefs.push({ kind: "ConfigMap", name: cmName, refType: "env" });
        } else {
          relations.missingRefs.push({ kind: "ConfigMap", name: cmName, refType: "env" });
        }
      }
    }
    for (const envFrom of container.envFrom ?? []) {
      if (envFrom.secretRef?.name) {
        const sName: string = envFrom.secretRef.name;
        if (secretNames.has(`${podNs}/${sName}`)) {
          relations.presentRefs.push({ kind: "Secret", name: sName, refType: "envFrom" });
        } else {
          relations.missingRefs.push({ kind: "Secret", name: sName, refType: "envFrom" });
        }
      }
      if (envFrom.configMapRef?.name) {
        const cmName: string = envFrom.configMapRef.name;
        if (configMapNames.has(`${podNs}/${cmName}`)) {
          relations.presentRefs.push({ kind: "ConfigMap", name: cmName, refType: "envFrom" });
        } else {
          relations.missingRefs.push({ kind: "ConfigMap", name: cmName, refType: "envFrom" });
        }
      }
    }
  }

  // ── 4. imagePullSecrets ──
  for (const ips of rawPod.spec?.imagePullSecrets ?? []) {
    if (ips.name) {
      const sName: string = ips.name;
      if (secretNames.has(`${podNs}/${sName}`)) {
        relations.presentRefs.push({ kind: "Secret", name: sName, refType: "imagePullSecret" });
      } else {
        relations.missingRefs.push({ kind: "Secret", name: sName, refType: "imagePullSecret" });
      }
    }
  }

  // ── 5. Service → pod endpoint matching ──
  const matchingServices = allServices.filter((svc) => {
    const svcNs = svc.getNs?.() ?? svc.metadata?.namespace ?? svc.namespace ?? "default";
    if (svcNs !== podNs) return false;
    const selector: Record<string, string> = svc.spec?.selector ?? {};
    if (Object.keys(selector).length === 0) return false;
    return Object.entries(selector).every(([k, v]) => podLabels[k] === v);
  });
  if (matchingServices.length > 0) {
    relations.serviceEndpoints = matchingServices.map((svc) => {
      const svcName = svc.getName?.() ?? svc.metadata?.name ?? svc.name ?? "unknown";
      // We don't fetch Endpoints here; report 0 as a conservative signal — the tool provides detail
      return { serviceName: svcName, endpointCount: 0 };
    });
  }

  // ── 6. Ingress → Service chain ──
  for (const ing of allIngresses) {
    const ingNs = ing.getNs?.() ?? ing.metadata?.namespace ?? ing.namespace ?? "default";
    const ingName = ing.getName?.() ?? ing.metadata?.name ?? ing.name ?? "unknown";
    if (ingNs !== podNs) continue;
    for (const rule of ing.spec?.rules ?? []) {
      for (const path of rule.http?.paths ?? []) {
        // networking.k8s.io/v1 format
        const svcName: string =
          path.backend?.service?.name ??
          path.backend?.serviceName ??  // extensions/v1beta1 format
          "";
        if (svcName && matchingServices.some((s) => (s.getName?.() ?? s.metadata?.name ?? s.name) === svcName)) {
          if (!relations.ingressChain) relations.ingressChain = [];
          relations.ingressChain.push({
            ingressName: ingName,
            serviceName: svcName,
          });
        }
      }
    }

    // TLS secrets
    for (const tls of ing.spec?.tls ?? []) {
      if (tls.secretName) {
        const sName: string = tls.secretName;
        if (!secretNames.has(`${podNs}/${sName}`)) {
          relations.missingRefs.push({ kind: "Secret", name: sName, refType: "ingressTLS" });
        }
      }
    }
  }

  // ── 7. HPA targeting the owner ──
  if (relations.ownerRef) {
    const hpa = allHpas.find((h) => {
      const hNs = h.getNs?.() ?? h.metadata?.namespace ?? h.namespace ?? "default";
      if (hNs !== podNs) return false;
      return (
        h.spec?.scaleTargetRef?.name === relations.ownerRef!.name &&
        h.spec?.scaleTargetRef?.kind === relations.ownerRef!.kind
      );
    });
    if (hpa) {
      const cpuMetric = (hpa.status?.currentMetrics ?? []).find(
        (m: any) => m.type === "Resource" && m.resource?.name === "cpu",
      );
      const cpuPercent = cpuMetric?.resource?.current?.averageUtilization;
      relations.hpa = {
        name: (hpa.metadata ?? hpa).name ?? "unknown",
        minReplicas: hpa.spec?.minReplicas ?? 1,
        maxReplicas: hpa.spec?.maxReplicas ?? 1,
        currentReplicas: hpa.status?.currentReplicas ?? 0,
        cpuPercent,
      };
    }
  }

  // ── 8. Helm release detection ──
  const labels: Record<string, string> = podMeta.labels ?? {};
  const annotations: Record<string, string> = podMeta.annotations ?? {};
  // Helm 3
  if (annotations["meta.helm.sh/release-name"]) {
    relations.helmRelease = annotations["meta.helm.sh/release-name"];
  // Helm 2
  } else if (labels["heritage"] === "Helm" && labels["release"]) {
    relations.helmRelease = labels["release"];
  }

  // Deduplicate refs by kind+name+refType
  relations.presentRefs = [...new Map(relations.presentRefs.map((r) => [`${r.kind}/${r.name}/${r.refType}`, r])).values()];
  relations.missingRefs = [...new Map(relations.missingRefs.map((r) => [`${r.kind}/${r.name}/${r.refType}`, r])).values()];

  return relations;
}

/* ── Anomaly-first sorting helpers ──
 * Place unhealthy resources before healthy ones so truncation preserves
 * the most actionable information for the AI.
 */

/** Pod statuses that indicate a problem, ordered by severity. */
const POD_SEVERITY: Record<string, number> = {
  "CrashLoopBackOff": 0,
  "Error": 1,
  "OOMKilled": 2,
  "ImagePullBackOff": 3,
  "ErrImagePull": 4,
  "CreateContainerConfigError": 5,
  "Init:Error": 6,
  "Init:CrashLoopBackOff": 7,
  "Pending": 8,
  "Terminating": 9,
  "Unknown": 10,
};
const HEALTHY_SEVERITY = 99;

function podSeverity(status: string): number {
  return POD_SEVERITY[status] ?? (status === "Running" ? HEALTHY_SEVERITY : 50);
}

function sortPodsByAnomaly(pods: any[]): any[] {
  return [...pods].sort((a, b) => {
    const sa = a.getStatusMessage?.() ?? a.status?.phase ?? "Unknown";
    const sb = b.getStatusMessage?.() ?? b.status?.phase ?? "Unknown";
    return podSeverity(sa) - podSeverity(sb);
  });
}

function sortDeploymentsByAnomaly(deps: any[]): any[] {
  return [...deps].sort((a, b) => {
    const readyA = a.status?.readyReplicas ?? 0;
    const desiredA = a.spec?.replicas ?? 0;
    const readyB = b.status?.readyReplicas ?? 0;
    const desiredB = b.spec?.replicas ?? 0;
    // Deployments with replica mismatch (unhealthy) sort first
    const mismatchA = desiredA > 0 && readyA < desiredA ? 0 : 1;
    const mismatchB = desiredB > 0 && readyB < desiredB ? 0 : 1;
    return mismatchA - mismatchB;
  });
}

function sortNodesByAnomaly(nodes: any[]): any[] {
  return [...nodes].sort((a, b) => {
    const sa = getNodeStatus(a);
    const sb = getNodeStatus(b);
    // NotReady before Ready
    if (sa !== "Ready" && sb === "Ready") return -1;
    if (sa === "Ready" && sb !== "Ready") return 1;
    return 0;
  });
}

/**
 * Module-level cache of raw resource lists populated by gatherContext().
 * Used by k8s-tools.ts execListResources() without requiring a ClusterContext parameter.
 */
export const rawResourceCache: {
  secrets:      any[] | null;
  configMaps:   any[] | null;
  ingresses:    any[] | null;
  pvcs:         any[] | null;
  statefulSets: any[] | null;
  daemonSets:   any[] | null;
  jobs:         any[] | null;
  cronJobs:     any[] | null;
  /** Raw deployment objects — used by on-the-fly relation resolution for healthy pods. */
  deployments:  any[] | null;
  /** Raw service objects — used by on-the-fly relation resolution for healthy pods. */
  services:     any[] | null;
  /** Raw HPA objects — used by on-the-fly relation resolution for healthy pods. */
  hpas:         any[] | null;
  /** Raw pod objects keyed by "namespace/name" — used by on-the-fly relation resolution. */
  pods:         Map<string, any>;
} = {
  secrets: null, configMaps: null, ingresses: null, pvcs: null,
  statefulSets: null, daemonSets: null, jobs: null, cronJobs: null,
  deployments: null, services: null, hpas: null, pods: new Map(),
};

export class K8sContextService {
  /**
   * Gather the current cluster context.
   *
   * @param filterNamespace  If set, only namespaced resources in this NS are
   *                         returned. Cluster-scoped resources (nodes) and the
   *                         namespace list are always fetched in full.
   *                         Pass `undefined` for all namespaces (with limits).
   */
  static async gatherContext(filterNamespace?: string): Promise<ClusterContext> {
    const context: ClusterContext = {
      clusterName: "Unknown",
      namespace: "default",
      namespaces: [],
      pods: [],
      deployments: [],
      services: [],
      nodes: [],
      events: [],
      gatheredAt: Date.now(),
    };

    const a = api();
    if (!a) {
      console.warn("[K8s SRE] Renderer.K8sApi not available");
      return context;
    }

    /* ── Cluster name ── */
    try {
      const cluster = Renderer.Catalog?.catalogEntities?.activeEntity;
      if (cluster) {
        context.clusterName = (cluster as any).metadata?.name || "Unknown";
      }
    } catch (e) {
      console.warn("[K8s SRE] Could not get cluster name:", e);
    }

    /* ── helper: filter by namespace if a filter is active ── */
    const nsFilter = (items: any[] | null): any[] | null => {
      if (!items || !filterNamespace) return items;
      return items.filter((item: any) => {
        const ns = item.getNs?.() ?? item.metadata?.namespace ?? item.namespace;
        return ns === filterNamespace;
      });
    };

    /* ── Fetch extra resource types in parallel (for relationship graph) ── */
    const [
      rawDeployments, rawServices, rawIngresses, rawHpas, rawPvcs,
      rawSecrets, rawConfigMaps, rawStatefulSets, rawDaemonSets, rawJobs, rawCronJobs,
    ] =
      await Promise.all([
        listViaApi(a.deploymentApi, filterNamespace),
        listViaApi(a.serviceApi, filterNamespace),
        listViaApi(a.ingressApi, filterNamespace),
        listViaApi(a.hpaApi, filterNamespace),
        listViaApi(a.pvcApi, filterNamespace),
        listViaApi(a.secretsApi, filterNamespace),   // secretsApi (plural) is the correct name
        listViaApi(a.configMapApi, filterNamespace),
        listViaApi(a.statefulSetApi, filterNamespace),
        listViaApi(a.daemonSetApi, filterNamespace),
        listViaApi(a.jobApi, filterNamespace),
        listViaApi(a.cronJobApi, filterNamespace),
      ]);

    // Update module-level cache so k8s-tools execListResources can access all raw lists
    rawResourceCache.secrets      = rawSecrets;
    rawResourceCache.configMaps   = rawConfigMaps;
    rawResourceCache.ingresses    = rawIngresses;
    rawResourceCache.pvcs         = rawPvcs;
    rawResourceCache.statefulSets = rawStatefulSets;
    rawResourceCache.daemonSets   = rawDaemonSets;
    rawResourceCache.jobs         = rawJobs;
    rawResourceCache.cronJobs     = rawCronJobs;
    rawResourceCache.deployments  = rawDeployments;
    rawResourceCache.services     = rawServices;
    rawResourceCache.hpas         = rawHpas;

    // Build lookup sets for Secret/ConfigMap existence checks (namespace/name keys).
    // KubeObjects expose namespace/name via getNs()/getName(); metadata fields may be
    // undefined on KubeObject instances, causing all keys to default to "default/..."
    // and producing false MISSING ⚠ reports for secrets/configmaps that actually exist.
    // When fetched with a namespace filter the API may also strip the namespace field
    // from returned items (it's implicit) — fall back to filterNamespace in that case.
    const nsDefault = filterNamespace ?? "default";
    const secretNames = new Set<string>(
      (rawSecrets ?? []).map((s: any) => {
        const ns = s.getNs?.() ?? s.metadata?.namespace ?? s.namespace ?? nsDefault;
        const name = s.getName?.() ?? s.metadata?.name ?? s.name ?? "";
        return `${ns}/${name}`;
      }),
    );
    const configMapNames = new Set<string>(
      (rawConfigMaps ?? []).map((c: any) => {
        const ns = c.getNs?.() ?? c.metadata?.namespace ?? c.namespace ?? nsDefault;
        const name = c.getName?.() ?? c.metadata?.name ?? c.name ?? "";
        return `${ns}/${name}`;
      }),
    );

    /* ── Pods ── */
    try {
      let pods = await listViaApi(a.podsApi, filterNamespace);
      if (!pods?.length) {
        pods = nsFilter(getStoreItems("pods"));
        if (pods?.length) console.log("[K8s SRE] Pods: fell back to store");
      }
      if (pods?.length) {
        console.log("[K8s SRE] Pods: total", pods.length, filterNamespace ? `(ns=${filterNamespace})` : "(all)");
        // Cache raw pods keyed by "namespace/name" for on-the-fly relation resolution
        rawResourceCache.pods.clear();
        for (const pod of pods) {
          const podNs  = pod.getNs?.()   ?? pod.metadata?.namespace ?? filterNamespace ?? "default";
          const podNm  = pod.getName?.() ?? pod.metadata?.name      ?? "unknown";
          rawResourceCache.pods.set(`${podNs}/${podNm}`, pod);
        }
        context.pods = sortPodsByAnomaly(pods).map((pod: any) => {
          const meta = pod.metadata ?? pod;
          const status: string = pod.getStatusMessage?.() ?? pod.status?.phase ?? "Unknown";
          const isAnomaly =
            status !== "Running" && status !== "Completed" && status !== "Succeeded";

          const summary: import("../../common/types").K8sResourceSummary = {
            name: pod.getName?.() ?? meta.name ?? "unknown",
            namespace: pod.getNs?.() ?? meta.namespace ?? "default",
            status,
            ready: getReadyCount(pod),
            labels: cleanLabels(pod),
          };

          // Always extract container names (healthy pods included) so the model
          // always knows exact container names — e.g. when calling get_pod_logs.
          const containers = extractContainerSummaries(pod);
          if (containers.length > 0) summary.containers = containers;

          if (isAnomaly) {
            // Richer field extraction for anomalous pods only
            summary.node = pod.spec?.nodeName ?? undefined;

            // Attach image, resources, probes, pullPolicy to each container
            const specContainers: any[] = pod.spec?.containers ?? [];
            if (summary.containers && specContainers.length > 0) {
              const specMap = new Map<string, any>();
              for (const sc of specContainers) {
                if (sc.name) specMap.set(sc.name as string, sc);
              }
              for (const c of summary.containers) {
                const spec = specMap.get(c.name);
                if (!spec) continue;
                c.image = spec.image ?? undefined;
                c.imagePullPolicy = spec.imagePullPolicy ?? undefined;
                const req = spec.resources?.requests;
                const lim = spec.resources?.limits;
                if (req || lim) {
                  c.resources = {
                    reqCpu: req?.cpu,
                    reqMem: req?.memory,
                    limCpu: lim?.cpu,
                    limMem: lim?.memory,
                  };
                }
                const liveness = renderProbe(spec.livenessProbe);
                const readiness = renderProbe(spec.readinessProbe);
                if (liveness || readiness) {
                  c.probes = { liveness, readiness };
                }
              }
            }

            // Resolve relationship graph
            summary.relations = resolveRelations(
              pod,
              rawDeployments ?? [],
              rawServices ?? [],
              rawIngresses ?? [],
              rawHpas ?? [],
              rawPvcs ?? [],
              secretNames,
              configMapNames,
              filterNamespace,
            );
          }

          return summary;
        });
      } else {
        console.warn("[K8s SRE] Pods: none found");
      }
    } catch (e) {
      console.warn("[K8s SRE] Could not get pods:", e);
    }

    /* ── Deployments ── */
    try {
      const deps = rawDeployments?.length
        ? rawDeployments
        : nsFilter(getStoreItems("deployments")) ?? [];
      if (deps.length) {
        console.log("[K8s SRE] Deployments: total", deps.length, filterNamespace ? `(ns=${filterNamespace})` : "(all)");
        context.deployments = sortDeploymentsByAnomaly(deps).map((dep: any) => {
          const meta = dep.metadata ?? dep;
          return {
            name: dep.getName?.() ?? meta.name ?? "unknown",
            namespace: dep.getNs?.() ?? meta.namespace ?? "default",
            replicas: `${dep.status?.readyReplicas ?? 0}/${dep.spec?.replicas ?? 0}`,
            labels: cleanLabels(dep),
          };
        });
      } else {
        console.warn("[K8s SRE] Deployments: none found");
      }
    } catch (e) {
      console.warn("[K8s SRE] Could not get deployments:", e);
    }

    /* ── Services ── */
    try {
      const svcs = rawServices?.length
        ? rawServices
        : nsFilter(getStoreItems("services")) ?? [];
      if (svcs.length) {
        console.log("[K8s SRE] Services: total", svcs.length, filterNamespace ? `(ns=${filterNamespace})` : "(all)");
        context.services = svcs.map((svc: any) => {
          const meta = svc.metadata ?? svc;
          return {
            name: svc.getName?.() ?? meta.name ?? "unknown",
            namespace: svc.getNs?.() ?? meta.namespace ?? "default",
            status: svc.spec?.type ?? "ClusterIP",
            labels: cleanLabels(svc),
          };
        });
      } else {
        console.warn("[K8s SRE] Services: none found");
      }
    } catch (e) {
      console.warn("[K8s SRE] Could not get services:", e);
    }

    /* ── Nodes (always cluster-scoped, no namespace filter) ── */
    try {
      let nodes = await listViaApi(a.nodesApi);
      if (!nodes?.length) {
        nodes = getStoreItems("nodes");
        if (nodes?.length) console.log("[K8s SRE] Nodes: fell back to store");
      }
      if (nodes?.length) {
        console.log("[K8s SRE] Nodes: total", nodes.length);
        // Sort NotReady nodes first
        context.nodes = sortNodesByAnomaly(nodes).map((node: any) => {
          const meta = node.metadata ?? node;
          return {
            name: node.getName?.() ?? meta.name ?? "unknown",
            status: getNodeStatus(node),
            labels: cleanLabels(node),
          };
        });
      } else {
        console.warn("[K8s SRE] Nodes: none found");
      }
    } catch (e) {
      console.warn("[K8s SRE] Could not get nodes:", e);
    }

    /* ── Events (filtered by namespace if applicable) ── */
    try {
      let evts = await listViaApi(a.eventApi, filterNamespace);
      if (!evts?.length) {
        evts = nsFilter(getStoreItems("events"));
        if (evts?.length) console.log("[K8s SRE] Events: fell back to store");
      }
      if (evts?.length) {
        console.log("[K8s SRE] Events: total", evts.length, filterNamespace ? `(ns=${filterNamespace})` : "(all)");
        const sorted = [...evts]
          .sort((x: any, y: any) => {
            const ta = new Date((x.metadata ?? x).creationTimestamp || 0).getTime();
            const tb = new Date((y.metadata ?? y).creationTimestamp || 0).getTime();
            return tb - ta;
          })
          .slice(0, MAX_EVENTS);

        context.events = sorted.map((evt: any) => ({
          type: evt.type ?? "Normal",
          reason: evt.reason ?? "Unknown",
          message: (evt.message ?? "").slice(0, 200),  // truncate long event messages
          involvedObject: `${evt.involvedObject?.kind ?? "?"}/${evt.involvedObject?.name ?? "?"}`,
          age: (evt.metadata ?? evt).creationTimestamp,
          namespace: evt.involvedObject?.namespace ?? (evt.metadata ?? evt).namespace,
        }));
      } else {
        console.warn("[K8s SRE] Events: none found");
      }
    } catch (e) {
      console.warn("[K8s SRE] Could not get events:", e);
    }

    /* ── Namespaces (always full list, regardless of filter) ── */
    try {
      const nsList = await listViaApi(a.namespacesApi);
      if (nsList?.length) {
        console.log("[K8s SRE] Namespaces: total", nsList.length);
        context.namespaces = nsList.map((ns: any) => {
          const meta = ns.metadata ?? ns;
          return meta.name ?? "unknown";
        }).sort();
        context.namespace = filterNamespace
          ? filterNamespace
          : `all (${nsList.length} namespaces)`;
      }
    } catch { /* ignore */ }

    console.log(
      "[K8s SRE] Context gathered →",
      `cluster=${context.clusterName}`,
      `pods=${context.pods.length}`,
      `deployments=${context.deployments.length}`,
      `services=${context.services.length}`,
      `nodes=${context.nodes.length}`,
      `events=${context.events.length}`,
    );

    return context;
  }
}

function getReadyCount(pod: any): string {
  try {
    const containers = pod.status?.containerStatuses ?? [];
    const ready = containers.filter((c: any) => c.ready).length;
    return `${ready}/${containers.length}`;
  } catch {
    return "?/?";
  }
}

function getNodeStatus(node: any): string {
  try {
    const conditions = node.status?.conditions ?? [];
    const readyCondition = conditions.find((c: any) => c.type === "Ready");
    return readyCondition?.status === "True" ? "Ready" : "NotReady";
  } catch {
    return "Unknown";
  }
}
