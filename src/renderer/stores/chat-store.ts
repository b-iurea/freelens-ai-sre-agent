/**
 * Copyright (c) 2026 Freelens K8s SRE Assistant Authors.
 * Licensed under MIT License.
 *
 * Chat Store - MobX state management for the chat
 */

import { action, computed, makeObservable, observable, runInAction } from "mobx";
import type { ApiProvider, ChatMessage, ClusterContext, FidelityReport, OllamaModelInfo, OllamaModelParams, OllamaPerformanceStats, ToolApprovalState, ToolsConfig } from "../../common/types";
import { DEFAULT_MODEL_PARAMS, DEFAULT_TOOLS_CONFIG } from "../../common/types";
import { K8sContextService } from "../services/k8s-context-service";
import { OllamaService } from "../services/ollama-service";
import { runFidelityEvaluation } from "../services/fidelity-evaluator";
import {
  ChunkManager,
  BM25Retriever,
  SummaryManager,
  ContextBuilder,
  ClusterMemoryService,
  compressForPrompt,
  K8S_TOOLS,
  executeK8sTool,
  executePodLogsApproved,
} from "../services/context";

/**
 * Render a ClusterContext into a compact, human-readable text that a language
 * model can parse for diagnostic purposes.  Used as the "raw data" input for
 * DiagA in the Fidelity Evaluator so the model gets structured text instead of
 * a raw K8s API JSON blob.
 */
function buildRawContextText(ctx: ClusterContext): string {
  const lines: string[] = [];
  lines.push(`CLUSTER: ${ctx.clusterName}`);
  lines.push(`NAMESPACES (${ctx.namespaces.length}): ${ctx.namespaces.join(", ")}`);
  if (ctx.gatheredAt) {
    lines.push(`GATHERED: ${new Date(ctx.gatheredAt).toISOString()}`);
  }

  lines.push(`\nPODS (${ctx.pods.length}):`);
  for (const pod of ctx.pods) {
    const ns = pod.namespace ? `${pod.namespace}/` : "";
    const containers = pod.containers
      ?.map((c) => `${c.name}:${c.state}${c.exitCode != null ? `/exit=${c.exitCode}` : ""}${c.restarts ? `/restarts=${c.restarts}` : ""}`)
      .join(", ") ?? "";
    lines.push(`  ${ns}${pod.name}: ${pod.status ?? "Unknown"}${containers ? ` [${containers}]` : ""}`);
  }

  lines.push(`\nDEPLOYMENTS (${ctx.deployments.length}):`);
  for (const dep of ctx.deployments) {
    const ns = dep.namespace ? `${dep.namespace}/` : "";
    lines.push(`  ${ns}${dep.name}: ready=${dep.ready ?? "?"} replicas=${dep.replicas ?? "?"}`);
  }

  lines.push(`\nSERVICES (${ctx.services.length}):`);
  for (const svc of ctx.services) {
    const ns = svc.namespace ? `${svc.namespace}/` : "";
    lines.push(`  ${ns}${svc.name}: ${svc.status ?? "active"}`);
  }

  lines.push(`\nNODES (${ctx.nodes.length}):`);
  for (const node of ctx.nodes) {
    lines.push(`  ${node.name}: ${node.status ?? "Unknown"}`);
  }

  lines.push(`\nEVENTS (${ctx.events.length}):`);
  for (const evt of ctx.events) {
    const ns = evt.namespace ? `${evt.namespace} | ` : "";
    const count = evt.count ? ` (x${evt.count})` : "";
    const age = evt.lastSeen ?? evt.age ?? "??";
    lines.push(`  ${ns}${evt.type} ${evt.reason} | ${evt.involvedObject}${count} | ${age}`);
    if (evt.message) lines.push(`    ${evt.message}`);
  }

  return lines.join("\n");
}

const SETTINGS_KEY = "k8s-sre-assistant-settings";

interface PersistedSettings {
  ollamaEndpoint: string;
  ollamaModel: string;
  apiProvider?: ApiProvider;
  openaiApiKey?: string;
  autoRefreshContext: boolean;
  modelParams?: OllamaModelParams;
  selectedNamespace?: string;
  selectedSreMode?: SreModeKey;
  toolsConfig?: ToolsConfig;
}

export type SreModeKey = "auto" | "troubleshoot" | "security" | "cost" | "capacity" | "yaml";

const SESSION_KEY_PREFIX = "k8s-sre-assistant-session";

const SRE_MODE_INSTRUCTIONS: Record<SreModeKey, string> = {
  auto: "Auto mode: infer the best SRE workflow for the user request.",
  troubleshoot: "Troubleshoot mode: prioritize root cause analysis, evidence, and verification steps.",
  security: "Security review mode: prioritize RBAC, PodSecurity, NetworkPolicy, image and secret risks.",
  cost: "Cost check mode: prioritize waste reduction, right-sizing, autoscaling and noisy workloads.",
  capacity: "Capacity planning mode: prioritize saturation signals, scheduling pressure and scaling strategy.",
  yaml: "YAML helper mode: prioritize precise Kubernetes manifests, patches and safe apply guidance.",
};

type QueryIntent = "write" | "investigate" | "explain" | "general";

/**
 * Classify the user's request into a response-format intent.
 * - write:       user wants a YAML manifest, kubectl command, or patch → output directly
 * - investigate: user is debugging an issue, asking why something broke → full SRE analysis
 * - explain:     user wants a concept explained → clear prose, no structured sections
 * - general:     everything else → concise direct answer
 */
function inferQueryIntent(input: string, sreMode: SreModeKey): QueryIntent {
  // Explicit mode overrides
  if (sreMode === "yaml") return "write";
  if (sreMode === "troubleshoot") return "investigate";

  const lower = input.toLowerCase();

  // Write signals: user wants a manifest, command, or deployment
  if (
    /\b(write|create|generate|make|build|draft|produce|give\s+me|show\s+me)\b.{0,40}\b(yaml|manifest|deployment|service|configmap|ingress|secret|pvc|cronjob|job|namespace|daemonset|statefulset|hpa|pdb)\b/i.test(input) ||
    /\b(yaml|manifest)\b/i.test(lower) ||
    /\bwrite\s+a\b/i.test(lower) ||
    /\b(deploy|install|add)\s+\w+/i.test(lower)
  ) {
    return "write";
  }

  // Investigate signals: debugging, incidents, anomalies
  if (
    /\b(why|crash|crashloop|oomkill|oom|error|fail|failing|broken|not\s+working|not\s+start|debug|troubleshoot|investigate|diagnose|issue|problem|incident|alert|spike|slow|latency|timeout|evict|pend|stuck|unhealthy)\b/i.test(lower) ||
    sreMode === "security" || sreMode === "cost" || sreMode === "capacity"
  ) {
    return "investigate";
  }

  // Explain signals: conceptual questions
  if (/\b(what\s+is|what\s+are|how\s+does|how\s+do|explain|describe|tell\s+me\s+about|difference\s+between|when\s+should)\b/i.test(lower)) {
    return "explain";
  }

  return "general";
}

const SRE_INVESTIGATION_ROLES = [
  "Investigator: extract facts, anomalies, and confidence levels from cluster data.",
  "Explainer: translate technical findings into concise root-cause narratives.",
  "Change Planner: sequence low-risk actions with validation and rollback checks.",
].join("\n");

const SRE_INVESTIGATION_CONTRACT = [
  "Answer in this order:",
  "1) Evidence — facts from cluster data",
  "2) Correlation — link events, pods, deployments",
  "3) Hypotheses — ranked by likelihood",
  "4) Root cause — most likely explanation based on evidence",
  "5) Safest next actions",
  "Only add kubectl commands or YAML (section 6) if the user EXPLICITLY asks for them.",
  "Prefix any mutating command with RISK: low|medium|high.",
].join("\n");

export class ChatStore {
  messages: ChatMessage[] = [];
  isLoading = false;
  error: string | null = null;
  ollamaEndpoint = "http://localhost:11434";
  ollamaModel = "qwen3.5:cloud"; 
  apiProvider: ApiProvider = "ollama";
  openaiApiKey = "";
  availableModels: OllamaModelInfo[] = [];
  isOllamaConnected = false;
  clusterContext: ClusterContext | null = null;
  isGatheringContext = false;
  autoRefreshContext = true;
  modelParams: OllamaModelParams = { ...DEFAULT_MODEL_PARAMS };
  selectedNamespace = "__all__";
  selectedSreMode: SreModeKey = "auto";
  availableNamespaces: string[] = [];
  lastPerformanceStats: OllamaPerformanceStats | null = null;
  /** Latest fidelity evaluation result, null until first run. */
  fidelityReport: FidelityReport | null = null;
  isFidelityRunning = false;
  toolsConfig: ToolsConfig = { ...DEFAULT_TOOLS_CONFIG, tools: { ...DEFAULT_TOOLS_CONFIG.tools } };
  pendingToolApproval: ToolApprovalState | null = null;
  /** Set by workload context-menu / detail-panel buttons to auto-send a pre-built analysis prompt. */
  pendingAnalysis: string | null = null;
  /** Controls visibility of the floating SRE chat popup panel. */
  popupOpen = false;

  private ollamaService: OllamaService;
  private chunkManager: ChunkManager;
  private summaryManager: SummaryManager;
  private currentSessionKey = "";
  private autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private static instance: ChatStore | null = null;

  static getInstance(): ChatStore {
    if (!ChatStore.instance) {
      ChatStore.instance = new ChatStore();
    }
    return ChatStore.instance;
  }

  constructor() {
    makeObservable(this, {
      messages: observable,
      isLoading: observable,
      error: observable,
      ollamaEndpoint: observable,
      ollamaModel: observable,
      apiProvider: observable,
      openaiApiKey: observable,
      availableModels: observable,
      isOllamaConnected: observable,
      clusterContext: observable,
      isGatheringContext: observable,
      autoRefreshContext: observable,
      modelParams: observable,
      selectedNamespace: observable,
      selectedSreMode: observable,
      availableNamespaces: observable,
      lastPerformanceStats: observable,
      fidelityReport: observable,
      isFidelityRunning: observable,
      toolsConfig: observable,
      pendingToolApproval: observable,
      pendingAnalysis: observable,
      hasMessages: computed,
      lastMessage: computed,
      setEndpoint: action,
      setModel: action,
      setApiProvider: action,
      setOpenAIApiKey: action,
      setAutoRefreshContext: action,
      setModelParams: action,
      setSelectedNamespace: action,
      setSelectedSreMode: action,
      syncSettings: action,
      clearMessages: action,
      setError: action,
      checkConnection: action,
      refreshClusterContext: action,
      sendMessage: action,
      runFidelityEvaluation: action,
      setToolsConfig: action,
      approvePendingTool: action,
      denyPendingTool: action,
      triggerWorkloadAnalysis: action,
      consumePendingAnalysis: action,
      popupOpen: observable,
      openPopup: action,
      closePopup: action,
    });

    this.loadSettings();
    this.ollamaService = new OllamaService(this.ollamaEndpoint, this.ollamaModel, this.apiProvider, this.openaiApiKey);
    this.chunkManager = new ChunkManager();
    this.summaryManager = new SummaryManager();
    // Wire SummaryManager to call Ollama for compression
    this.summaryManager.setGenerateFn((prompt) => this.ollamaService.generateText(prompt));
    this.currentSessionKey = this.buildSessionKey("unknown-cluster", this.selectedNamespace);
    this.loadSessionMessages(this.currentSessionKey);
    // Warm-start: restore namespace list so selector shows options immediately.
    // clusterContext is intentionally NOT seeded from localStorage — always fetch live.
    this.warmStartFromMemory();
    // Background context refresh every 5 minutes.
    this.startAutoRefreshTimer();

    // Sync settings across contexts (preferences ↔ cluster page)
    try {
      window.addEventListener("storage", this.onStorageChange);
    } catch {
      // ignore if window is not available
    }
  }

  private loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const s: PersistedSettings = JSON.parse(raw);
        if (s.ollamaEndpoint) this.ollamaEndpoint = s.ollamaEndpoint;
        if (s.ollamaModel) this.ollamaModel = s.ollamaModel;
        if (s.apiProvider) this.apiProvider = s.apiProvider;
        if (typeof s.openaiApiKey === "string") this.openaiApiKey = s.openaiApiKey;
        if (typeof s.autoRefreshContext === "boolean") this.autoRefreshContext = s.autoRefreshContext;
        if (s.modelParams) this.modelParams = { ...DEFAULT_MODEL_PARAMS, ...s.modelParams };
        if (s.selectedNamespace) this.selectedNamespace = s.selectedNamespace;
        if (s.selectedSreMode) this.selectedSreMode = s.selectedSreMode;
        if (s.toolsConfig) {
          this.toolsConfig = {
            ...DEFAULT_TOOLS_CONFIG,
            ...s.toolsConfig,
            tools: { ...DEFAULT_TOOLS_CONFIG.tools, ...s.toolsConfig.tools },
          };
        }
      }
    } catch {
      // first run or corrupt data — use defaults
    }
  }

  private saveSettings() {
    try {
      const s: PersistedSettings = {
        ollamaEndpoint: this.ollamaEndpoint,
        ollamaModel: this.ollamaModel,
        apiProvider: this.apiProvider,
        openaiApiKey: this.openaiApiKey,
        autoRefreshContext: this.autoRefreshContext,
        modelParams: this.modelParams,
        selectedNamespace: this.selectedNamespace,
        selectedSreMode: this.selectedSreMode,
        toolsConfig: this.toolsConfig,
      };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch {
      // storage full or unavailable
    }
  }

  /**
   * Re-read settings from localStorage and sync to OllamaService.
   * Bridges preferences ↔ cluster-page contexts that may hold separate singletons.
   */
  syncSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const s: PersistedSettings = JSON.parse(raw);
      if (s.ollamaEndpoint && s.ollamaEndpoint !== this.ollamaEndpoint) {
        this.ollamaEndpoint = s.ollamaEndpoint;
        this.ollamaService.setEndpoint(s.ollamaEndpoint);
      }
      if (s.ollamaModel && s.ollamaModel !== this.ollamaModel) {
        this.ollamaModel = s.ollamaModel;
        this.ollamaService.setModel(s.ollamaModel);
      }
      if (s.apiProvider && s.apiProvider !== this.apiProvider) {
        this.apiProvider = s.apiProvider;
        this.ollamaService.setProvider(s.apiProvider);
      }
      if (typeof s.openaiApiKey === "string" && s.openaiApiKey !== this.openaiApiKey) {
        this.openaiApiKey = s.openaiApiKey;
        this.ollamaService.setApiKey(s.openaiApiKey);
      }
      if (typeof s.autoRefreshContext === "boolean") {
        this.autoRefreshContext = s.autoRefreshContext;
      }
      if (s.modelParams) {
        this.modelParams = { ...DEFAULT_MODEL_PARAMS, ...s.modelParams };
      }
      if (s.selectedSreMode) {
        this.selectedSreMode = s.selectedSreMode;
      }
    } catch {
      // ignore parse errors
    }
  }

  private buildSessionKey(clusterName: string, namespace: string): string {
    const c = (clusterName || "unknown-cluster").replace(/\s+/g, "_").toLowerCase();
    const ns = (namespace || "__all__").replace(/\s+/g, "_").toLowerCase();
    return `${SESSION_KEY_PREFIX}:${c}:${ns}`;
  }

  private loadSessionMessages(sessionKey: string) {
    try {
      const raw = localStorage.getItem(sessionKey);
      if (!raw) {
        this.messages = [];
        this.summaryManager.reset();
        return;
      }
      const parsed: ChatMessage[] = JSON.parse(raw);
      this.messages = Array.isArray(parsed)
        ? parsed.map((m) => ({ ...m, isStreaming: false }))
        : [];
      this.summaryManager.reset();
    } catch {
      this.messages = [];
      this.summaryManager.reset();
    }
  }

  private persistSessionMessages() {
    if (!this.currentSessionKey) return;
    try {
      localStorage.setItem(this.currentSessionKey, JSON.stringify(this.messages));
    } catch {
      // ignore storage errors
    }
  }

  private warmStartFromMemory() {
    try {
      // Restore only the namespace list so the selector shows options immediately.
      // Do NOT seed clusterContext with stale snapshot data — always fetch live.
      const ns = this.selectedNamespace;
      const snap = ClusterMemoryService.load("unknown-cluster", ns)
        ?? ClusterMemoryService.load("unknown-cluster", "__all__");
      if (snap && snap.namespaces.length > 0) {
        runInAction(() => {
          this.availableNamespaces = snap.namespaces;
        });
        console.log("[K8s SRE Memory] warm-start: restored", snap.namespaces.length, "namespaces");
      }
    } catch (e: any) {
      console.warn("[K8s SRE Memory] warm-start failed:", e?.message);
    }
  }

  private startAutoRefreshTimer() {
    if (this.autoRefreshTimer) clearInterval(this.autoRefreshTimer);
    // Silently refresh cluster context every 5 minutes so the model always
    // sees reasonably fresh data even between manual refreshes.
    this.autoRefreshTimer = setInterval(() => {
      if (!this.isGatheringContext && !this.isLoading) {
        console.log("[K8s SRE] Background context refresh");
        this.refreshClusterContext().catch((e: any) => {
          console.warn("[K8s SRE] Background refresh failed:", e?.message);
        });
      }
    }, 5 * 60 * 1000);
  }

  private switchSessionScope(clusterName?: string, namespace?: string) {
    const key = this.buildSessionKey(clusterName || "unknown-cluster", namespace || "__all__");
    if (key === this.currentSessionKey) return;
    this.currentSessionKey = key;
    this.loadSessionMessages(key);
  }

  private onStorageChange = (e: StorageEvent) => {
    if (e.key === SETTINGS_KEY && e.newValue) {
      runInAction(() => this.syncSettings());
      this.checkConnection();
    }
  };

  get hasMessages(): boolean {
    return this.messages.length > 0;
  }

  get lastMessage(): ChatMessage | undefined {
    return this.messages[this.messages.length - 1];
  }

  setEndpoint(endpoint: string) {
    this.ollamaEndpoint = endpoint;
    this.ollamaService.setEndpoint(endpoint);
    this.saveSettings();
  }

  setModel(model: string) {
    this.ollamaModel = model;
    this.ollamaService.setModel(model);
    this.saveSettings();
  }

  setApiProvider(provider: ApiProvider) {
    this.apiProvider = provider;
    this.ollamaService.setProvider(provider);
    this.saveSettings();
  }

  setOpenAIApiKey(apiKey: string) {
    this.openaiApiKey = apiKey;
    this.ollamaService.setApiKey(apiKey);
    this.saveSettings();
  }

  setAutoRefreshContext(value: boolean) {
    this.autoRefreshContext = value;
    this.saveSettings();
  }

  setSelectedSreMode(mode: SreModeKey) {
    this.selectedSreMode = mode;
    this.saveSettings();
  }

  setModelParams(params: Partial<OllamaModelParams>) {
    this.modelParams = { ...this.modelParams, ...params };
    this.saveSettings();
  }

  setToolsConfig(config: ToolsConfig) {
    this.toolsConfig = config;
    this.saveSettings();
  }

  approvePendingTool() {
    if (this.pendingToolApproval) {
      const { resolve } = this.pendingToolApproval;
      this.pendingToolApproval = null;
      resolve(true);
    }
  }

  denyPendingTool() {
    if (this.pendingToolApproval) {
      const { resolve } = this.pendingToolApproval;
      this.pendingToolApproval = null;
      resolve(false);
    }
  }

  /**
   * Called by workload context-menu / detail-panel buttons.
   * Builds the analysis prompt and stores it so SreChat can pick it up,
   * then navigates to the SRE Assistant page automatically.
   */
  triggerWorkloadAnalysis(
    kind: string,
    name: string,
    namespace: string,
    analysisType: "relationship" | "resources",
  ) {
    let prompt: string;
    if (analysisType === "relationship") {
      prompt =
        `Draw the full relationship and dependency map for ${kind}/${name} in namespace ${namespace}. ` +
        `Include: owner controller, volumes (PVCs), referenced Secrets and ConfigMaps, Services and Ingresses, ` +
        `HPA, and any missing or misconfigured dependencies. Use a mermaid diagram if helpful. ` +
        `Base the analysis exclusively on the LIVE CLUSTER CONTEXT — do not call tools if data is already available.`;
    } else {
      prompt =
        `Perform a resource analysis for ${kind}/${name} in namespace ${namespace}. ` +
        `Analyse: CPU and memory requests vs limits vs actual usage, OOMKill history (exit code 137), ` +
        `restart patterns, any throttling signals, and right-sizing recommendations based on real observed data. ` +
        `Show a Markdown table with current settings and recommended values with clear mathematical justification. ` +
        `Base the analysis exclusively on the LIVE CLUSTER CONTEXT — do not call tools if data is already available.`;
    }
    this.pendingAnalysis = prompt;
    this.openPopup();
  }

  /** Atomically reads and clears pendingAnalysis. */
  consumePendingAnalysis(): string | null {
    const val = this.pendingAnalysis;
    this.pendingAnalysis = null;
    return val;
  }

  /** Opens the floating SRE chat popup panel. */
  openPopup(): void {
    this.popupOpen = true;
  }

  /** Closes the floating SRE chat popup panel. */
  closePopup(): void {
    this.popupOpen = false;
  }

  async setSelectedNamespace(ns: string) {
    this.persistSessionMessages();
    this.selectedNamespace = ns;
    this.saveSettings();
    // Immediately clear stale context so the UI doesn't show old data
    runInAction(() => {
      this.clusterContext = null;
    });
    // Re-gather context for the new namespace
    await this.refreshClusterContext();
  }

  clearMessages() {
    this.messages = [];
    this.error = null;
    this.summaryManager.reset();
    this.persistSessionMessages();
  }

  setError(error: string | null) {
    this.error = error;
  }

  private buildSreWorkflowInstruction(userInput: string): { instruction: string; intent: QueryIntent } {
    const intent = inferQueryIntent(userInput, this.selectedSreMode);

    if (intent === "write") {
      return {
        intent,
        instruction: [
          "--- RESPONSE FORMAT: WRITE MODE ---",
          "Output the YAML manifest or kubectl commands directly. No analysis preamble.",
          "- One line at the top: RISK: low|medium|high — one sentence justification.",
          "- Include one verification step (kubectl get / rollout status).",
          "- Keep manifests minimal and production-safe (resource limits, probes where relevant).",
          "- Do NOT output Evidence / Correlation / Hypotheses sections.",
        ].join("\n"),
      };
    }

    if (intent === "investigate") {
      return {
        intent,
        instruction: [
          "--- RESPONSE FORMAT: INVESTIGATION MODE ---",
          SRE_INVESTIGATION_ROLES,
          "",
          SRE_INVESTIGATION_CONTRACT,
        ].join("\n"),
      };
    }

    if (intent === "explain") {
      return {
        intent,
        instruction: [
          "--- RESPONSE FORMAT: EXPLAIN MODE ---",
          "Give a clear, direct explanation. Be concise.",
          "Reference live cluster data only if directly relevant.",
          "No Evidence / Hypotheses structure needed.",
        ].join("\n"),
      };
    }

    // general
    return {
      intent,
      instruction: [
        "--- RESPONSE FORMAT: DIRECT ---",
        "Answer directly and concisely. Use cluster data if relevant.",
        "No structured analysis sections needed.",
      ].join("\n"),
    };
  }

  async checkConnection() {
    this.syncSettings();
    try {
      const connected = await this.ollamaService.isAvailable();
      const detectedProvider = this.ollamaService.getProvider();
      const models = connected ? await this.ollamaService.listModels() : [];
      runInAction(() => {
        this.apiProvider = detectedProvider;
        this.isOllamaConnected = connected;
        if (connected) {
          this.availableModels = models;
          this.error = null;
        } else {
          const providerName = this.apiProvider === "ollama" ? "Ollama" : "OpenAI-compatible endpoint";
          this.error = `Cannot connect to ${providerName}. Check endpoint: ${this.ollamaEndpoint}`;
          this.availableModels = [];
        }
      });
    } catch (e: any) {
      runInAction(() => {
        this.isOllamaConnected = false;
        this.error = `Connection error: ${e.message}`;
        this.availableModels = [];
      });
    }
  }

  async refreshClusterContext() {
    runInAction(() => { this.isGatheringContext = true; });
    try {
      const ns = this.selectedNamespace === "__all__" ? undefined : this.selectedNamespace;
      const ctx = await K8sContextService.gatherContext(ns);
      // Persist snapshot to memory so future sessions warm-start instantly
      ClusterMemoryService.save(ctx, this.selectedNamespace);
      runInAction(() => {
        this.clusterContext = ctx;
        // Update available namespaces list
        if (ctx.namespaces.length > 0) {
          this.availableNamespaces = ctx.namespaces;
        }
        this.switchSessionScope(ctx.clusterName, this.selectedNamespace);
      });
      console.log(
        "[K8s SRE] Cluster context refreshed →",
        `ns=${ns ?? "all"}`,
        `pods=${ctx.pods.length}`,
        `deployments=${ctx.deployments.length}`,
        `services=${ctx.services.length}`,
        `nodes=${ctx.nodes.length}`,
        `events=${ctx.events.length}`,
      );
    } catch (e: any) {
      console.warn("[K8s SRE] Failed to gather cluster context:", e);
      // Keep previous context if available rather than wiping it
    } finally {
      runInAction(() => { this.isGatheringContext = false; });
    }
  }

  async sendMessage(content: string) {
    if (!content.trim() || this.isLoading) return;

    // Re-read settings in case preferences changed in another context
    this.syncSettings();

    // Add user message
    const userMessage: ChatMessage = {
      id: generateId(),
      role: "user",
      content: content.trim(),
      timestamp: Date.now(),
    };
    runInAction(() => { this.messages.push(userMessage); });
    this.persistSessionMessages();

    // Auto-refresh context before each message if enabled
    if (this.autoRefreshContext) {
      await this.refreshClusterContext();
    }

    // Create assistant message placeholder
    const assistantMessage: ChatMessage = {
      id: generateId(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
    };
    runInAction(() => {
      this.messages.push(assistantMessage);
      this.isLoading = true;
      this.error = null;
    });

    try {
      /* ── Context pipeline ── */

      // 1. Compress live cluster context for the system prompt.
      //    all-namespaces: namespace digests + anomalies only
      //    single-namespace: all resources for that namespace
      const viewMode = this.selectedNamespace === "__all__" ? "all-namespaces" : "single-namespace";
      const rawCtx = this.clusterContext ?? undefined;
      const promptContext = rawCtx ? compressForPrompt(rawCtx, viewMode) : undefined;
      // Compute enabled tools before building the system prompt so we can
      // suppress tool-related instructions when tools are off.
      const enabledTools = rawCtx && this.toolsConfig.enabled
        ? K8S_TOOLS.filter((t) => this.toolsConfig.tools[t.function.name as keyof ToolsConfig["tools"]])
        : [];
      const baseSystemPrompt = this.ollamaService.buildSystemPrompt(promptContext, enabledTools.length > 0);
      const modeInstruction = SRE_MODE_INSTRUCTIONS[this.selectedSreMode];
      const { instruction: workflowInstruction } = this.buildSreWorkflowInstruction(userMessage.content);
      const systemPrompt = [
        baseSystemPrompt,
        "",
        "--- ACTIVE SRE MODE ---",
        modeInstruction,
        "",
        workflowInstruction,
      ].join("\n");

      // 2. Use existing summary (computed after previous response, not blocking)
      const summary = this.summaryManager.getSummary();

      // 3. Chunk only non-summarised history for BM25 retrieval
      //    Summarised turns are already captured in the summary —
      //    retrieving them again would waste tokens and add noise.
      const recentMessages = this.summaryManager.getRecentMessages(this.messages);
      const nonSummarisedChunks = this.chunkManager.buildChunks(recentMessages);
      const bm25Index = BM25Retriever.buildIndex(nonSummarisedChunks);
      const retrievedChunks = BM25Retriever.retrieve(bm25Index, userMessage.content, 5);

      // 4. Assemble the final prompt
      const assembled = ContextBuilder.assemble(
        systemPrompt,
        summary,
        retrievedChunks,
        recentMessages,
        userMessage,
      );

      console.log("[K8s SRE] Context pipeline →", JSON.stringify(assembled.debug));

      // 5. Stream via Ollama — use agentic tool-calling when cluster context is available
      //    and at least one tool is enabled by the user.

      // HiL wrapper: every tool call requires user approval before execution.
      // For get_pod_logs, also resolves the correct container name from context.
      const toolExecutor = async (name: string, args: Record<string, any>, ctx: import("../../common/types").ClusterContext): Promise<string> => {
        // Auto-resolve container name for get_pod_logs so the model never guesses wrong
        if (name === "get_pod_logs") {
          const podName = String(args.name ?? "");
          const podNs   = String(args.namespace ?? "default");
          const pod = ctx.pods.find(
            (p) => p.name === podName && (p.namespace ?? "default") === podNs,
          );
          if (pod?.containers && pod.containers.length > 0) {
            const knownNames = pod.containers.map((c) => c.name);
            const provided = String(args.container ?? "");
            if (provided === "" || !knownNames.includes(provided)) {
              const main = pod.containers.find((c) => c.isMain) ?? pod.containers[0];
              args = { ...args, container: main.name };
            }
          }
        }

        // Show approval card for every tool call
        const lastAssistantContent =
          [...this.messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
        const approved = await new Promise<boolean>((resolve) => {
          runInAction(() => {
            this.pendingToolApproval = {
              toolName: name,
              args: args as Record<string, string>,
              modelRationale: lastAssistantContent,
              resolve,
            };
          });
        });
        runInAction(() => { this.pendingToolApproval = null; });

        if (!approved) {
          return `User declined to run '${name}'. Continue analysis using available context.`;
        }
        if (name === "get_pod_logs") {
          return executePodLogsApproved(args as Record<string, string>, ctx);
        }
        return executeK8sTool(name, args, ctx);
      };

      const stream = rawCtx && enabledTools.length > 0
        ? this.ollamaService.streamChatWithTools(
            assembled.messages,
            rawCtx,
            enabledTools,
            { ...this.modelParams },
            toolExecutor,
          )
        : this.ollamaService.streamChatAssembled(assembled.messages, { ...this.modelParams });

      for await (const chunk of stream) {
        runInAction(() => {
          const msgIndex = this.messages.findIndex((m) => m.id === assistantMessage.id);
          if (msgIndex >= 0) {
            this.messages[msgIndex] = {
              ...this.messages[msgIndex],
              content: this.messages[msgIndex].content + chunk,
            };
          }
        });
      }

      // Mark streaming as done
      runInAction(() => {
        const finalIndex = this.messages.findIndex((m) => m.id === assistantMessage.id);
        if (finalIndex >= 0) {
          // Sanitise small-LLM hallucinations:
          // - Fake tool-call text like *[Tool: get_nodes()]*
          // - Fabricated shell prompts like "$ kubectl ..."
          let content = this.messages[finalIndex].content;
          content = content.replace(/\*?\[Tool:\s*[^\]]*\]\*?\n?/g, "");
          content = content.replace(/^```(?:bash|sh|shell)\n(?:\$\s*kubectl\s+.*\n?)+```\n?/gm, "");
          this.messages[finalIndex] = {
            ...this.messages[finalIndex],
            content,
            isStreaming: false,
          };
        }
        // Capture performance stats from Ollama's final chunk
        if (this.ollamaService.lastStats) {
          this.lastPerformanceStats = { ...this.ollamaService.lastStats };
        }
      });
      this.persistSessionMessages();

      // 6. Post-response: compress old turns in background if threshold reached.
      //    Runs AFTER the response is delivered so it doesn't add latency.
      //    The summary will be ready for the *next* message.
      if (this.summaryManager.shouldSummarise(this.messages)) {
        this.summaryManager.maybeCompress(this.messages, userMessage.content).catch((e) => {
          console.warn("[K8s SRE] Background summarisation failed:", e?.message);
        });
      }
    } catch (e: any) {
      runInAction(() => {
        this.error = `AI Error: ${e.message}`;
        const errIndex = this.messages.findIndex((m) => m.id === assistantMessage.id);
        if (errIndex >= 0 && !this.messages[errIndex].content) {
          this.messages.splice(errIndex, 1);
        } else if (errIndex >= 0) {
          this.messages[errIndex] = {
            ...this.messages[errIndex],
            isStreaming: false,
          };
        }
      });
      this.persistSessionMessages();
    } finally {
      runInAction(() => { this.isLoading = false; });
    }
  }

  cancelStream() {
    this.ollamaService.cancelStream();
    this.isLoading = false;
  }

  getSuggestedActions(): string[] {
    const actions = new Set<string>();
    const ctx = this.clusterContext;
    const lastUser = [...this.messages].reverse().find((m) => m.role === "user")?.content.toLowerCase() || "";

    if (ctx) {
      const warnings = ctx.events.filter((e) => e.type === "Warning").length;
      if (warnings > 0) actions.add("Show top warning events and likely root causes");
      if (ctx.pods.some((p) => (p.status || "").toLowerCase().includes("crashloop"))) {
        actions.add("Investigate CrashLoopBackOff pods with prioritized fixes");
      }
      if (ctx.deployments.some((d) => {
        const [ready, desired] = (d.replicas || "0/0").split("/").map((n) => Number(n));
        return Number.isFinite(ready) && Number.isFinite(desired) && desired > ready;
      })) {
        actions.add("List deployments with replica mismatch and rollout checks");
      }
    }

    if (this.selectedSreMode === "security" || lastUser.includes("security") || lastUser.includes("rbac")) {
      actions.add("Run a quick RBAC and pod security posture review");
    }
    if (this.selectedSreMode === "cost" || lastUser.includes("cost") || lastUser.includes("resource")) {
      actions.add("Suggest cost optimizations for over-provisioned workloads");
    }
    if (this.selectedSreMode === "yaml" || lastUser.includes("yaml") || lastUser.includes("manifest")) {
      actions.add("Draft a safe YAML patch with explanation and dry-run command");
    }

    if (this.messages.length >= 4) {
      actions.add("Generate an operations runbook from this investigation");
    }

    if (actions.size === 0) {
      actions.add("Summarize cluster health and top risks right now");
      actions.add("Recommend the next 3 troubleshooting steps");
    }

    return Array.from(actions).slice(0, 5);
  }

  /**
   * Run a fidelity evaluation comparing raw vs compressed cluster context.
   * Fires 3 Ollama calls (DiagA, DiagB, Judge) in the background and stores
   * the result in this.fidelityReport for the UI to render.
   */
  async runFidelityEvaluation() {
    const rawCtx = this.clusterContext;
    if (!rawCtx) {
      runInAction(() => { this.fidelityReport = null; });
      return;
    }

    runInAction(() => { this.isFidelityRunning = true; });

    try {
      const viewMode = this.selectedNamespace === "__all__" ? "all-namespaces" : "single-namespace";
      const rawFormatted = buildRawContextText(rawCtx);
      const compressed = this.ollamaService.buildSystemPrompt(
        compressForPrompt(rawCtx, viewMode),
      );

      const report = await runFidelityEvaluation(
        rawFormatted,
        compressed,
        {
          endpoint: this.ollamaEndpoint,
          model: this.ollamaModel,
          provider: this.apiProvider,
          apiKey: this.openaiApiKey,
          // Pass all known resource names directly from the structured context —
          // avoids regex extraction noise and slice cutoffs.
          knownResourceNames: [
            ...(rawCtx.namespaces ?? []),
            ...rawCtx.pods.map((p) => p.name),
            ...rawCtx.deployments.map((d) => d.name),
            ...rawCtx.services.map((s) => s.name),
            ...rawCtx.nodes.map((n) => n.name),
          ],
        },
      );

      runInAction(() => { this.fidelityReport = report; });
    } catch (e: any) {
      console.error("[Fidelity] Evaluation failed:", e?.message);
    } finally {
      runInAction(() => { this.isFidelityRunning = false; });
    }
  }

  getDataSourceStatus(): Array<{ name: string; status: "ready" | "partial" | "missing"; detail: string }> {
    const c = this.clusterContext;

    // Live context freshness
    const contextAge = c?.gatheredAt != null ? Date.now() - c.gatheredAt : null;
    const contextAgeStr = contextAge !== null
      ? (contextAge < 60_000 ? `${Math.round(contextAge / 1000)}s ago` : `${Math.round(contextAge / 60_000)}m ago`)
      : null;
    const liveDetail = c ? `live · ${contextAgeStr} · pods=${c.pods.length}` : "Not gathered yet";
    const liveStatus: "ready" | "partial" | "missing" = c ? "ready" : "missing";

    if (!c) {
      return [
        { name: "Cluster Context", status: "missing", detail: "Not gathered yet" },
        { name: "Conversation Memory", status: this.messages.length > 0 ? "partial" : "missing", detail: `${this.messages.length} messages` },
      ];
    }

    const podDetail = c.totalPods != null && c.totalPods > c.pods.length
      ? `${c.pods.length} relevant of ${c.totalPods} total`
      : `${c.pods.length} loaded`;
    const depDetail = c.totalDeployments != null && c.totalDeployments > c.deployments.length
      ? `${c.deployments.length} relevant of ${c.totalDeployments} total`
      : `${c.deployments.length} loaded`;

    return [
      { name: "Cluster Context", status: liveStatus, detail: liveDetail },
      { name: "Pods", status: c.pods.length > 0 ? "ready" : "missing", detail: podDetail },
      { name: "Deployments", status: c.deployments.length > 0 ? "ready" : "missing", detail: depDetail },
      { name: "Services", status: c.services.length > 0 ? "ready" : "missing", detail: `${c.services.length} loaded` },
      { name: "Nodes", status: c.nodes.length > 0 ? "ready" : "missing", detail: `${c.nodes.length} loaded` },
      { name: "Events", status: c.events.length > 0 ? "ready" : "missing", detail: `${c.events.length} loaded` },
      {
        name: "Event Correlation",
        status: c.events.length >= 3 ? "ready" : c.events.length > 0 ? "partial" : "missing",
        detail: c.events.length >= 3 ? "Multi-signal correlation active" : c.events.length > 0 ? "Sparse events" : "No event signals",
      },
      { name: "Conversation Memory", status: this.messages.length > 0 ? "ready" : "partial", detail: `${this.messages.length} messages` },
    ];
  }

  buildIncidentSummaryMarkdown(): string {
    const ctx = this.clusterContext;
    const now = new Date().toISOString();
    const warnings = ctx ? ctx.events.filter((e) => e.type === "Warning") : [];
    const assistantMessages = this.messages.filter((m) => m.role === "assistant" && m.content.trim());
    const lastAssistant = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1].content : "No assistant response yet.";

    return [
      "# Incident Summary",
      "",
      `- Generated: ${now}`,
      `- Cluster: ${ctx?.clusterName || "unknown"}`,
      `- Namespace scope: ${this.selectedNamespace === "__all__" ? "all" : this.selectedNamespace}`,
      `- Active mode: ${this.selectedSreMode}`,
      "",
      "## Context Snapshot",
      "",
      `- Pods: ${ctx?.pods.length ?? 0}`,
      `- Deployments: ${ctx?.deployments.length ?? 0}`,
      `- Services: ${ctx?.services.length ?? 0}`,
      `- Nodes: ${ctx?.nodes.length ?? 0}`,
      `- Warning events: ${warnings.length}`,
      "",
      "## Top Warning Events",
      "",
      ...(warnings.length > 0
        ? warnings.slice(0, 10).map((w) => `- [${w.reason}] ${w.involvedObject}: ${w.message}`)
        : ["- None detected"]),
      "",
      "## Assistant Latest Analysis",
      "",
      lastAssistant,
      "",
      "## Conversation Transcript",
      "",
      ...this.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => `### ${m.role.toUpperCase()}\n\n${m.content}\n`),
    ].join("\n");
  }

  exportIncidentSummary(): { ok: boolean; message: string } {
    try {
      const md = this.buildIncidentSummaryMarkdown();
      const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const cluster = (this.clusterContext?.clusterName || "cluster").replace(/\s+/g, "-").toLowerCase();
      const ns = (this.selectedNamespace || "all").replace(/\s+/g, "-").toLowerCase();
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      a.href = url;
      a.download = `incident-summary-${cluster}-${ns}-${ts}.md`;
      a.click();
      URL.revokeObjectURL(url);
      return { ok: true, message: "Incident summary exported" };
    } catch (e: any) {
      return { ok: false, message: `Export failed: ${e?.message || "unknown error"}` };
    }
  }

  buildRunbookMarkdown(): string {
    const ctx = this.clusterContext;
    const now = new Date().toISOString();
    const warningEvents = ctx ? ctx.events.filter((e) => e.type === "Warning") : [];
    const recentUserQuestions = this.messages
      .filter((m) => m.role === "user")
      .slice(-5)
      .map((m) => `- ${m.content}`);
    const latestAssistant = [...this.messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.content.trim())?.content || "No assistant analysis available.";

    return [
      "# SRE Operational Runbook",
      "",
      `- Generated: ${now}`,
      `- Cluster: ${ctx?.clusterName || "unknown"}`,
      `- Namespace scope: ${this.selectedNamespace === "__all__" ? "all" : this.selectedNamespace}`,
      `- Active mode: ${this.selectedSreMode}`,
      "",
      "## Trigger and Scope",
      "",
      ...(recentUserQuestions.length > 0 ? recentUserQuestions : ["- No explicit trigger question found."]),
      "",
      "## Signals",
      "",
      `- Warning events: ${warningEvents.length}`,
      `- Pods in view: ${ctx?.pods.length ?? 0}`,
      `- Deployments in view: ${ctx?.deployments.length ?? 0}`,
      "",
      "## Triage Checklist",
      "",
      "- [ ] Confirm blast radius (namespaces, workloads, user impact)",
      "- [ ] Verify top warning events and affected objects",
      "- [ ] Check rollout/replica status for impacted deployments",
      "- [ ] Validate pod/container state and recent restart patterns",
      "- [ ] Capture evidence before any change",
      "",
      "## Candidate Actions (Read-First)",
      "",
      "- [ ] Run non-mutating checks first (describe/get/logs/events)",
      "- [ ] Define rollback path before mutating actions",
      "- [ ] Use dry-run for manifests/patches",
      "",
      "## Latest Assistant Analysis",
      "",
      latestAssistant,
      "",
      "## Verification",
      "",
      "- [ ] Confirm warning/event reduction after action",
      "- [ ] Confirm workload availability and readiness",
      "- [ ] Confirm no regression in adjacent services",
      "",
      "## Handoff Notes",
      "",
      "- Owner:",
      "- Next checkpoint:",
      "- Escalation criteria:",
    ].join("\n");
  }

  exportRunbook(): { ok: boolean; message: string } {
    try {
      const md = this.buildRunbookMarkdown();
      const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const cluster = (this.clusterContext?.clusterName || "cluster").replace(/\s+/g, "-").toLowerCase();
      const ns = (this.selectedNamespace || "all").replace(/\s+/g, "-").toLowerCase();
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      a.href = url;
      a.download = `sre-runbook-${cluster}-${ns}-${ts}.md`;
      a.click();
      URL.revokeObjectURL(url);
      return { ok: true, message: "Runbook exported" };
    } catch (e: any) {
      return { ok: false, message: `Runbook export failed: ${e?.message || "unknown error"}` };
    }
  }
}

function generateId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
