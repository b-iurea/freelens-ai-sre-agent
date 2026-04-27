/**
 * Copyright (c) 2026 Freelens K8s SRE Assistant Authors.
 * Licensed under MIT License.
 */

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  isStreaming?: boolean;
}

export interface OllamaConfig {
  endpoint: string;
  model: string;
}

export type ApiProvider = "ollama" | "openai-compatible";

export interface ClusterContext {
  clusterName: string;
  namespace: string;
  namespaces: string[];
  pods: K8sResourceSummary[];
  deployments: K8sResourceSummary[];
  services: K8sResourceSummary[];
  nodes: K8sResourceSummary[];
  events: K8sEventSummary[];
  /** Unix ms timestamp of when gatherContext() completed this API fetch. */
  gatheredAt?: number;
  /**
   * When ClusterMemoryService filters context for relevance, these carry
   * the unfiltered totals so buildSystemPrompt can show "(N of M, relevant to query)".
   */
  totalPods?: number;
  totalDeployments?: number;
  totalServices?: number;
  totalEvents?: number;
  /** ISO timestamp of when this snapshot was originally saved to memory. */
  snapshotAge?: number;
  /**
   * Cluster-wide health aggregate computed at snapshot time.
   * Allows buildSystemPrompt to show a one-line summary like
   * "170 Running · 7 Pending · 3 CrashLoopBackOff" without listing every pod.
   */
  podStatusCounts?: Record<string, number>;
  deploymentHealthSummary?: { healthy: number; degraded: number };
  /**
   * Per-namespace health rollup computed at snapshot time.
   * Gives the model a global view of the cluster (which namespaces have issues)
   * at near-zero token cost (~10 tokens/namespace).
   */
  namespaceHealth?: Record<string, NamespaceHealthSummary>;
}

/** Health aggregate for a single namespace. */
export interface NamespaceHealthSummary {
  podStatusCounts: Record<string, number>;
  totalPods: number;
  totalDeployments: number;
  degradedDeployments: number;
  warningEvents: number;
}

/** Runtime detail for a single container inside a pod (populated only for non-Running pods). */
export interface ContainerSummary {
  name: string;
  /** Kubernetes state/reason string, e.g. "Running", "CrashLoopBackOff", "OOMKilled". */
  state: string;
  reason?: string;
  exitCode?: number;
  restarts?: number;
  /** True when the container is NOT in the sidecar blacklist. */
  isMain: boolean;
  isSidecar: boolean;
  /** Container image (populated for anomalous pods only). */
  image?: string;
  /** Resource requests/limits (populated for anomalous pods only). */
  resources?: {
    reqCpu?: string;
    reqMem?: string;
    limCpu?: string;
    limMem?: string;
  };
  /** Liveness/readiness probes (populated for anomalous pods only). */
  probes?: {
    liveness?: string;
    readiness?: string;
  };
  /** imagePullPolicy (populated for anomalous pods only). */
  imagePullPolicy?: string;
}

/** A reference from a pod to a Secret, ConfigMap, or PVC that could not be resolved. */
export interface MissingRef {
  kind: "Secret" | "ConfigMap" | "PVC" | "Service";
  name: string;
  /** Where the reference was found: "env", "envFrom", "volume", "imagePullSecret", "selector" */
  refType: string;
}

/** Resolved relationships for a single anomalous pod. */
export interface PodRelations {
  /** Owner controller (Deployment, StatefulSet, DaemonSet). */
  ownerRef?: {
    kind: string;
    name: string;
    /** ready/desired replicas from the owner controller. */
    replicas?: string;
    /** RollingUpdate, Recreate, etc. */
    strategy?: string;
  };
  /** PVC volume claims with their current phase. */
  pvcs: Array<{ name: string; phase: string }>;
  /** References to Secrets/ConfigMaps/Services that do NOT exist in the cluster. */
  missingRefs: MissingRef[];
  /** Present references that do exist (for ✓ display). */
  presentRefs: Array<{ kind: string; name: string; refType: string }>;
  /** HPA targeting the pod's owner controller. */
  hpa?: {
    name: string;
    minReplicas: number;
    maxReplicas: number;
    currentReplicas: number;
    cpuPercent?: number;
    memPercent?: number;
  };
  /** Number of service endpoints matching this pod (0 = unreachable). */
  serviceEndpoints?: Array<{ serviceName: string; endpointCount: number }>;
  /** Ingress → Service chain. */
  ingressChain?: Array<{ ingressName: string; serviceName: string }>;
  /** Helm release name if the pod's owner is managed by Helm. */
  helmRelease?: string;
}

export interface K8sResourceSummary {
  name: string;
  namespace?: string;
  status?: string;
  age?: string;
  labels?: Record<string, string>;
  replicas?: string;
  ready?: string;
  /** Populated only for pods in a non-Running/non-healthy state. */
  containers?: ContainerSummary[];
  /** Node the pod is running on (anomalous pods only). */
  node?: string;
  /** Resolved resource relationships (anomalous pods only, requires Phase 3 data). */
  relations?: PodRelations;
}

/**
 * State for a pending human-in-the-loop tool approval.
 * Set when a tool_call for a sensitive tool (e.g. get_pod_logs) arrives in the stream.
 * The UI renders an approve/deny prompt; on approve the tool executes; on deny a synthetic
 * "User declined" message is sent back to the model.
 */
export interface ToolApprovalState {
  /** The tool name to be executed (e.g. "get_pod_logs"). */
  toolName: string;
  /** Arguments the model passed to the tool. */
  args: Record<string, string>;
  /** The model's rationale text streamed before the tool_call. */
  modelRationale: string;
  /** Internal: the resolve function to call with the user's decision. */
  resolve: (approved: boolean) => void;
}

export interface K8sEventSummary {
  type: string;
  reason: string;
  message: string;
  involvedObject: string;
  age?: string;
  /** Namespace of the involved object — used for per-namespace warning counts. */
  namespace?: string;
  /** Set when events are grouped by reason: how many occurrences were merged. */
  count?: number;
  /** Human-readable relative time of the most recent occurrence, e.g. "3m". */
  lastSeen?: string;
}

/** One-line health summary for a single namespace — used in all-namespaces view. */
export interface NamespaceDigest {
  name: string;
  /** Pod status → count map, e.g. { Running: 10, CrashLoopBackOff: 2 }. */
  podCounts: Record<string, number>;
  totalPods: number;
  totalDeployments: number;
  degradedDeployments: number;
  totalServices: number;
  /** Warning event count for this namespace. */
  warningCount: number;
}

/**
 * Compressed cluster context passed directly to buildSystemPrompt.
 * Produced by compressForPrompt() — two layouts depending on viewMode.
 */
export interface CompressedClusterContext {
  viewMode: "all-namespaces" | "single-namespace";
  clusterName: string;
  /** Unix ms from the source ClusterContext.gatheredAt — rendered in system prompt header. */
  gatheredAt?: number;
  /** Always full list — cluster-scoped resource. */
  nodes: K8sResourceSummary[];
  /** Warning events aggregated by (reason + object), max 20 groups. */
  groupedWarnings: K8sEventSummary[];
  // ── all-namespaces fields ──
  namespaceDigests?: NamespaceDigest[];
  anomalyPods?: K8sResourceSummary[];
  anomalyDeployments?: K8sResourceSummary[];
  totalPods?: number;
  totalDeployments?: number;
  totalServices?: number;
  // ── single-namespace fields ──
  namespace?: string;
  pods?: K8sResourceSummary[];
  deployments?: K8sResourceSummary[];
  services?: K8sResourceSummary[];
}

export interface OllamaModelParams {
  temperature: number;
  top_p: number;
  top_k: number;
  num_predict: number;
  repeat_penalty: number;
}

/* ─── Fidelity Evaluation ─────────────────────────────────────────────────── */

/** A single difference spotted by the judge between Diagnosis A and Diagnosis B. */
export interface FidelityDiscrepancy {
  /** "missing_info" | "hallucinated_resource" | "wrong_severity" | "extra_context" */
  type: string;
  description: string;
}

/** Full evaluation report returned by runFidelityEvaluation(). */
export interface FidelityReport {
  /** 0–1 composite score (1 = perfectly faithful, 0 = completely different). */
  score: number;
  /**
   * Raw 1-5 judge score from the LLM judge, converted to 0-1.
   * null when the judge call failed.
   */
  judgeScore: number | null;
  /**
   * Fraction of characters saved: 1 - (compressed.length / raw.length).
   * Positive = compressed is smaller.
   */
  compressionRatio: number;
  /** Approximate token savings based on character count (chars / 4). */
  tokenSavings: number;
  /** Latency of the raw-data call in ms. */
  rawLatencyMs: number;
  /** Latency of the compressed-data call in ms. */
  compressedLatencyMs: number;
  /** Positive = compressed was faster. */
  latencyDifferenceMs: number;
  /** Resource names mentioned in Diagnosis B that are NOT present in the raw data. */
  hallucinatedResources: string[];
  /** Structured differences extracted from the judge response. */
  discrepancies: FidelityDiscrepancy[];
  /** Full text of Diagnosis A (raw data). */
  diagnosisA: string;
  /** Full text of Diagnosis B (compressed data). */
  diagnosisB: string;
  /** The judge's raw explanation text. */
  judgeExplanation: string;
  /** ISO timestamp of when the evaluation was run. */
  evaluatedAt: string;
  /** Model used for all three calls. */
  model: string;
}

export const DEFAULT_MODEL_PARAMS: OllamaModelParams = {
  temperature: 0.7,
  top_p: 0.9,
  top_k: 40,
  num_predict: -1,
  repeat_penalty: 1.1,
};

/** Per-tool toggle configuration for the K8s tool-calling loop. */
export interface ToolsConfig {
  /** Master switch — when false, no tools are passed to Ollama regardless of individual toggles. */
  enabled: boolean;
  tools: {
    get_namespace_detail: boolean;
    get_pod_detail: boolean;
    get_resource_events: boolean;
    get_deployment_detail: boolean;
    get_nodes: boolean;
    /** Requires human-in-the-loop approval before execution. */
    get_pod_logs: boolean;
    get_resource_chain: boolean;
    /** List all resources of a given kind across the cluster. */
    list_resources: boolean;
  };
}

export const DEFAULT_TOOLS_CONFIG: ToolsConfig = {
  enabled: true,
  tools: {
    get_namespace_detail: true,
    get_pod_detail: true,
    get_resource_events: true,
    get_deployment_detail: true,
    get_nodes: true,
    get_pod_logs: true,
    get_resource_chain: true,
    list_resources: true,
  },
};

export interface OllamaChatRequest {
  model: string;
  messages: ApiMessage[];
  stream: boolean;
  tools?: OllamaTool[];
  options?: Partial<OllamaModelParams>;
}

export interface OllamaChatResponse {
  model: string;
  message: {
    role: string;
    content: string;
  };
  done: boolean;
}

export interface OllamaStreamChunk {
  model: string;
  message: {
    role: string;
    content: string;
    /** Present when the model wants to call one or more tools instead of producing text. */
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  /* ── Performance fields (only present when done=true) ── */
  total_duration?: number;       // nanoseconds
  load_duration?: number;        // nanoseconds
  prompt_eval_count?: number;    // tokens evaluated in the prompt
  prompt_eval_duration?: number; // nanoseconds
  eval_count?: number;           // tokens generated
  eval_duration?: number;        // nanoseconds
}

/** Parsed performance stats from Ollama's final streaming chunk. */
export interface OllamaPerformanceStats {
  model: string;
  totalDurationMs: number;
  promptTokens: number;
  promptEvalMs: number;
  promptTokensPerSec: number;
  generatedTokens: number;
  generationMs: number;
  tokensPerSec: number;
  loadMs: number;
  timestamp: number;
}

export interface OllamaModelInfo {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
}

/**
 * A single message in the Ollama chat API.
 * role can be "system" | "user" | "assistant" | "tool".
 * tool_calls is present on assistant messages that invoke tools.
 */
export interface ApiMessage {
  role: string;
  content: string;
  tool_calls?: OllamaToolCall[];
  /** OpenAI-compatible tool result messages use this to bind tool output to a prior call. */
  tool_call_id?: string;
}

/** A single tool-call request produced by the model. */
export interface OllamaToolCall {
  /** Present on OpenAI-compatible tool calls. */
  id?: string;
  function: {
    name: string;
    /** JSON-decoded arguments from the model. */
    arguments: Record<string, any>;
  };
}

/** Ollama tool-calling schema (OpenAI-compatible format). */
export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      required?: string[];
      properties: Record<string, {
        type: "string" | "number" | "boolean";
        description: string;
        enum?: string[];
      }>;
    };
  };
}

/* ── Context pipeline types (used by ChunkManager / BM25 / SummaryManager) ── */

export interface ConversationState {
  /** Current summary of old turns (empty string if none) */
  summary: string;
  /** Index up to which messages have been summarised */
  summarisedUpToIndex: number;
  /** Whether a summary is currently being generated */
  isSummarising: boolean;
}
