/**
 * Copyright (c) 2026 Freelens K8s SRE Assistant Authors.
 * Licensed under MIT License.
 *
 * Main SRE Chat Component — uses inline styles for maximum compatibility
 */

import { observer } from "mobx-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ApiProvider, ChatMessage, FidelityReport, OllamaModelParams, ToolsConfig } from "../../common/types";
import { DEFAULT_MODEL_PARAMS } from "../../common/types";
import { ChatStore, type SreModeKey } from "../stores/chat-store";
import { MarkdownRenderer } from "./markdown-renderer";

const chatStore = ChatStore.getInstance();

/* ─── suggestion banks ─────────────────────────────────────────────── */

/** Shown when the user is viewing all namespaces at once. */
const CLUSTER_SUGGESTIONS = [
  "What's the overall health status of this cluster?",
  "Are there pods in CrashLoopBackOff across all namespaces?",
  "Which nodes are under memory or CPU pressure?",
  "Which deployments have unavailable replicas?",
  "Are there pods stuck in Pending state?",
  "Show me all recent Warning events cluster-wide",
  "What's the workload distribution across nodes?",
  "Identify deployments missing resource limits",
  "Are any images using a 'latest' tag — a rollout anti-pattern?",
  "Which pods have the most restarts cluster-wide?",
  "Are any PersistentVolumes in Failed or Released state?",
  "List all HPAs and their current scaling status",
  "Check for Secrets or ConfigMaps referenced but missing",
  "Which namespaces have no running pods?",
  "Are there ingresses pointing to non-existent services?",
  "Identify single points of failure across the cluster",
  "Which services have no healthy endpoints?",
  "Summarize this cluster for a new team member",
  "What workloads have no PodDisruptionBudget?",
  "Show all StatefulSets and their pod readiness",
  "Are there any DaemonSets with missing pods on some nodes?",
  "Which namespaces are consuming the most CPU and memory?",
  "Are there any failed Jobs or CronJob runs?",
  "Check for RBAC misconfigurations or overly permissive roles",
  "Which pods are running as root or with privileged containers?",
];

/** Shown when the user is scoped to a specific namespace. */
const NAMESPACE_SUGGESTIONS = [
  "What's the health of all deployments in this namespace?",
  "Are any pods in this namespace restarting abnormally?",
  "Show me all recent events in this namespace",
  "Check if all referenced ConfigMaps and Secrets exist",
  "Are there any ImagePullBackOff errors here?",
  "Which services have no healthy endpoints in this namespace?",
  "Analyse resource limits vs requests for workloads here",
  "Are there deployments not fully rolled out?",
  "Which containers have no readiness probe configured?",
  "What ingresses are configured and what services do they target?",
  "Show pods with non-zero exit codes or OOMKilled containers",
  "Are any HPAs approaching their maximum replica count?",
  "Are there stale Completed or Evicted pods to clean up?",
  "Summarise this namespace for an on-call handoff",
  "Check for PVC mount issues or unbound volumes",
  "What's the network exposure — ClusterIP vs NodePort vs Ingress?",
  "Identify pods that have been running for less than one hour",
  "Check for liveness probe failure patterns here",
  "Are there any DaemonSets with unavailable pods?",
  "Show environment variable and secret injection problems",
  "Which containers are missing CPU or memory limits?",
  "Are there any services with no matching pod selector?",
  "What's the average pod restart trend over the last hour?",
  "Check for init containers that are crashing at startup",
  "Are there any pods evicted due to resource pressure?",
];

const CAROUSEL_PAGE_SIZE = 5;

function SuggestionCarousel({
  queries,
  onSelect,
}: {
  queries: string[];
  onSelect: (q: string) => void;
}) {
  const [offset, setOffset] = useState(() =>
    Math.floor(Math.random() * queries.length),
  );

  useEffect(() => {
    const id = setInterval(() => {
      setOffset((o) => (o + CAROUSEL_PAGE_SIZE) % queries.length);
    }, 60_000);
    return () => clearInterval(id);
  }, [queries.length]);

  const page = Array.from({ length: CAROUSEL_PAGE_SIZE }, (_, i) =>
    queries[(offset + i) % queries.length],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" }}>
      <div style={S.suggestions}>
        {page.map((q) => (
          <button key={q} style={S.sugBtn} onClick={() => onSelect(q)}>
            {q}
          </button>
        ))}
      </div>
      <span style={{ fontSize: "10px", color: "var(--textColorSecondary, #a6adc8)", opacity: 0.45, letterSpacing: "0.02em" }}>
        suggestions rotate every minute
      </span>
    </div>
  );
}

const SRE_MODE_OPTIONS = [
  { key: "auto", label: "🧭 Auto" },
  { key: "troubleshoot", label: "🛠 Troubleshoot" },
  { key: "security", label: "🔐 Security" },
  { key: "cost", label: "💸 Cost" },
  { key: "capacity", label: "📈 Capacity" },
  { key: "yaml", label: "📄 YAML" },
] as const;

type PanelAnchor = {
  top: number;
  left: number;
};

function buildPanelStyle(anchor: PanelAnchor | null, width: number, root: HTMLDivElement | null): React.CSSProperties {
  const fallbackTop = 52;
  const fallbackLeft = 12;

  if (!anchor || !root) {
    return {
      ...pS.panel,
      width: `${width}px`,
      top: `${fallbackTop}px`,
      left: `${fallbackLeft}px`,
      right: "auto",
    };
  }

  const maxLeft = Math.max(8, root.clientWidth - width - 8);
  const clampedLeft = Math.min(Math.max(8, anchor.left), maxLeft);
  const maxTop = Math.max(52, root.clientHeight - 120);
  const clampedTop = Math.min(Math.max(52, anchor.top), maxTop);

  return {
    ...pS.panel,
    width: `${width}px`,
    top: `${clampedTop}px`,
    left: `${clampedLeft}px`,
    right: "auto",
  };
}

function extractEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint.replace(/^https?:\/\//i, "");
  }
}

function providerLabel(provider: ApiProvider): string {
  return provider === "ollama" ? "Ollama" : "OpenAI-compatible";
}

function buildObjectAwarePromptFromUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const kind = params.get("kind");
    const name = params.get("name");
    const namespace = params.get("namespace");
    const reason = params.get("reason");
    if (!kind || !name) return null;
    return [
      `Investigate ${kind}/${name}${namespace ? ` in namespace ${namespace}` : ""}.`,
      reason ? `Context: ${reason}.` : "",
      "Provide root cause hypotheses, immediate checks, and safest next actions.",
    ].filter(Boolean).join(" ");
  } catch {
    return null;
  }
}

/* ────── inline style objects ────── */

const S = {
  root: {
    display: "flex",
    flexDirection: "column" as const,
    height: "100%",
    position: "relative" as const,
    background: "var(--mainBackground, #1e1e2e)",
    color: "var(--textColorPrimary, #cdd6f4)",
    fontFamily: "var(--font-main, Roboto, sans-serif)",
    overflow: "hidden",
    paddingBottom: "40px",
    boxSizing: "border-box" as const,
  },
  titleBar: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 16px",
    background: "linear-gradient(to right, #181825, #1e1e2e)",
    borderBottom: "1px solid var(--borderColor, #313244)",
    flexShrink: 0 as const,
    minHeight: "42px",
  },
  headerLeft: {
    display: "flex",
    // Note: headerLeft kept for back button grouping, now inside titleBar
    alignItems: "center",
    gap: "8px",
  },
  backBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    border: "1px solid var(--borderColor, #313244)",
    borderRadius: "6px",
    background: "transparent",
    color: "var(--textColorSecondary, #a6adc8)",
    fontSize: "14px",
    cursor: "pointer",
    flexShrink: 0,
    padding: 0,
    lineHeight: 1,
  },
  headerTitle: {
    margin: 0,
    fontSize: "15px",
    fontWeight: 600,
    color: "var(--textColorPrimary, #cdd6f4)",
  },
  // headerActions removed; toolbar row is now a separate div using .sre-toolbar CSS class
  badge: (ok: boolean) => ({
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    padding: "3px 10px",
    borderRadius: "12px",
    fontSize: "11px",
    fontWeight: 500,
    background: ok ? "rgba(166,227,161,.12)" : "rgba(243,139,168,.12)",
    color: ok ? "#a6e3a1" : "#f38ba8",
  }),
  dot: (ok: boolean) => ({
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: ok ? "#a6e3a1" : "#f38ba8",
    display: "inline-block",
  }),
  btn: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "4px 10px",
    border: "1px solid var(--borderColor, #313244)",
    borderRadius: "6px",
    background: "transparent",
    color: "var(--textColorSecondary, #a6adc8)",
    fontSize: "11px",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  modelSelect: {
    padding: "3px 8px",
    border: "1px solid var(--borderColor, #313244)",
    borderRadius: "6px",
    background: "var(--mainBackground, #1e1e2e)",
    color: "var(--textColorPrimary, #cdd6f4)",
    fontSize: "11px",
    outline: "none" as const,
    cursor: "pointer",
    maxWidth: "180px",
  },
  modeSelect: {
    padding: "3px 8px",
    border: "1px solid var(--borderColor, #313244)",
    borderRadius: "6px",
    background: "var(--mainBackground, #1e1e2e)",
    color: "#f9e2af",
    fontSize: "11px",
    outline: "none" as const,
    cursor: "pointer",
    maxWidth: "170px",
  },
  /* context bar */
  ctx: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 16px",
    background: "rgba(137,180,250,.05)",
    borderBottom: "1px solid var(--borderColor, #313244)",
    fontSize: "12px",
    color: "var(--textColorSecondary, #a6adc8)",
    flexShrink: 0,
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    padding: "2px 8px",
    borderRadius: "10px",
    background: "rgba(137,180,250,.1)",
    color: "#89b4fa",
    fontWeight: 500,
  },
  chipWarn: {
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    padding: "2px 8px",
    borderRadius: "10px",
    background: "rgba(249,226,175,.1)",
    color: "#f9e2af",
    fontWeight: 500,
  },
  chipOk: {
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    padding: "2px 8px",
    borderRadius: "10px",
    background: "rgba(166,227,161,.1)",
    color: "#a6e3a1",
    fontWeight: 500,
  },
  /* error */
  errBanner: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 16px",
    background: "rgba(243,139,168,.08)",
    borderBottom: "1px solid rgba(243,139,168,.18)",
    color: "#f38ba8",
    fontSize: "12px",
    flexShrink: 0,
  },
  /* messages area */
  messages: {
    flex: 1,
    overflowY: "auto" as const,
    padding: "14px 16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: "10px",
  },
  /* welcome */
  welcome: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    padding: "30px 20px",
    textAlign: "center" as const,
    gap: "12px",
  },
  welcomeTitle: { fontSize: "18px", fontWeight: 600, margin: 0 },
  welcomeDesc: {
    color: "var(--textColorSecondary, #a6adc8)",
    fontSize: "13px",
    maxWidth: "480px",
    lineHeight: 1.5,
    margin: 0,
  },
  suggestions: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "8px",
    justifyContent: "center",
    marginTop: "6px",
  },
  quickActionsWrap: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "6px",
    marginTop: "8px",
  },
  quickActionBtn: {
    padding: "6px 10px",
    border: "1px solid rgba(137,180,250,.35)",
    borderRadius: "14px",
    background: "rgba(137,180,250,.07)",
    color: "#89b4fa",
    fontSize: "11px",
    cursor: "pointer",
  },
  inlineHint: {
    fontSize: "11px",
    color: "var(--textColorSecondary, #a6adc8)",
    marginTop: "4px",
  },
  sugBtn: {
    padding: "7px 14px",
    border: "1px solid var(--borderColor, #313244)",
    borderRadius: "16px",
    background: "transparent",
    color: "var(--textColorPrimary, #cdd6f4)",
    fontSize: "12px",
    cursor: "pointer",
  },
  /* message row — width overridden at use-site for popup mode */
  msgRow: (isUser: boolean, popupMode = false) => ({
    display: "flex",
    gap: "8px",
    width: popupMode ? "92%" : "50%",
    alignSelf: isUser ? "flex-end" : "flex-start",
    flexDirection: (isUser ? "row-reverse" : "row") as any,
  }),
  avatar: (isUser: boolean) => ({
    width: 28,
    height: 28,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    fontSize: "13px",
    background: isUser ? "#89b4fa" : "#a6e3a1",
    color: "#1e1e2e",
  }),
  bubble: (isUser: boolean) => ({
    padding: "10px 14px",
    borderRadius: isUser ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
    fontSize: "13px",
    lineHeight: 1.6,
    wordBreak: "break-word" as const,
    background: isUser ? "#89b4fa" : "var(--layoutTabsBackground, #181825)",
    color: isUser ? "#1e1e2e" : "var(--textColorPrimary, #cdd6f4)",
    border: isUser ? "none" : "1px solid var(--borderColor, #313244)",
    overflow: "hidden" as const,
  }),
  cursor: {
    display: "inline-block",
    width: 6,
    height: 14,
    background: "#89b4fa",
    marginLeft: 2,
    verticalAlign: "text-bottom",
    borderRadius: 1,
    animation: "k8s-sre-blink .8s infinite",
  },
  /* input area */
  inputBar: {
    flexShrink: 0,
    borderTop: "1px solid var(--borderColor, #313244)",
    background: "var(--layoutTabsBackground, #181825)",
  },
  inputArea: {
    display: "flex",
    alignItems: "flex-end",
    gap: "8px",
    padding: "10px 16px 14px",
  },
  inputWrap: {
    flex: 1,
    display: "flex",
    border: "1px solid var(--borderColor, #313244)",
    borderRadius: "14px",
    background: "var(--mainBackground, #1e1e2e)",
    overflow: "hidden",
  },
  textarea: {
    flex: 1,
    border: "none",
    background: "transparent",
    color: "var(--textColorPrimary, #cdd6f4)",
    padding: "10px 14px",
    fontSize: "13px",
    fontFamily: "inherit",
    resize: "none" as const,
    outline: "none",
    minHeight: "20px",
    maxHeight: "120px",
    lineHeight: 1.4,
  },
  sendBtnColor: (active: boolean): React.CSSProperties => ({
    background: active ? "#89b4fa" : "var(--borderColor, #313244)",
    color: "#1e1e2e",
  }),
  stopBtnBase: {
    background: "#f38ba8",
    color: "#1e1e2e",
  } as React.CSSProperties,
  exportToast: {
    position: "absolute" as const,
    bottom: "56px",
    right: "16px",
    zIndex: 110,
    background: "rgba(24,24,37,.95)",
    border: "1px solid var(--borderColor, #313244)",
    color: "var(--textColorPrimary, #cdd6f4)",
    padding: "8px 10px",
    borderRadius: "8px",
    fontSize: "11px",
    boxShadow: "0 6px 18px rgba(0,0,0,.35)",
  },
  loadingDots: {
    display: "flex",
    gap: "4px",
    padding: "4px 0",
  },
};

/* Keyframes + toolbar CSS injected once */
const KEYFRAMES = `
@keyframes k8s-sre-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.15; }
}
@keyframes k8s-sre-dot {
  0%, 80%, 100% { transform: scale(.5); opacity: .3; }
  40% { transform: scale(1); opacity: 1; }
}
@keyframes k8s-sre-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(243,139,168,.5); }
  50% { opacity: 0.7; box-shadow: 0 0 0 3px rgba(243,139,168,0); }
}

/* ── Toolbar ── */
.sre-title-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: linear-gradient(to right, #181825, #1e1e2e);
  border-bottom: 1px solid var(--borderColor, #313244);
  flex-shrink: 0;
  min-height: 42px;
}
.sre-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 16px;
  background: rgba(17,17,27,.85);
  backdrop-filter: blur(2px);
  border-bottom: 1px solid var(--borderColor, #313244);
  box-shadow: 0 2px 8px rgba(0,0,0,.2);
  flex-shrink: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
  scrollbar-color: #313244 transparent;
}
.sre-toolbar::-webkit-scrollbar {
  height: 3px;
}
.sre-toolbar::-webkit-scrollbar-track {
  background: transparent;
}
.sre-toolbar::-webkit-scrollbar-thumb {
  background: #313244;
  border-radius: 2px;
}
.sre-toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--borderColor, #313244);
  border-radius: 6px;
  background: transparent;
  color: var(--textColorSecondary, #a6adc8);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.sre-toolbar-btn:hover:not(:disabled) {
  background: rgba(137,180,250,.1);
  border-color: rgba(137,180,250,.4);
  color: #89b4fa;
}
.sre-toolbar-btn:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}
.sre-toolbar-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 500;
  border: none;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: opacity 0.15s, box-shadow 0.15s;
}
.sre-toolbar-badge:hover {
  opacity: 0.85;
  box-shadow: 0 0 0 2px rgba(137,180,250,.25);
}
.sre-toolbar-select {
  padding: 4px 8px;
  border: 1px solid var(--borderColor, #313244);
  border-radius: 6px;
  background: var(--mainBackground, #1e1e2e);
  color: var(--textColorPrimary, #cdd6f4);
  font-size: 11px;
  font-family: inherit;
  outline: none;
  cursor: pointer;
  flex-shrink: 0;
  transition: border-color 0.15s;
}
.sre-toolbar-select:hover:not(:disabled) {
  border-color: rgba(137,180,250,.4);
}
.sre-toolbar-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.sre-toolbar-sep {
  width: 1px;
  height: 16px;
  background: rgba(137,180,250,.2);
  margin: 0 4px;
  flex-shrink: 0;
  align-self: center;
}
.sre-send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  flex-shrink: 0;
  transition: box-shadow 0.15s, opacity 0.15s;
}
.sre-send-btn:hover:not(:disabled) {
  box-shadow: 0 0 0 3px rgba(137,180,250,.3);
}
.sre-send-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
`;

/* ────── Components ────── */

export const SreChat = observer(function SreChat({ onClose, popup = false }: { onClose?: () => void; popup?: boolean } = {}) {
  const [input, setInput] = useState("");
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // scroll to bottom on new content
  const lastMsg = chatStore.lastMessage;
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatStore.messages.length, lastMsg?.content, chatStore.pendingToolApproval]);

  // connect on mount
  useEffect(() => {
    chatStore.checkConnection();
    chatStore.refreshClusterContext();
    const iv = setInterval(() => chatStore.checkConnection(), 30000);
    return () => clearInterval(iv);
  }, []);

  // Object-aware entry point: if URL contains kind/name/ns, pre-fill investigation prompt
  useEffect(() => {
    const prompt = buildObjectAwarePromptFromUrl();
    if (prompt) setInput(prompt);
  }, []);

  // Workload analysis trigger: when pendingAnalysis is set by a context-menu /
  // detail-panel button, auto-send it as if the user typed it.
  useEffect(() => {
    if (chatStore.pendingAnalysis) {
      const prompt = chatStore.consumePendingAnalysis();
      if (prompt) {
        chatStore.sendMessage(prompt);
      }
    }
  }, [chatStore.pendingAnalysis]);

  const send = useCallback(async () => {
    if (!input.trim() || chatStore.isLoading) return;
    const msg = input;
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
    await chatStore.sendMessage(msg);
  }, [input]);

  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    },
    [send],
  );

  const onTaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, []);

  const [showParams, setShowParams] = useState(false);
  const [showConnection, setShowConnection] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [showFidelity, setShowFidelity] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [fidelityAnchor, setFidelityAnchor] = useState<PanelAnchor | null>(null);
  const [paramsAnchor, setParamsAnchor] = useState<PanelAnchor | null>(null);
  const [connectionAnchor, setConnectionAnchor] = useState<PanelAnchor | null>(null);
  const [statsAnchor, setStatsAnchor] = useState<PanelAnchor | null>(null);
  const [sourcesAnchor, setSourcesAnchor] = useState<PanelAnchor | null>(null);
  const [toolsAnchor, setToolsAnchor] = useState<PanelAnchor | null>(null);
  const connected = chatStore.isOllamaConnected;
  const provider = chatStore.apiProvider;
  const providerName = providerLabel(provider);
  const ctx = chatStore.clusterContext;
  const warnCount = ctx ? ctx.events.filter((ev) => ev.type === "Warning").length : 0;
  const endpointHost = extractEndpointHost(chatStore.ollamaEndpoint);

  const getAnchor = useCallback((el: HTMLElement): PanelAnchor => {
    const rootRect = rootRef.current?.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    return {
      top: rect.bottom - (rootRect?.top ?? 0) + 8,
      left: rect.left - (rootRect?.left ?? 0),
    };
  }, []);

  const handleExport = useCallback(() => {
    const result = chatStore.exportIncidentSummary();
    setExportNotice(result.message);
    window.setTimeout(() => setExportNotice(null), 2400);
  }, []);

  const handleRunbookExport = useCallback(() => {
    const result = chatStore.exportRunbook();
    setExportNotice(result.message);
    window.setTimeout(() => setExportNotice(null), 2400);
  }, []);

  const toggleConnectionPanel = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setConnectionAnchor(getAnchor(e.currentTarget));
    setShowConnection((p) => !p);
  }, [getAnchor]);

  const toggleParamsPanel = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setParamsAnchor(getAnchor(e.currentTarget));
    setShowParams((p) => !p);
  }, [getAnchor]);

  const toggleStatsPanel = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setStatsAnchor(getAnchor(e.currentTarget));
    setShowStats((p) => !p);
  }, [getAnchor]);

  const toggleSourcesPanel = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setSourcesAnchor(getAnchor(e.currentTarget));
    setShowSources((p) => !p);
  }, [getAnchor]);

  const toggleFidelityPanel = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setFidelityAnchor(getAnchor(e.currentTarget));
    setShowFidelity((p) => !p);
  }, [getAnchor]);

  const toggleToolsPanel = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setToolsAnchor(getAnchor(e.currentTarget));
    setShowTools((p) => !p);
  }, [getAnchor]);

  const paramsPanelStyle = buildPanelStyle(paramsAnchor, 320, rootRef.current);
  const connectionPanelStyle = buildPanelStyle(connectionAnchor, 320, rootRef.current);
  const statsPanelStyle = buildPanelStyle(statsAnchor, 300, rootRef.current);
  const sourcesPanelStyle = buildPanelStyle(sourcesAnchor, 320, rootRef.current);
  const fidelityPanelStyle = buildPanelStyle(fidelityAnchor, 480, rootRef.current);
  const toolsPanelStyle = buildPanelStyle(toolsAnchor, 280, rootRef.current);

  return (
    <div style={S.root} ref={rootRef}>
      {/* inject keyframes */}
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />

      {/* ── Title Bar ── */}
      <div className="sre-title-bar">
        <button
          style={S.backBtn}
          onClick={onClose ?? (() => window.history.back())}
          title={onClose ? "Close panel" : "Back to cluster"}
        >
          {onClose ? "✕" : "←"}
        </button>
        <span style={{ fontSize: "18px" }}>🤖</span>
        <h2 style={S.headerTitle}>K8s SRE Assistant</h2>
      </div>

      {/* ── Toolbar ── */}
      <div className="sre-toolbar">
        {/* Connection badge */}
        <button
          className="sre-toolbar-badge"
          style={S.badge(connected)}
          onClick={toggleConnectionPanel}
          title="Connection settings"
        >
          <span
            style={{
              ...S.dot(connected),
              animation: connected ? undefined : "k8s-sre-pulse 1.8s infinite",
            }}
          />
          {connected ? `${providerName} · ${endpointHost}` : "Disconnected"}
        </button>

        {/* Model select — always visible; disabled + shows last model when disconnected */}
        <select
          className="sre-toolbar-select"
          style={{ maxWidth: "185px", color: connected ? "var(--textColorPrimary, #cdd6f4)" : "var(--textColorSecondary, #a6adc8)" }}
          value={chatStore.ollamaModel}
          onChange={(e) => chatStore.setModel(e.target.value)}
          title="Select AI model"
          disabled={!connected || chatStore.availableModels.length === 0}
        >
          {chatStore.availableModels.length > 0
            ? chatStore.availableModels.map((m) => (
                <option key={m.name} value={m.name}>🧠 {m.name}</option>
              ))
            : <option value={chatStore.ollamaModel}>🧠 {chatStore.ollamaModel}</option>
          }
        </select>

        {/* SRE mode select */}
        <select
          className="sre-toolbar-select"
          style={{ maxWidth: "175px", color: "#f9e2af" }}
          value={chatStore.selectedSreMode}
          onChange={(e) => chatStore.setSelectedSreMode(e.target.value as SreModeKey)}
          title="SRE mode"
        >
          {SRE_MODE_OPTIONS.map((m) => (
            <option key={m.key} value={m.key}>{m.label}</option>
          ))}
        </select>

        {/* ⚙️ Model params — always visible, disabled when not connected */}
        <button
          className="sre-toolbar-btn"
          onClick={toggleParamsPanel}
          title="Model parameters"
          disabled={!connected}
        >
          ⚙️
        </button>

        {/* 🔧 Tools */}
        <button
          className="sre-toolbar-btn"
          onClick={toggleToolsPanel}
          title="K8s tool calling"
          style={chatStore.toolsConfig.enabled ? { color: "#a6e3a1", borderColor: "rgba(166,227,161,.3)" } : undefined}
        >
          🔧 Tools{!chatStore.toolsConfig.enabled ? " · OFF" : ""}
        </button>

        {/* ⚡ Stats — always visible, disabled when no stats yet */}
        <button
          className="sre-toolbar-btn"
          onClick={toggleStatsPanel}
          title="Last response performance stats"
          disabled={!chatStore.lastPerformanceStats}
          style={chatStore.lastPerformanceStats ? { color: "#a6e3a1", borderColor: "rgba(166,227,161,.3)" } : undefined}
        >
          ⚡ {chatStore.lastPerformanceStats ? `${chatStore.lastPerformanceStats.tokensPerSec} t/s` : "—"}
        </button>

        <span className="sre-toolbar-sep" />

        {/* 🔄 Refresh */}
        <button
          className="sre-toolbar-btn"
          onClick={() => chatStore.refreshClusterContext()}
          disabled={chatStore.isGatheringContext}
          title="Refresh cluster context"
        >
          🔄 {chatStore.isGatheringContext ? "Scanning…" : "Refresh"}
        </button>

        {/* 🧰 Sources */}
        <button
          className="sre-toolbar-btn"
          onClick={toggleSourcesPanel}
          title="Data sources visibility"
        >
          🧰 Sources
        </button>

        {/* 🔬 Fidelity — neutral color; score shown inline when report exists */}
        <button
          className="sre-toolbar-btn"
          onClick={toggleFidelityPanel}
          title="Model Fidelity Evaluation"
        >
          🔬 Fidelity
          {chatStore.fidelityReport && (
            <span style={{ color: "#89b4fa", fontWeight: 700, marginLeft: 2 }}>
              {Math.round(chatStore.fidelityReport.score * 100)}%
            </span>
          )}
        </button>

        <span className="sre-toolbar-sep" />

        {/* 📚 Runbook — always visible, disabled when no messages */}
        <button
          className="sre-toolbar-btn"
          onClick={handleRunbookExport}
          disabled={!chatStore.hasMessages}
          title="Export runbook"
        >
          📚 Runbook
        </button>

        {/* 📄 Export — always visible, disabled when no messages */}
        <button
          className="sre-toolbar-btn"
          onClick={handleExport}
          disabled={!chatStore.hasMessages}
          title="Export incident summary"
        >
          📄 Export
        </button>

        {/* 🗑️ Clear — always visible, disabled when no messages */}
        <button
          className="sre-toolbar-btn"
          onClick={() => chatStore.clearMessages()}
          disabled={!chatStore.hasMessages}
          title="Clear conversation"
        >
          🗑️ Clear
        </button>
      </div>

      {/* ── Params panel (same context) ── */}
      {showParams && <ModelParamsPanel onClose={() => setShowParams(false)} panelStyle={paramsPanelStyle} />}

      {/* ── Tools panel ── */}
      {showTools && <ToolsPanel onClose={() => setShowTools(false)} panelStyle={toolsPanelStyle} />}

      {/* ── Connection panel (same context) ── */}
      {showConnection && <ConnectionPanel onClose={() => setShowConnection(false)} panelStyle={connectionPanelStyle} />}

      {/* ── Performance stats panel ── */}
      {showStats && <StatsPanel onClose={() => setShowStats(false)} panelStyle={statsPanelStyle} />}

      {/* ── Data source visibility panel ── */}
      {showSources && <SourcesPanel onClose={() => setShowSources(false)} panelStyle={sourcesPanelStyle} />}

      {/* ── Fidelity evaluation panel ── */}
      {showFidelity && <FidelityPanel onClose={() => setShowFidelity(false)} panelStyle={fidelityPanelStyle} />}

      {/* ── Context bar ── */}
      {(ctx || chatStore.isGatheringContext) && (
        <div style={S.ctx}>
          <span>📡</span>
          <span style={S.chip}>{ctx?.clusterName ?? "Loading…"}</span>
          {/* Namespace selector */}
          <select
            style={{
              padding: "2px 8px",
              border: "1px solid var(--borderColor, #313244)",
              borderRadius: "10px",
              background: "var(--mainBackground, #1e1e2e)",
              color: "#89b4fa",
              fontSize: "11px",
              fontWeight: 500,
              outline: "none",
              cursor: "pointer",
              maxWidth: "200px",
            }}
            value={chatStore.selectedNamespace}
            onChange={(e) => chatStore.setSelectedNamespace(e.target.value)}
            title="Filter context by namespace"
            disabled={chatStore.isGatheringContext}
          >
            <option value="__all__">📦 All Namespaces</option>
            {chatStore.availableNamespaces.map((ns) => (
              <option key={ns} value={ns}>
                📁 {ns}
              </option>
            ))}
          </select>
          {chatStore.isGatheringContext ? (
            <span style={{ fontSize: "11px", color: "var(--textColorSecondary, #a6adc8)" }}>
              ⏳ Refreshing context…
            </span>
          ) : ctx ? (
            <>
              <span style={{ ...S.chip, background: "rgba(137,180,250,.08)" }}>
                {ctx.pods.length} pods
              </span>
              <span style={{ ...S.chip, background: "rgba(137,180,250,.08)" }}>
                {ctx.deployments.length} deploy
              </span>
              {warnCount > 0 ? (
                <span style={S.chipWarn}>⚠️ {warnCount} Warning{warnCount > 1 ? "s" : ""}</span>
              ) : (
                <span style={S.chipOk}>✓ Healthy</span>
              )}
            </>
          ) : null}
        </div>
      )}

      {/* ── Error banner ── */}
      {chatStore.error && (
        <div style={S.errBanner}>
          <span style={{ flex: 1 }}>⚠️ {chatStore.error}</span>
          <button style={{ background: "none", border: "none", color: "#f38ba8", cursor: "pointer", fontSize: "14px" }} onClick={() => chatStore.setError(null)}>✕</button>
        </div>
      )}

      {/* ── Messages ── */}
      <div style={S.messages}>
        {!chatStore.hasMessages ? (
          <div style={S.welcome}>
            <span style={{ fontSize: "48px", opacity: 0.5 }}>🤖</span>
            <h3 style={S.welcomeTitle}>Kubernetes SRE Assistant</h3>
            <p style={S.welcomeDesc}>
              I'm your AI-powered SRE assistant. I can see your cluster's pods, deployments,
              services, nodes, and events. Ask me anything about your Kubernetes infrastructure!
            </p>
            {!connected && (
              <p style={{ ...S.welcomeDesc, color: "#f38ba8" }}>
                ⚠️ {providerName} not connected — click the <strong>Disconnected</strong> badge above to configure
              </p>
            )}
            <div style={S.suggestions}>
              <SuggestionCarousel
                queries={chatStore.selectedNamespace === "__all__" ? CLUSTER_SUGGESTIONS : NAMESPACE_SUGGESTIONS}
                onSelect={(q) => { setInput(q); taRef.current?.focus(); }}
              />
            </div>
          </div>
        ) : (
          <>
            {chatStore.messages.map((m) => (
              <MsgBubble key={m.id} message={m} popup={popup} />
            ))}
            {chatStore.pendingToolApproval && (() => {
              const approval = chatStore.pendingToolApproval!;
              const isSensitive = approval.toolName === "get_pod_logs";
              const accent = isSensitive ? "#f9e2af" : "#89b4fa";
              const bg     = isSensitive ? "rgba(249,226,175,.07)" : "rgba(137,180,250,.07)";
              const icon   = isSensitive ? "🔐" : "🔧";
              const title  = isSensitive ? "Log access request" : "Tool call";
              return (
                <div style={S.msgRow(false, popup)}>
                  <div style={S.avatar(false)}>{icon}</div>
                  <div style={{ ...S.bubble(false), border: `1px solid ${accent}`, background: bg, maxWidth: "100%" }}>
                    <div style={{ fontWeight: 600, marginBottom: 6, color: accent, fontSize: "12px" }}>
                      {title} — {approval.toolName}({Object.entries(approval.args).map(([k, v]) => `${k}=${v}`).join(", ")})
                    </div>
                    {approval.modelRationale && (
                      <div style={{ fontSize: "12px", color: "var(--textColorSecondary, #a6adc8)", marginBottom: 10, maxHeight: 80, overflow: "hidden" }}>
                        {approval.modelRationale.slice(-400)}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => chatStore.approvePendingTool()} style={{ padding: "5px 14px", borderRadius: 8, border: "1px solid #a6e3a1", background: "rgba(166,227,161,.15)", color: "#a6e3a1", cursor: "pointer", fontSize: "12px", fontWeight: 600 }}>✓ Approve</button>
                      <button onClick={() => chatStore.denyPendingTool()}    style={{ padding: "5px 14px", borderRadius: 8, border: "1px solid #f38ba8", background: "rgba(243,139,168,.1)",  color: "#f38ba8", cursor: "pointer", fontSize: "12px", fontWeight: 600 }}>✗ Deny</button>
                    </div>
                  </div>
                </div>
              );
            })()}
            {chatStore.isLoading && chatStore.lastMessage?.role !== "assistant" && (
              <div style={S.msgRow(false, popup)}>
                <div style={S.avatar(false)}>🤖</div>
                <div style={S.bubble(false)}>
                  <LoadingDots />
                </div>
              </div>
            )}
            <div ref={endRef} />
          </>
        )}
      </div>

      {/* ── Input bar ── */}
      <div style={S.inputBar}>
        {chatStore.hasMessages && (
          <div style={{ padding: "4px 16px 0" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: suggestionsOpen ? 4 : 0 }}>
              <div style={S.inlineHint}>Suggested next actions</div>
              <button
                onClick={() => setSuggestionsOpen((o) => !o)}
                title={suggestionsOpen ? "Hide suggestions" : "Show suggestions"}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--textColorSecondary, #a6adc8)", fontSize: "13px", padding: "0 2px", lineHeight: 1 }}
              >
                {suggestionsOpen ? "▾" : "▸"}
              </button>
            </div>
            {suggestionsOpen && (
              <SuggestionCarousel
                queries={chatStore.selectedNamespace === "__all__" ? CLUSTER_SUGGESTIONS : NAMESPACE_SUGGESTIONS}
                onSelect={(a) => {
                  if (a.toLowerCase().includes("runbook")) {
                    const result = chatStore.exportRunbook();
                    setExportNotice(result.message);
                    window.setTimeout(() => setExportNotice(null), 2400);
                  } else {
                    setInput(a);
                    taRef.current?.focus();
                  }
                }}
              />
            )}
          </div>
        )}
        <div style={S.inputArea}>
          <div style={S.inputWrap}>
            <textarea
              ref={taRef}
              style={S.textarea}
              value={input}
              onChange={onTaChange}
              onKeyDown={onKey}
              placeholder={connected ? "Ask about your cluster… (Shift+Enter for new line)" : `Connect to ${providerName} first (see Preferences)…`}
              disabled={!connected}
              rows={1}
            />
          </div>
          {chatStore.isLoading ? (
            <button
              className="sre-send-btn"
              style={S.stopBtnBase}
              onClick={() => chatStore.cancelStream()}
              title="Stop"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
            </button>
          ) : (
            <button
              className="sre-send-btn"
              style={S.sendBtnColor(!!input.trim() && connected)}
              onClick={send}
              disabled={!input.trim() || !connected}
              title="Send"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" /></svg>
            </button>
          )}
        </div>
      </div>

      {exportNotice && <div style={S.exportToast}>{exportNotice}</div>}
    </div>
  );
});

/* ── Single message bubble ── */
const MsgBubble = observer(({ message, popup = false }: { message: ChatMessage; popup?: boolean }) => {
  const u = message.role === "user";
  return (
    <div style={S.msgRow(u, popup)}>
      <div style={S.avatar(u)}>{u ? "👤" : "🤖"}</div>
      <div style={S.bubble(u)}>
        {u ? message.content : (
          <>
            <MarkdownRenderer content={message.content} />
            {message.isStreaming && <span style={S.cursor} />}
          </>
        )}
      </div>
    </div>
  );
});

/* ── Loading animation ── */
function LoadingDots() {
  return (
    <div style={S.loadingDots}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 6, height: 6, borderRadius: "50%",
            background: "var(--textColorDimmed, #585b70)",
            animation: `k8s-sre-dot 1.4s infinite ease-in-out both`,
            animationDelay: `${-0.32 + i * 0.16}s`,
          }}
        />
      ))}
    </div>
  );
}

/* ── Model parameters panel (inline, same context) ── */
const pS = {
  overlay: {
    position: "absolute" as const,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 90,
  },
  panel: {
    position: "absolute" as const,
    top: "48px",
    right: "12px",
    zIndex: 100,
    width: "320px",
    maxHeight: "70vh",
    overflowY: "auto" as const,
    background: "var(--layoutTabsBackground, #181825)",
    border: "1px solid var(--borderColor, #313244)",
    borderRadius: "10px",
    boxShadow: "0 8px 32px rgba(0,0,0,.45)",
    padding: "14px 16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: "10px",
  },
  head: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: {
    fontSize: "13px",
    fontWeight: 600,
    color: "var(--textColorPrimary, #cdd6f4)",
    margin: 0,
  },
  close: {
    background: "none",
    border: "none",
    color: "var(--textColorSecondary, #a6adc8)",
    fontSize: "14px",
    cursor: "pointer",
    padding: "2px 6px",
  },
  reset: {
    padding: "3px 10px",
    border: "1px solid var(--borderColor, #313244)",
    borderRadius: "4px",
    background: "transparent",
    color: "var(--textColorSecondary, #a6adc8)",
    fontSize: "10px",
    cursor: "pointer",
  },
  paramLabel: {
    fontSize: "11px",
    fontWeight: 600,
    color: "var(--textColorPrimary, #cdd6f4)",
    margin: 0,
  },
  paramDesc: {
    fontSize: "10px",
    color: "var(--textColorSecondary, #a6adc8)",
    margin: 0,
    lineHeight: 1.3,
  },
  sliderRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  slider: {
    flex: 1,
    cursor: "pointer",
    accentColor: "#89b4fa",
    height: "4px",
  },
  val: {
    minWidth: "36px",
    textAlign: "right" as const,
    fontSize: "12px",
    fontWeight: 600,
    fontFamily: "monospace",
    color: "#89b4fa",
  },
};

const MODEL_PARAMS_CONFIG: Array<{
  key: keyof OllamaModelParams;
  label: string;
  desc: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}> = [
  { key: "temperature", label: "Temperature", desc: "Creativity vs determinism (0 = focused, 2 = creative)", min: 0, max: 2, step: 0.05, format: (v) => v.toFixed(2) },
  { key: "top_p", label: "Top P", desc: "Nucleus sampling threshold (lower = more focused)", min: 0, max: 1, step: 0.05, format: (v) => v.toFixed(2) },
  { key: "top_k", label: "Top K", desc: "Token vocabulary limit (0 = disabled)", min: 0, max: 200, step: 1, format: (v) => String(v) },
  { key: "repeat_penalty", label: "Repeat Penalty", desc: "Penalize repeated tokens", min: 1, max: 2, step: 0.05, format: (v) => v.toFixed(2) },
  { key: "num_predict", label: "Max Tokens", desc: "Max response length (-1 = unlimited)", min: -1, max: 8192, step: 1, format: (v) => v === -1 ? "∞" : String(v) },
];

const TOOL_LABELS: Record<keyof ToolsConfig["tools"], string> = {
  get_namespace_detail: "Namespace detail",
  get_pod_detail: "Pod detail",
  get_resource_events: "Resource events",
  get_deployment_detail: "Deployment detail",
  get_nodes: "Node list",
  get_pod_logs: "Pod logs (HiL)",
  get_resource_chain: "Resource chain",
  list_resources: "List resources",
};

const TOOL_GROUPS: Array<{ label: string; tools: Array<keyof ToolsConfig["tools"]> }> = [
  {
    label: "Inspect",
    tools: ["get_namespace_detail", "get_pod_detail", "get_deployment_detail", "get_resource_events", "get_resource_chain", "get_nodes"],
  },
  {
    label: "List",
    tools: ["list_resources"],
  },
  {
    label: "Sensitive (HiL)",
    tools: ["get_pod_logs"],
  },
];

const ToolsPanel = observer(({ onClose, panelStyle }: { onClose: () => void; panelStyle: React.CSSProperties }) => {
  const tc = chatStore.toolsConfig;

  const onGlobalToggle = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    chatStore.setToolsConfig({ ...tc, enabled: e.target.checked });
  }, [tc]);

  const onToolToggle = useCallback((toolName: keyof ToolsConfig["tools"]) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      chatStore.setToolsConfig({ ...tc, tools: { ...tc.tools, [toolName]: e.target.checked } });
    }, [tc]);

  return (
    <>
      <div style={pS.overlay} onClick={onClose} />
      <div style={panelStyle}>
        <div style={pS.head}>
          <h4 style={pS.title}>🔧 K8s Tool Calling</h4>
          <button style={pS.close} onClick={onClose}>✕</button>
        </div>
        <span style={pS.paramDesc}>
          Tools give the model drill-down access to specific resources.
          Disable globally for small models that loop on tool calls.
        </span>
        <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--textColorPrimary, #cdd6f4)", cursor: "pointer" }}>
          <input type="checkbox" checked={tc.enabled} onChange={onGlobalToggle} />
          Enable tool calling
        </label>
        <div style={{ borderTop: "1px solid var(--borderColor, #313244)", paddingTop: "6px", display: "flex", flexDirection: "column", gap: "10px" }}>
          {TOOL_GROUPS.map((group) => (
            <div key={group.label}>
              <div style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "0.07em", color: "var(--textColorSecondary, #a6adc8)", textTransform: "uppercase", paddingLeft: "4px", marginBottom: "4px" }}>
                {group.label}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                {group.tools.map((toolName) => (
                  <label
                    key={toolName}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      paddingLeft: "10px",
                      fontSize: "11px",
                      color: tc.enabled ? "var(--textColorPrimary, #cdd6f4)" : "var(--textColorSecondary, #a6adc8)",
                      cursor: tc.enabled ? "pointer" : "not-allowed",
                    }}
                  >
                    <input type="checkbox" checked={tc.tools[toolName]} disabled={!tc.enabled} onChange={onToolToggle(toolName)} />
                    {TOOL_LABELS[toolName]}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
});

const ModelParamsPanel = observer(({ onClose, panelStyle }: { onClose: () => void; panelStyle: React.CSSProperties }) => {
  const params = chatStore.modelParams;

  const onChange = useCallback((key: keyof OllamaModelParams, raw: string) => {
    const v = key === "top_k" || key === "num_predict" ? parseInt(raw, 10) : parseFloat(raw);
    chatStore.setModelParams({ [key]: v });
  }, []);

  const reset = useCallback(() => {
    chatStore.setModelParams({ ...DEFAULT_MODEL_PARAMS });
  }, []);

  return (
    <>
      {/* click-away overlay */}
      <div style={pS.overlay} onClick={onClose} />
      <div style={panelStyle}>
        <div style={pS.head}>
          <h4 style={pS.title}>⚙️ Model Parameters</h4>
          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <button style={pS.reset} onClick={reset}>Reset</button>
            <button style={pS.close} onClick={onClose}>✕</button>
          </div>
        </div>
        {MODEL_PARAMS_CONFIG.map((p) => (
          <div key={p.key} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            <span style={pS.paramLabel}>{p.label}</span>
            <span style={pS.paramDesc}>{p.desc}</span>
            <div style={pS.sliderRow}>
              <input
                style={pS.slider}
                type="range"
                min={p.min}
                max={p.max}
                step={p.step}
                value={params[p.key]}
                onChange={(e) => onChange(p.key, e.target.value)}
              />
              <span style={pS.val}>{p.format(params[p.key])}</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
});

/* ── Connection panel (inline, same context) ── */
const ConnectionPanel = observer(({ onClose, panelStyle }: { onClose: () => void; panelStyle: React.CSSProperties }) => {
  const [endpoint, setEndpoint] = useState(chatStore.ollamaEndpoint);
  const [apiKey, setApiKey] = useState(chatStore.openaiApiKey);
  const [testing, setTesting] = useState(false);
  const [debugInfo, setDebugInfo] = useState("");
  const [status, setStatus] = useState<"idle" | "ok" | "error">("idle");

  const testConnection = useCallback(async () => {
    setTesting(true);
    setStatus("idle");
    setDebugInfo("Starting connection test…");
    const ep = endpoint.replace(/\/+$/, "");
    chatStore.setEndpoint(ep);
    chatStore.setOpenAIApiKey(apiKey);
    setEndpoint(ep);

    const logs: string[] = ["Testing endpoint with auto-detection…"];

    try {
      logs.push("Using Node.js HTTP (bypasses mixed-content)…");
      setDebugInfo(logs.join("\n"));

      // Let ChatStore/Service detect whether endpoint is Ollama or OpenAI-compatible.
      await chatStore.checkConnection();
      const modelList = chatStore.availableModels;
      const provider = chatStore.apiProvider;

      if (!chatStore.isOllamaConnected) {
        throw new Error(`Endpoint not reachable as Ollama or OpenAI-compatible API`);
      }

      logs.push(`Detected provider: ${providerLabel(provider)}`);
      logs.push(`✓ Connected. Models: ${modelList.length}`);
      if (modelList.length > 0) {
        logs.push(modelList.map((m: any) => m.name).join(", "));
      } else {
        logs.push("⚠ No models returned by endpoint");
      }
      setDebugInfo(logs.join("\n"));
      setStatus("ok");

      if (modelList.length > 0 && !modelList.find((m: any) => m.name === chatStore.ollamaModel)) {
        chatStore.setModel(modelList[0].name);
      }
    } catch (e: any) {
      logs.push(`✕ FAILED: ${e.message}`);
      logs.push("Hints:");
      logs.push("- Verify endpoint is reachable");
      logs.push("- For Ollama ensure /api/tags is available");
      logs.push("- For OpenAI-compatible ensure /v1/models is available");
      logs.push("- If required, set a valid API key");
      setDebugInfo(logs.join("\n"));
      setStatus("error");
    } finally {
      setTesting(false);
    }
  }, [apiKey, endpoint]);

  return (
    <>
      <div style={pS.overlay} onClick={onClose} />
      <div style={panelStyle}>
        <div style={pS.head}>
          <h4 style={pS.title}>🔌 Model Connection</h4>
          <button style={pS.close} onClick={onClose}>✕</button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <span style={pS.paramLabel}>Endpoint</span>
          <input
            style={{
              padding: "6px 10px",
              border: "1px solid var(--borderColor, #313244)",
              borderRadius: "6px",
              background: "var(--mainBackground, #1e1e2e)",
              color: "var(--textColorPrimary, #cdd6f4)",
              fontSize: "12px",
              outline: "none",
              width: "100%",
              boxSizing: "border-box" as const,
            }}
            type="text"
            value={endpoint}
            onChange={(e) => { setEndpoint(e.target.value); chatStore.setEndpoint(e.target.value); }}
            placeholder="http://localhost:11434"
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <span style={pS.paramLabel}>API Key (optional)</span>
          <input
            style={{
              padding: "6px 10px",
              border: "1px solid var(--borderColor, #313244)",
              borderRadius: "6px",
              background: "var(--mainBackground, #1e1e2e)",
              color: "var(--textColorPrimary, #cdd6f4)",
              fontSize: "12px",
              outline: "none",
              width: "100%",
              boxSizing: "border-box" as const,
            }}
            type="password"
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); chatStore.setOpenAIApiKey(e.target.value); }}
            placeholder="sk-..."
          />
        </div>

        <button
          style={{
            padding: "6px 14px",
            border: "1px solid var(--colorInfo, #89b4fa)",
            borderRadius: "6px",
            background: "var(--colorInfo, #89b4fa)",
            color: "#1e1e2e",
            fontSize: "12px",
            fontWeight: 600,
            cursor: testing ? "wait" : "pointer",
            width: "100%",
          }}
          onClick={testConnection}
          disabled={testing}
        >
          {testing ? "Testing…" : "Test Connection"}
        </button>

        {status === "ok" && (
          <span style={{ color: "#a6e3a1", fontSize: "11px", fontWeight: 500 }}>
            ✓ Connected — {chatStore.availableModels.length} model{chatStore.availableModels.length !== 1 ? "s" : ""} found
          </span>
        )}
        {status === "error" && (
          <span style={{ color: "#f38ba8", fontSize: "11px", fontWeight: 500 }}>
            ✕ Connection failed
          </span>
        )}

        {debugInfo && (
          <pre style={{
            fontSize: "10px",
            fontFamily: "monospace",
            background: "rgba(0,0,0,.3)",
            color: "#a6adc8",
            padding: "8px",
            borderRadius: "4px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all" as const,
            maxHeight: "180px",
            overflow: "auto",
            margin: 0,
          }}>{debugInfo}</pre>
        )}
      </div>
    </>
  );
});

/* ── Performance Stats panel ── */
const statRow = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "4px 0",
  borderBottom: "1px solid rgba(49,50,68,.5)",
};
const statLabel = {
  fontSize: "11px",
  color: "var(--textColorSecondary, #a6adc8)",
};
const statValue = {
  fontSize: "12px",
  fontWeight: 600,
  fontFamily: "monospace",
  color: "#89b4fa",
};
const statHighlight = {
  fontSize: "14px",
  fontWeight: 700,
  fontFamily: "monospace",
  color: "#a6e3a1",
};

const StatsPanel = observer(({ onClose, panelStyle }: { onClose: () => void; panelStyle: React.CSSProperties }) => {
  const stats = chatStore.lastPerformanceStats;

  if (!stats) return null;

  const speedColor = stats.tokensPerSec >= 20 ? "#a6e3a1" : stats.tokensPerSec >= 8 ? "#f9e2af" : "#f38ba8";
  const speedLabel = stats.tokensPerSec >= 20 ? "Fast" : stats.tokensPerSec >= 8 ? "Moderate" : "Slow";

  return (
    <>
      <div style={pS.overlay} onClick={onClose} />
      <div style={panelStyle}>
        <div style={pS.head}>
          <h4 style={pS.title}>⚡ Performance Stats</h4>
          <button style={pS.close} onClick={onClose}>✕</button>
        </div>

        {/* Hero: tokens/sec */}
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "10px 0 8px",
          gap: "4px",
        }}>
          <span style={{ ...statHighlight, fontSize: "28px", color: speedColor }}>
            {stats.tokensPerSec}
          </span>
          <span style={{ fontSize: "11px", color: speedColor, fontWeight: 500 }}>
            tokens/sec · {speedLabel}
          </span>
          <span style={{ fontSize: "10px", color: "var(--textColorSecondary, #a6adc8)" }}>
            {stats.model}
          </span>
        </div>

        {/* Detail rows */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={statRow}>
            <span style={statLabel}>⏱️ Total time</span>
            <span style={statValue}>{(stats.totalDurationMs / 1000).toFixed(1)}s</span>
          </div>
          <div style={statRow}>
            <span style={statLabel}>📥 Prompt tokens</span>
            <span style={statValue}>{stats.promptTokens.toLocaleString()}</span>
          </div>
          <div style={statRow}>
            <span style={statLabel}>📥 Prompt eval</span>
            <span style={statValue}>
              {(stats.promptEvalMs / 1000).toFixed(1)}s ({stats.promptTokensPerSec} t/s)
            </span>
          </div>
          <div style={statRow}>
            <span style={statLabel}>📤 Generated tokens</span>
            <span style={statValue}>{stats.generatedTokens.toLocaleString()}</span>
          </div>
          <div style={statRow}>
            <span style={statLabel}>📤 Generation time</span>
            <span style={statValue}>{(stats.generationMs / 1000).toFixed(1)}s</span>
          </div>
          <div style={statRow}>
            <span style={statLabel}>🔄 Model load</span>
            <span style={statValue}>{stats.loadMs}ms</span>
          </div>
        </div>

        {/* Tip */}
        <div style={{
          marginTop: "6px",
          padding: "6px 8px",
          background: "rgba(137,180,250,.06)",
          borderRadius: "6px",
          fontSize: "10px",
          color: "var(--textColorSecondary, #a6adc8)",
          lineHeight: 1.4,
        }}>
          💡 Compare models by switching in the header dropdown. Lower prompt tokens = better context compression.
          Higher t/s = faster responses.
        </div>
      </div>
    </>
  );
});

/* ── Data Sources panel ── */
const SourcesPanel = observer(({ onClose, panelStyle }: { onClose: () => void; panelStyle: React.CSSProperties }) => {
  const sources = chatStore.getDataSourceStatus();

  const colorFor = (status: "ready" | "partial" | "missing") => {
    if (status === "ready") return "#a6e3a1";
    if (status === "partial") return "#f9e2af";
    return "#f38ba8";
  };

  return (
    <>
      <div style={pS.overlay} onClick={onClose} />
      <div style={panelStyle}>
        <div style={pS.head}>
          <h4 style={pS.title}>🧰 SRE Data Sources</h4>
          <button style={pS.close} onClick={onClose}>✕</button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {sources.map((s) => (
            <div
              key={s.name}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                border: "1px solid rgba(49,50,68,.5)",
                borderRadius: "6px",
                padding: "7px 9px",
                fontSize: "11px",
                gap: "8px",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ color: "var(--textColorPrimary, #cdd6f4)", fontWeight: 600 }}>{s.name}</span>
                <span style={{ color: "var(--textColorSecondary, #a6adc8)" }}>{s.detail}</span>
              </div>
              <span style={{ color: colorFor(s.status), fontWeight: 700, textTransform: "uppercase", fontSize: "10px" }}>
                {s.status}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
});

/* ─── Fidelity Panel ─────────────────────────────────────────────────────── */

const FidelityPanel = observer(({ onClose, panelStyle }: { onClose: () => void; panelStyle: React.CSSProperties }) => {
  const report: FidelityReport | null = chatStore.fidelityReport;
  const running = chatStore.isFidelityRunning;
  const hasCtx = !!chatStore.clusterContext;

  const scoreColor = (s: number) => s >= 0.8 ? "#a6e3a1" : s >= 0.5 ? "#f9e2af" : "#f38ba8";

  return (
    <>
      <div style={pS.overlay} onClick={onClose} />
      <div style={{ ...panelStyle, width: "480px" }}>
        <div style={pS.head}>
          <h4 style={pS.title}>🔬 Model Fidelity Evaluation</h4>
          <button style={pS.close} onClick={onClose}>✕</button>
        </div>

        <p style={{ fontSize: "11px", color: "var(--textColorSecondary, #a6adc8)", margin: 0 }}>
          Compares model output on raw cluster data vs the compressed context it normally receives.
          Runs 3 Ollama calls (DiagA · DiagB · Judge).
        </p>

        <button
          style={{
            ...S.btn,
            background: running ? "rgba(137,180,250,.06)" : "rgba(137,180,250,.12)",
            color: running ? "#a6adc8" : "#89b4fa",
            fontSize: "11px",
            padding: "5px 12px",
            cursor: running || !hasCtx ? "not-allowed" : "pointer",
            opacity: !hasCtx ? 0.5 : 1,
          }}
          disabled={running || !hasCtx}
          onClick={() => chatStore.runFidelityEvaluation()}
        >
          {running ? "⏳ Running evaluation…" : "▶ Run Evaluation"}
        </button>

        {!hasCtx && (
          <p style={{ fontSize: "11px", color: "#f38ba8", margin: 0 }}>⚠ Refresh cluster context first.</p>
        )}

        {report && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "4px" }}>

            {/* Score row */}
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" as const }}>
              {[
                { label: "Fidelity Score", value: `${(report.score * 100).toFixed(0)}%`, color: scoreColor(report.score) },
                { label: "Judge Score", value: report.judgeScore != null ? `${report.judgeScore}/5` : "N/A", color: scoreColor((report.judgeScore ?? 0) / 5) },
                { label: "Compression", value: `${(report.compressionRatio * 100).toFixed(1)}%`, color: "#89b4fa" },
                { label: "Token Savings", value: `~${report.tokenSavings}`, color: "#89b4fa" },
                { label: "Latency Δ", value: `${report.latencyDifferenceMs > 0 ? "+" : ""}${report.latencyDifferenceMs}ms`, color: report.latencyDifferenceMs >= 0 ? "#a6e3a1" : "#f9e2af" },
              ].map((m) => (
                <div key={m.label} style={{ border: "1px solid rgba(49,50,68,.6)", borderRadius: "6px", padding: "6px 10px", minWidth: "80px", textAlign: "center" as const }}>
                  <div style={{ fontSize: "11px", color: "var(--textColorSecondary, #a6adc8)", marginBottom: "2px" }}>{m.label}</div>
                  <div style={{ fontSize: "14px", fontWeight: 700, color: m.color }}>{m.value}</div>
                </div>
              ))}
            </div>

            {/* Hallucinations */}
            {report.hallucinatedResources.length > 0 && (
              <div style={{ background: "rgba(243,139,168,.08)", border: "1px solid rgba(243,139,168,.3)", borderRadius: "6px", padding: "8px 10px" }}>
                <div style={{ fontSize: "11px", fontWeight: 600, color: "#f38ba8", marginBottom: "4px" }}>⚠ Hallucinated resources in Diagnosis B</div>
                <div style={{ fontSize: "11px", color: "#f38ba8", fontFamily: "monospace", wordBreak: "break-all" as const }}>
                  {report.hallucinatedResources.join(" · ")}
                </div>
              </div>
            )}

            {/* Discrepancies */}
            {report.discrepancies.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--textColorPrimary, #cdd6f4)" }}>Discrepancies</div>
                {report.discrepancies.map((d, i) => (
                  <div key={i} style={{ fontSize: "10px", color: "var(--textColorSecondary, #a6adc8)", borderLeft: "2px solid #f9e2af", paddingLeft: "8px" }}>
                    <span style={{ color: "#f9e2af", fontWeight: 600, textTransform: "uppercase" as const, marginRight: "6px" }}>{d.type}</span>
                    {d.description}
                  </div>
                ))}
              </div>
            )}

            {/* Judge explanation */}
            <details style={{ fontSize: "11px" }}>
              <summary style={{ cursor: "pointer", color: "var(--textColorSecondary, #a6adc8)", userSelect: "none" as const }}>Judge explanation</summary>
              <pre style={{ marginTop: "6px", whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const, color: "var(--textColorPrimary, #cdd6f4)", background: "rgba(49,50,68,.4)", padding: "8px", borderRadius: "4px", fontSize: "10px" }}>
                {report.judgeExplanation}
              </pre>
            </details>

            <div style={{ fontSize: "10px", color: "var(--textColorSecondary, #a6adc8)" }}>
              Evaluated {new Date(report.evaluatedAt).toLocaleString()} · model: {report.model}
            </div>
          </div>
        )}
      </div>
    </>
  );
});
