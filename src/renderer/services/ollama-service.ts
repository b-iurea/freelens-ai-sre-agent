/**
 * Copyright (c) 2026 Freelens K8s SRE Assistant Authors.
 * Licensed under MIT License.
 *
 * Ollama AI Service - handles communication with the Ollama API
 *
 * Uses Node.js http/https modules instead of browser fetch/XHR to avoid
 * mixed-content blocking when connecting to remote Ollama instances over
 * plain HTTP from the Electron renderer (preload) process.
 */

import http from "http";
import https from "https";
import type {
  ApiMessage,
  ChatMessage,
  CompressedClusterContext,
  OllamaChatRequest,
  OllamaModelInfo,
  OllamaModelParams,
  OllamaPerformanceStats,
  OllamaStreamChunk,
  OllamaTool,
  OllamaToolCall,
} from "../../common/types";

const DEFAULT_ENDPOINT = "http://localhost:11434";
const DEFAULT_MODEL = "llama3.2";

/* ──────────────────────────────────────────────────────────
 *  Node.js HTTP helpers – bypass browser mixed-content rules
 * ────────────────────────────────────────────────────────── */

/** Simple request → full body */
function nodeRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; timeout?: number } = {},
): Promise<{ status: number; ok: boolean; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: opts.method || "GET",
        headers: opts.headers || {},
        timeout: opts.timeout || 30_000,
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => { data += c.toString(); });
        res.on("end", () => {
          const s = res.statusCode || 0;
          resolve({ status: s, ok: s >= 200 && s < 300, body: data });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** Streaming request → returns an async generator of raw string chunks */
function nodeStreamRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; timeout?: number },
): { response: Promise<{ status: number; ok: boolean; stream: AsyncGenerator<string, void, unknown> }>; abort: () => void } {
  let req: http.ClientRequest;
  const response = new Promise<{ status: number; ok: boolean; stream: AsyncGenerator<string, void, unknown> }>((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;

    req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: opts.method || "POST",
        headers: opts.headers || {},
        timeout: opts.timeout || 300_000,
      },
      (res) => {
        const status = res.statusCode || 0;
        const ok = status >= 200 && status < 300;
        if (!ok) {
          let body = "";
          res.on("data", (c: Buffer) => { body += c.toString(); });
          res.on("end", () => reject(new Error(`Ollama API error: HTTP ${status} - ${body}`)));
          return;
        }
        async function* chunks(): AsyncGenerator<string, void, unknown> {
          const buf: string[] = [];
          let pending: (() => void) | null = null;
          let done = false;
          let err: Error | null = null;
          res.on("data", (c: Buffer) => { buf.push(c.toString()); pending?.(); pending = null; });
          res.on("end", () => { done = true; pending?.(); pending = null; });
          res.on("error", (e) => { err = e; done = true; pending?.(); pending = null; });
          while (true) {
            if (buf.length) { yield buf.shift()!; }
            else if (done) { if (err) throw err; return; }
            else { await new Promise<void>((r) => { pending = r; }); }
          }
        }
        resolve({ status, ok, stream: chunks() });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
  return { response, abort: () => { if (req) req.destroy(); } };
}

/**
 * Exported helper for the ConnectionPanel in sre-chat.tsx to test Ollama
 * connectivity using Node.js HTTP (no mixed-content issues).
 */
export async function nodeRequestJson(
  url: string,
  timeout = 5000,
): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await nodeRequest(url, { method: "GET", timeout });
  return { ok: res.ok, status: res.status, data: res.ok ? JSON.parse(res.body) : null };
}

/* ─── Anomalous pod renderer ─────────────────────────────────────────────── */

/**
 * Render a single anomalous pod as a cause-chain block for the system prompt.
 * Format matches the IMPROVEMENTS.md target layout:
 *   [ns] pod-name  STATUS  ready=N/M
 *     → owner:     Deployment/name  replicas=X/Y ⚠
 *     → image:     registry/image:tag  (pullPolicy=Always)
 *     → resources: req=cpu:X,mem:Y  lim=cpu:X,mem:Y
 *     → probes:    readiness=httpGet:/ready:8080
 *     → volumes:   pvc/name [Bound ✓]  configmap/name [MISSING ⚠]
 *     → hpa:       name  min=N max=M  current=K (CPU: X% ⚠)
 *     → service:   name → 0 endpoints ⚠
 *     → ingress:   name → service
 *     → helm:      release-name
 */
function renderAnomalousPod(p: import("../../common/types").K8sResourceSummary): string {
  let out = `  [${p.namespace ?? "?"}] ${p.name}  ${p.status ?? "?"}  ready=${p.ready ?? "?"}`;
  if (p.node) out += `  node=${p.node}`;
  out += "\n";

  // Containers
  if (p.containers && p.containers.length > 0) {
    for (const c of p.containers) {
      const kind = c.isMain ? "main" : "sidecar";
      const r = c.restarts != null ? ` · restarts=${c.restarts}` : "";
      const e = c.exitCode != null ? ` · exit=${c.exitCode}` : "";
      const reason = c.reason ? ` · ${c.reason}` : "";
      out += `    ↳ ${c.name} (${kind})  ${c.state}${r}${e}${reason}\n`;
      if (c.image) {
        const pull = c.imagePullPolicy && c.imagePullPolicy !== "IfNotPresent" ? `  pullPolicy=${c.imagePullPolicy}` : "";
        out += `       image: ${c.image}${pull}\n`;
      }
      if (c.resources) {
        const { reqCpu, reqMem, limCpu, limMem } = c.resources;
        const req = [reqCpu && `cpu:${reqCpu}`, reqMem && `mem:${reqMem}`].filter(Boolean).join(",");
        const lim = [limCpu && `cpu:${limCpu}`, limMem && `mem:${limMem}`].filter(Boolean).join(",");
        if (req || lim) out += `       resources: req=${req || "?"} lim=${lim || "?"}\n`;
      }
      if (c.probes) {
        const parts = [
          c.probes.liveness && `liveness=${c.probes.liveness}`,
          c.probes.readiness && `readiness=${c.probes.readiness}`,
        ].filter(Boolean).join(" ");
        if (parts) out += `       probes: ${parts}\n`;
      }
    }
  }

  const rel = p.relations;
  if (!rel) return out;

  // Owner
  if (rel.ownerRef) {
    const r = rel.ownerRef;
    const [ready, desired] = (r.replicas ?? "1/1").split("/").map(Number);
    const flag = Number.isFinite(ready) && Number.isFinite(desired) && desired > 0 && ready < desired ? " ⚠" : "";
    const repPart = r.replicas ? `  replicas=${r.replicas}${flag}` : "";
    const stratPart = r.strategy ? `  strategy=${r.strategy}` : "";
    out += `    → owner:     ${r.kind}/${r.name}${repPart}${stratPart}\n`;
  }

  // Volumes (PVCs + configmap/secret volume refs)
  const volParts: string[] = [];
  for (const pvc of rel.pvcs) {
    const flag = pvc.phase !== "Bound" ? " ⚠" : " ✓";
    volParts.push(`pvc/${pvc.name} [${pvc.phase}${flag}]`);
  }
  for (const ref of rel.presentRefs.filter((r) => r.refType === "volume")) {
    volParts.push(`${ref.kind.toLowerCase()}/${ref.name} [Present ✓]`);
  }
  for (const ref of rel.missingRefs.filter((r) => r.refType === "volume")) {
    volParts.push(`${ref.kind.toLowerCase()}/${ref.name} [MISSING ⚠]`);
  }
  if (volParts.length > 0) {
    out += `    → volumes:   ${volParts.join("  ")}\n`;
  }

  // Present env/envFrom/imagePullSecret refs — Secrets and ConfigMaps that exist
  const envPresent = rel.presentRefs.filter((r) => r.refType !== "volume");
  if (envPresent.length > 0) {
    const grouped = new Map<string, string[]>();
    for (const r of envPresent) {
      if (!grouped.has(r.kind)) grouped.set(r.kind, []);
      grouped.get(r.kind)!.push(r.name);
    }
    for (const [kind, names] of grouped) {
      out += `    → ${kind.toLowerCase()}s: ${names.join("  ")} ✓\n`;
    }
  }

  // Missing env/envFrom/imagePullSecret refs
  const envMissing = rel.missingRefs.filter((r) => r.refType !== "volume" && r.refType !== "ingressTLS");
  if (envMissing.length > 0) {
    for (const r of envMissing) {
      out += `    → MISSING ${r.kind}: ${r.name}  [${r.refType}] ⚠\n`;
    }
  }

  // HPA
  if (rel.hpa) {
    const h = rel.hpa;
    const cpuPart = h.cpuPercent != null ? `  CPU:${h.cpuPercent}%${h.cpuPercent >= 80 ? " ⚠" : ""}` : "";
    out += `    → hpa:       ${h.name}  min=${h.minReplicas} max=${h.maxReplicas} current=${h.currentReplicas}${cpuPart}\n`;
  }

  // Services
  if (rel.serviceEndpoints && rel.serviceEndpoints.length > 0) {
    for (const s of rel.serviceEndpoints) {
      out += `    → service:   ${s.serviceName} ✓ (selector matches pod)\n`;
    }
  }

  // Ingress
  if (rel.ingressChain && rel.ingressChain.length > 0) {
    for (const i of rel.ingressChain) {
      out += `    → ingress:   ${i.ingressName} → ${i.serviceName}\n`;
    }
  }

  // Helm
  if (rel.helmRelease) {
    out += `    → helm:      ${rel.helmRelease}\n`;
  }

  return out;
}

export class OllamaService {
  private endpoint: string;
  private model: string;
  private abortController: AbortController | null = null;
  private currentAbort: (() => void) | null = null;

  /** Performance stats from the last completed stream. */
  lastStats: OllamaPerformanceStats | null = null;

  /**
   * Sanitise model params before sending to Ollama.
   * Cloud Ollama instances reject `num_predict: -1` (must be positive).
   * Removes invalid or default-equivalent values to avoid API errors.
   */
  private static sanitiseOptions(params?: OllamaModelParams): Partial<OllamaModelParams> | undefined {
    if (!params) return undefined;
    const opts: Partial<OllamaModelParams> = { ...params };
    // Cloud Ollama rejects num_predict <= 0; omit it to let the server use its default
    if (opts.num_predict != null && opts.num_predict <= 0) {
      delete opts.num_predict;
    }
    return Object.keys(opts).length > 0 ? opts : undefined;
  }

  constructor(endpoint?: string, model?: string) {
    this.endpoint = endpoint || DEFAULT_ENDPOINT;
    this.model = model || DEFAULT_MODEL;
  }

  setEndpoint(endpoint: string) {
    this.endpoint = endpoint;
  }

  setModel(model: string) {
    this.model = model;
  }

  getEndpoint(): string {
    return this.endpoint;
  }

  getModel(): string {
    return this.model;
  }

  /** Parse performance stats from the final Ollama streaming chunk. */
  private parseStats(chunk: OllamaStreamChunk): OllamaPerformanceStats | null {
    if (!chunk.done) return null;
    const ns = 1_000_000; // nanoseconds → milliseconds
    const totalMs = (chunk.total_duration || 0) / ns;
    const promptMs = (chunk.prompt_eval_duration || 0) / ns;
    const genMs = (chunk.eval_duration || 0) / ns;
    const promptTokens = chunk.prompt_eval_count || 0;
    const genTokens = chunk.eval_count || 0;
    return {
      model: chunk.model || this.model,
      totalDurationMs: Math.round(totalMs),
      promptTokens,
      promptEvalMs: Math.round(promptMs),
      promptTokensPerSec: promptMs > 0 ? Math.round((promptTokens / promptMs) * 1000) : 0,
      generatedTokens: genTokens,
      generationMs: Math.round(genMs),
      tokensPerSec: genMs > 0 ? parseFloat(((genTokens / genMs) * 1000).toFixed(1)) : 0,
      loadMs: Math.round((chunk.load_duration || 0) / ns),
      timestamp: Date.now(),
    };
  }

  /**
   * Check if Ollama is reachable (uses Node.js http — no mixed-content issues)
   */
  async isAvailable(): Promise<boolean> {
    const url = `${this.endpoint}/api/tags`;
    console.log("[K8s SRE] Testing connection to:", url);
    try {
      const res = await nodeRequest(url, { method: "GET", timeout: 5000 });
      console.log("[K8s SRE] Connection response status:", res.status);
      return res.ok;
    } catch (err) {
      console.warn("[K8s SRE] Connection failed:", err);
      return false;
    }
  }

  /**
   * List available models (uses Node.js http — no mixed-content issues)
   */
  async listModels(): Promise<OllamaModelInfo[]> {
    const url = `${this.endpoint}/api/tags`;
    console.log("[K8s SRE] Fetching models from:", url);
    try {
      const res = await nodeRequest(url, { method: "GET", timeout: 10000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = JSON.parse(res.body);
      console.log("[K8s SRE] Models response:", JSON.stringify(data?.models?.map((m: any) => m.name)));
      return data?.models || [];
    } catch (error) {
      console.error("[K8s SRE] Failed to list models:", error);
      return [];
    }
  }

  /**
   * Build system prompt with Kubernetes cluster context.
   * Optimised for small models: concise, structured, low token count.
   * When clusterContext carries totalXxx fields, the context was filtered
   * by ClusterMemoryService and we annotate with "(N of M, query-relevant)".
   */
  buildSystemPrompt(ctx?: CompressedClusterContext, toolsEnabled = false): string {
    let prompt = `You are an expert Kubernetes SRE assistant embedded in Freelens (a K8s IDE).

ROLE: Senior SRE with deep expertise in troubleshooting, monitoring, security, performance, and reliability of Kubernetes clusters.

RULES:
- Use Markdown.
- For problems: give Root Cause → Immediate Fix → Long-term Prevention.
- **ALWAYS read the full LIVE CLUSTER CONTEXT section first. Exhaust what is already there before considering any other action (including tool calls).**
- NEVER provide kubectl commands, YAML manifests, or shell scripts unless the user EXPLICITLY asks for them.
- Prefix any mutating action recommendation with ⚠️ RISK: low|medium|high.
- ONLY state facts that are present in the LIVE CLUSTER CONTEXT or returned by a tool. NEVER fabricate pod names, log lines, kubectl output, metrics, or any other data. If the data is not available, say so.
- For relationship or dependency diagrams you may use mermaid code blocks. For tabular data always use Markdown tables, not mermaid.
`;
    if (toolsEnabled) {
      prompt += `- You have tool-calling capabilities. The Freelens runtime will execute them. Do NOT write tool names or fake tool output in your response text. Simply call the tool via the API — Freelens handles the rest.
- TOOL-CALL PROTOCOL — MANDATORY, follow every step in order:
  1. READ the full LIVE CLUSTER CONTEXT section below BEFORE considering any tool.
  2. Check whether the answer (or the data needed to answer) is already present in that context.
  3. Only if the required data is ABSENT from the context may you call a tool.
  4. NEVER call a tool for a resource whose details are already listed in the context.
  5. NEVER fan-out: do NOT issue separate tool calls for each item in a list you already have. If you need extra data for multiple resources, call the tool ONCE with the most critical one, then ask the user whether to continue.
  6. If you are unsure whether context is sufficient, answer from context first and offer to fetch more details.
- \`get_pod_logs\` requires user approval. Before calling it, explain: (1) what you already found in the context, (2) what you expect the logs to confirm. Design your analysis to be useful even if the user denies.
`;
    } else {
      prompt += `- You do NOT have any tools available. Do NOT pretend to call tools, do NOT output lines like "[Tool: ...]", do NOT fabricate tool results. Answer only from the LIVE CLUSTER CONTEXT provided.
`;
    }

    if (!ctx) {
      prompt += `\n(No cluster context available yet.)\n`;
      return prompt;
    }

    const scopeLine = ctx.viewMode === "all-namespaces"
      ? "Scope: all namespaces"
      : `Namespace: ${ctx.namespace ?? "default"}`;

    prompt += `\n--- LIVE CLUSTER CONTEXT ---\n`;
    prompt += `Cluster: ${ctx.clusterName} | ${scopeLine}\n`;
    if (ctx.gatheredAt) {
      const ageMs = Date.now() - ctx.gatheredAt;
      const ageStr = ageMs < 60_000 ? `${Math.round(ageMs / 1000)}s` : `${Math.round(ageMs / 60_000)}m`;
      prompt += `⚡ Context: live · gathered ${ageStr} ago\n`;
    }

    // Summary counts header
    if (ctx.viewMode === "all-namespaces") {
      const anom = ctx.anomalyPods?.length ?? 0;
      prompt += `Pods: ${ctx.totalPods ?? 0} total`;
      if (anom > 0) prompt += ` (${anom} anomalous ⚠)`;
      prompt += ` · Deployments: ${ctx.totalDeployments ?? 0} · Services: ${ctx.totalServices ?? 0}\n`;
    } else {
      prompt += `Pods: ${ctx.pods?.length ?? 0} · Deployments: ${ctx.deployments?.length ?? 0} · Services: ${ctx.services?.length ?? 0}\n`;
    }

    // Nodes (always full — cluster-scoped)
    if (ctx.nodes.length > 0) {
      prompt += `\nNODES (${ctx.nodes.length}):\n`;
      for (const n of ctx.nodes) {
        const flag = (n.status ?? "") !== "Ready" ? " ⚠" : "";
        prompt += `  ${n.name} [${n.status ?? "?"}]${flag}\n`;
      }
    }

    if (ctx.viewMode === "all-namespaces") {
      // Namespace digest table — one line per namespace
      if (ctx.namespaceDigests && ctx.namespaceDigests.length > 0) {
        prompt += `\nNAMESPACE OVERVIEW (${ctx.namespaceDigests.length}):\n`;
        for (const d of ctx.namespaceDigests) {
          const podParts = Object.entries(d.podCounts)
            .sort(([a], [b]) => (a === "Running" ? -1 : b === "Running" ? 1 : a.localeCompare(b)))
            .map(([s, c]) => `${c} ${s}`)
            .join(" · ");
          const depPart = d.totalDeployments > 0
            ? `  ${d.totalDeployments} deps${d.degradedDeployments > 0 ? ` (${d.degradedDeployments} degraded ⚠)` : ""}`
            : "";
          const svcPart = d.totalServices > 0 ? `  ${d.totalServices} svc` : "";
          const warnPart = d.warningCount > 0 ? `  ${d.warningCount} warnings ⚠` : "";
          prompt += `  ${d.name}: ${podParts || "0 pods"}${depPart}${svcPart}${warnPart}\n`;
        }
      }

      // Compact pod roster — healthy pods (anomalous ones get the full format below)
      if (ctx.pods && ctx.pods.length > 0) {
        const anomalySet = new Set((ctx.anomalyPods ?? []).map((p) => `${p.namespace}/${p.name}`));
        const healthyPods = ctx.pods.filter((p) => !anomalySet.has(`${p.namespace}/${p.name}`));
        if (healthyPods.length > 0) {
          prompt += `\nPODS (${healthyPods.length} healthy):\n`;
          for (const p of healthyPods) {
            prompt += `  [${p.namespace ?? "?"}] ${p.name}  ${p.status ?? "?"}  ready=${p.ready ?? "?"}\n`;
          }
        }
      }

      // Anomalous pods with container detail + relationship chain
      if (ctx.anomalyPods && ctx.anomalyPods.length > 0) {
        prompt += `\nANOMALOUS PODS (${ctx.anomalyPods.length}):\n`;
        for (const p of ctx.anomalyPods) {
          prompt += renderAnomalousPod(p);
        }
      }

      // Degraded deployments
      if (ctx.anomalyDeployments && ctx.anomalyDeployments.length > 0) {
        prompt += `\nDEGRADED DEPLOYMENTS (${ctx.anomalyDeployments.length}):\n`;
        for (const d of ctx.anomalyDeployments) {
          prompt += `  [${d.namespace ?? "?"}] ${d.name}  replicas=${d.replicas ?? "?"}\n`;
        }
      }
    } else {
      // All pods — anomalous ones get the full chain format
      if (ctx.pods && ctx.pods.length > 0) {
        prompt += `\nPODS (${ctx.pods.length}):\n`;
        for (const p of ctx.pods) {
          const isAnomaly =
            (p.status ?? "") !== "Running" &&
            (p.status ?? "") !== "Completed" &&
            (p.status ?? "") !== "Succeeded" &&
            (p.status ?? "") !== "";
          if (isAnomaly) {
            prompt += renderAnomalousPod(p);
          } else {
            prompt += `  ${p.name}  ${p.status ?? "?"}  ready=${p.ready ?? "?"}\n`;
          }
        }
      }

      // All deployments
      if (ctx.deployments && ctx.deployments.length > 0) {
        prompt += `\nDEPLOYMENTS (${ctx.deployments.length}):\n`;
        for (const d of ctx.deployments) {
          const [ready, desired] = (d.replicas ?? "0/0").split("/").map(Number);
          const isAnomaly =
            Number.isFinite(ready) && Number.isFinite(desired) && desired > 0 && ready < desired;
          const flag = isAnomaly ? " ⚠" : "";
          prompt += `  ${d.name}  replicas=${d.replicas ?? "?"}${flag}\n`;
        }
      }

      // All services — omit type when it is the default ClusterIP
      if (ctx.services && ctx.services.length > 0) {
        prompt += `\nSERVICES (${ctx.services.length}):\n`;
        for (const s of ctx.services) {
          const t = s.status ?? "ClusterIP";
          const typePart = t !== "ClusterIP" ? `  type=${t}` : "";
          prompt += `  ${s.name}${typePart}\n`;
        }
      }
    }

    // Warning events (grouped, both modes)
    if (ctx.groupedWarnings.length > 0) {
      prompt += `\nWARNING EVENTS (${ctx.groupedWarnings.length} groups):\n`;
      for (const e of ctx.groupedWarnings) {
        const countPart = (e.count ?? 1) > 1 ? ` ×${e.count}` : "";
        const agePart = e.lastSeen ? ` | ${e.lastSeen} ago` : "";
        prompt += `  [${e.reason}${countPart}${agePart}] ${e.involvedObject}: ${e.message}\n`;
      }
    }

    prompt += `--- END CLUSTER CONTEXT ---\n`;
    return prompt;
  }

  /**
   * Low-level non-streaming completion — used by SummaryManager to compress
   * conversation history.  Returns the model's text response.
   */
  async generateText(prompt: string): Promise<string> {
    const request: OllamaChatRequest = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      options: { temperature: 0.3, top_p: 0.9, top_k: 40, num_predict: 512, repeat_penalty: 1.0 },
    };

    console.log("[K8s SRE] generateText (summary) →", `model=${this.model}`, `prompt=${prompt.length} chars`);

    const res = await nodeRequest(`${this.endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      timeout: 60_000,
    });

    if (!res.ok) throw new Error(`Ollama API error: HTTP ${res.status}`);
    const data = JSON.parse(res.body);
    return data.message?.content || "";
  }

  /**
   * Send a chat message and stream the response (uses Node.js http — no mixed-content issues)
   *
   * Accepts either the legacy (messages + clusterContext) signature or
   * a pre-assembled message array from ContextBuilder.
   */
  async *streamChat(
    messages: ChatMessage[],
    clusterContext?: CompressedClusterContext,
    modelParams?: OllamaModelParams,
  ): AsyncGenerator<string, void, unknown> {
    this.abortController = new AbortController();

    const systemPrompt = this.buildSystemPrompt(clusterContext);

    const apiMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    ];

    const options = OllamaService.sanitiseOptions(modelParams);

    const request: OllamaChatRequest = {
      model: this.model,
      messages: apiMessages,
      stream: true,
      ...(options ? { options } : {}),
    };

    console.log("[K8s SRE] streamChat request →", JSON.stringify({
      model: request.model,
      options: request.options,
      messagesCount: request.messages.length,
      systemPromptLength: systemPrompt.length,
      hasClusterContext: !!clusterContext,
      viewMode: clusterContext?.viewMode ?? "none",
    }));

    const body = JSON.stringify(request);
    const { response, abort } = nodeStreamRequest(`${this.endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      timeout: 300_000,
    });

    this.currentAbort = abort;

    try {
      const { stream } = await response;

      let buffer = "";

      for await (const rawChunk of stream) {
        buffer += rawChunk;

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk: OllamaStreamChunk = JSON.parse(line);
            if (chunk.message?.content) {
              yield chunk.message.content;
            }
            if (chunk.done) return;
          } catch {
            // skip malformed JSON lines
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const chunk: OllamaStreamChunk = JSON.parse(buffer);
          if (chunk.message?.content) {
            yield chunk.message.content;
          }
        } catch {
          // ignore
        }
      }
    } catch (error: any) {
      if (error.name === "AbortError" || error.message?.includes("aborted") || error.message?.includes("destroyed")) {
        yield "\n\n*[Response interrupted]*";
        return;
      }
      throw error;
    } finally {
      this.abortController = null;
      this.currentAbort = null;
    }
  }

  /**
   * Send a chat message and get the full response at once (uses Node.js http — no mixed-content issues)
   */
  async chat(
    messages: ChatMessage[],
    clusterContext?: CompressedClusterContext,
    modelParams?: OllamaModelParams,
  ): Promise<string> {
    const systemPrompt = this.buildSystemPrompt(clusterContext);

    const apiMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    ];

    const options = OllamaService.sanitiseOptions(modelParams);

    const request: OllamaChatRequest = {
      model: this.model,
      messages: apiMessages,
      stream: false,
      ...(options ? { options } : {}),
    };

    const res = await nodeRequest(`${this.endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      throw new Error(`Ollama API error: HTTP ${res.status}`);
    }

    const data = JSON.parse(res.body);
    return data.message?.content || "";
  }

  /**
   * Cancel an ongoing stream
   */
  cancelStream() {
    if (this.currentAbort) {
      this.currentAbort();
      this.currentAbort = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async *streamChatAssembled(
    assembledMessages: Array<{ role: string; content: string }>,
    modelParams?: OllamaModelParams,
  ): AsyncGenerator<string, void, unknown> {
    this.abortController = new AbortController();
    this.lastStats = null;

    const options = OllamaService.sanitiseOptions(modelParams);

    const request: OllamaChatRequest = {
      model: this.model,
      messages: assembledMessages,
      stream: true,
      ...(options ? { options } : {}),
    };

    console.log("[K8s SRE] streamChatAssembled →", JSON.stringify({
      model: request.model,
      messagesCount: request.messages.length,
      totalChars: request.messages.reduce((s, m) => s + m.content.length, 0),
    }));

    const body = JSON.stringify(request);
    const { response, abort } = nodeStreamRequest(`${this.endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      timeout: 300_000,
    });

    this.currentAbort = abort;

    try {
      const { stream } = await response;
      let buffer = "";

      for await (const rawChunk of stream) {
        buffer += rawChunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk: OllamaStreamChunk = JSON.parse(line);
            if (chunk.message?.content) yield chunk.message.content;
            if (chunk.done) {
              this.lastStats = this.parseStats(chunk);
              if (this.lastStats) {
                console.log("[K8s SRE] Performance →", JSON.stringify(this.lastStats));
              }
              return;
            }
          } catch { /* skip malformed */ }
        }
      }

      if (buffer.trim()) {
        try {
          const chunk: OllamaStreamChunk = JSON.parse(buffer);
          if (chunk.message?.content) yield chunk.message.content;
          if (chunk.done) {
            this.lastStats = this.parseStats(chunk);
          }
        } catch { /* ignore */ }
      }
    } catch (error: any) {
      if (error.name === "AbortError" || error.message?.includes("aborted") || error.message?.includes("destroyed")) {
        yield "\n\n*[Response interrupted]*";
        return;
      }
      throw error;
    } finally {
      this.abortController = null;
      this.currentAbort = null;
    }
  }

  /**
   * Agentic streaming chat with tool-calling support.
   *
   * Flow per round:
   *  1. Send messages + tools to Ollama and stream the response.
   *  2. If the final chunk carries `tool_calls`, the model wants to call tools:
   *     - Yield a synthetic status line so the UI shows activity.
   *     - Execute each tool against the live ClusterContext (zero extra API calls).
   *     - Append tool results as role:"tool" messages and loop.
   *  3. If no `tool_calls`, the text was already streamed — exit.
   *
   * Token safety: tool results are produced by executeK8sTool which uses the
   * same compressor functions as the main context (groupEventsByReason, etc.).
   */
  async *streamChatWithTools(
    assembledMessages: Array<{ role: string; content: string }>,
    liveCtx: import("../../common/types").ClusterContext,
    tools: OllamaTool[],
    modelParams: OllamaModelParams | undefined,
    executeToolFn: (
      name: string,
      args: Record<string, any>,
      ctx: import("../../common/types").ClusterContext,
    ) => string | Promise<string>,
  ): AsyncGenerator<string, void, unknown> {
    const MAX_TOOL_ROUNDS = 2;
    this.lastStats = null;

    const messages: ApiMessage[] = [...assembledMessages];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const options = OllamaService.sanitiseOptions(modelParams);
      const request: OllamaChatRequest = {
        model: this.model,
        messages,
        stream: true,
        tools,
        ...(options ? { options } : {}),
      };

      console.log("[K8s SRE] streamChatWithTools round", round, "→", JSON.stringify({
        model: request.model,
        messagesCount: request.messages.length,
        tools: tools.map((t) => t.function.name),
      }));

      const { response, abort } = nodeStreamRequest(`${this.endpoint}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        timeout: 300_000,
      });
      this.currentAbort = abort;

      let doneChunk: OllamaStreamChunk | null = null;
      // Ollama emits tool_calls on a non-done intermediate chunk, not the done chunk.
      // Accumulate from any chunk so we never miss them.
      let pendingToolCalls: OllamaToolCall[] = [];

      const processChunk = (chunk: OllamaStreamChunk) => {
        if (chunk.message?.content) return chunk.message.content;
        if (chunk.message?.tool_calls?.length) {
          pendingToolCalls = [...pendingToolCalls, ...chunk.message.tool_calls];
        }
        return null;
      };

      try {
        const { stream } = await response;
        let buffer = "";

        for await (const rawChunk of stream) {
          buffer += rawChunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const chunk: OllamaStreamChunk = JSON.parse(line);
              const text = processChunk(chunk);
              if (text) yield text;
              if (chunk.done) {
                doneChunk = chunk;
                this.lastStats = this.parseStats(chunk);
                if (this.lastStats) {
                  console.log("[K8s SRE] Perf (tools round", round, ")→", JSON.stringify(this.lastStats));
                }
              }
            } catch { /* skip malformed */ }
          }
        }

        if (buffer.trim()) {
          try {
            const chunk: OllamaStreamChunk = JSON.parse(buffer);
            const text = processChunk(chunk);
            if (text) yield text;
            if (chunk.done) {
              doneChunk = chunk;
              this.lastStats = this.parseStats(chunk);
            }
          } catch { /* ignore */ }
        }
      } catch (error: any) {
        if (
          error.name === "AbortError" ||
          error.message?.includes("aborted") ||
          error.message?.includes("destroyed")
        ) {
          yield "\n\n*[Response interrupted]*";
          this.currentAbort = null;
          return;
        }
        throw error;
      }

      // Prefer accumulated tool_calls; fall back to done-chunk field for models
      // that do include them there.
      const toolCalls: OllamaToolCall[] =
        pendingToolCalls.length > 0
          ? pendingToolCalls
          : (doneChunk?.message?.tool_calls ?? []);

      if (toolCalls.length === 0) {
        // Text response — already streamed to caller.
        break;
      }

      // Append assistant’s tool-call turn, then execute each tool.
      messages.push({ role: "assistant", content: "", tool_calls: toolCalls });

      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        const toolArgs: Record<string, any> = tc.function.arguments ?? {};
        const argsStr = Object.entries(toolArgs)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(", ");

        yield `\n*[Tool: ${toolName}(${argsStr})]*\n`;

        const result = await executeToolFn(toolName, toolArgs, liveCtx);
        console.log("[K8s SRE] Tool", toolName, "→", result.length, "chars");
        messages.push({ role: "tool", content: result });
      }
      // Loop: next round sends the enriched thread back to the model.
    }

    this.currentAbort = null;
  }
}
