/**
 * Copyright (c) 2026 Freelens K8s SRE Assistant Authors.
 * Licensed under MIT License.
 *
 * App Preferences panel for K8s SRE Assistant
 * Minimal — connection, model, and parameters are configured in the chat UI.
 */

import React, { useCallback, useState } from "react";
import { ChatStore } from "../stores/chat-store";
import { DEFAULT_TOOLS_CONFIG } from "../../common/types";
import type { ToolsConfig } from "../../common/types";

const chatStore = ChatStore.getInstance();

const sty = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "14px",
    padding: "4px 0",
  },
  section: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "6px",
  },
  label: {
    fontSize: "13px",
    fontWeight: 600 as const,
    color: "var(--textColorPrimary)",
  },
  sublabel: {
    fontSize: "11px",
    color: "var(--textColorSecondary)",
    marginBottom: "4px",
  },
  input: {
    padding: "8px 12px",
    border: "1px solid var(--borderColor)",
    borderRadius: "4px",
    background: "var(--inputControlBackground, var(--mainBackground))",
    color: "var(--textColorPrimary)",
    fontSize: "13px",
    outline: "none" as const,
    width: "100%",
    boxSizing: "border-box" as const,
  },
  checkbox: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "13px",
    color: "var(--textColorPrimary)",
    cursor: "pointer",
  },
  checkboxIndented: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "13px",
    color: "var(--textColorPrimary)",
    cursor: "pointer",
    paddingLeft: "20px",
  },
  checkboxDisabled: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "13px",
    color: "var(--textColorSecondary)",
    cursor: "not-allowed",
    paddingLeft: "20px",
  },
  divider: {
    border: "none",
    borderTop: "1px solid var(--borderColor)",
    margin: "4px 0",
  },
};

const TOOL_LABELS: Record<keyof ToolsConfig["tools"], string> = {
  get_namespace_detail: "Namespace detail",
  get_pod_detail: "Pod detail",
  get_resource_events: "Resource events",
  get_deployment_detail: "Deployment detail",
  get_nodes: "Node list",
  get_pod_logs: "Pod logs (human-in-the-loop)",
  get_resource_chain: "Resource chain",
  list_resources: "List resources",
};

export function SrePreferencesInput() {
  const [endpoint, setEndpoint] = useState(chatStore.ollamaEndpoint);
  const [apiKey, setApiKey] = useState(chatStore.openaiApiKey);
  const [autoRefresh, setAutoRefresh] = useState(chatStore.autoRefreshContext);
  const [toolsConfig, setToolsConfigState] = useState<ToolsConfig>(() => ({
    ...DEFAULT_TOOLS_CONFIG,
    ...chatStore.toolsConfig,
    tools: { ...DEFAULT_TOOLS_CONFIG.tools, ...chatStore.toolsConfig?.tools },
  }));

  const onEndpointChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setEndpoint(val);
    chatStore.setEndpoint(val);
  }, []);

  const onApiKeyChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setApiKey(val);
    chatStore.setOpenAIApiKey(val);
  }, []);

  const onAutoRefreshChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.checked;
    setAutoRefresh(val);
    chatStore.setAutoRefreshContext(val);
  }, []);

  const onToolsEnabledChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const updated: ToolsConfig = { ...toolsConfig, enabled: e.target.checked };
    setToolsConfigState(updated);
    chatStore.setToolsConfig(updated);
  }, [toolsConfig]);

  const onSingleToolChange = useCallback((toolName: keyof ToolsConfig["tools"]) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const updated: ToolsConfig = {
        ...toolsConfig,
        tools: { ...toolsConfig.tools, [toolName]: e.target.checked },
      };
      setToolsConfigState(updated);
      chatStore.setToolsConfig(updated);
    }, [toolsConfig]);

  return (
    <div style={sty.container}>
      <div style={sty.section}>
        <label style={sty.label}>Endpoint</label>
        <div style={sty.sublabel}>
          Insert your AI endpoint URL. The plugin auto-detects Ollama or OpenAI-compatible API.
        </div>
        <input
          style={sty.input}
          type="text"
          value={endpoint}
          onChange={onEndpointChange}
          placeholder="http://localhost:11434"
        />
      </div>

      <div style={sty.section}>
        <label style={sty.label}>API Key (optional)</label>
        <div style={sty.sublabel}>
          Required only for protected OpenAI-compatible endpoints.
        </div>
        <input
          style={sty.input}
          type="password"
          value={apiKey}
          onChange={onApiKeyChange}
          placeholder="sk-..."
        />
      </div>

      <hr style={sty.divider} />

      <div style={sty.section}>
        <label style={sty.label}>Behavior</label>
        <label style={sty.checkbox}>
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={onAutoRefreshChange}
          />
          Auto-refresh cluster context before each message
        </label>
        <div style={sty.sublabel}>
          When enabled, the assistant gathers pods, deployments, services, nodes,
          and events before each response. Model selection, parameters, and connection
          testing are available directly in the chat header.
        </div>
      </div>

      <hr style={sty.divider} />

      <div style={sty.section}>
        <label style={sty.label}>K8s Tool Calling</label>
        <div style={sty.sublabel}>
          Tools let the assistant drill down into specific resources on demand.
          Disable globally for small models that loop on tool calls, or selectively
          disable individual tools.
        </div>
        <label style={sty.checkbox}>
          <input
            type="checkbox"
            checked={toolsConfig.enabled}
            onChange={onToolsEnabledChange}
          />
          Enable tool calling
        </label>
        {(Object.keys(TOOL_LABELS) as Array<keyof ToolsConfig["tools"]>).map((toolName) => (
          <label
            key={toolName}
            style={toolsConfig.enabled ? sty.checkboxIndented : sty.checkboxDisabled}
          >
            <input
              type="checkbox"
              checked={toolsConfig.tools[toolName]}
              disabled={!toolsConfig.enabled}
              onChange={onSingleToolChange(toolName)}
            />
            {TOOL_LABELS[toolName]}
          </label>
        ))}
      </div>
    </div>
  );
}

export function SrePreferencesHint() {
  return (
    <span>
      Configure Ollama or any OpenAI-compatible endpoint for the K8s SRE Assistant.
      Model selection, parameters, and connection testing are in the chat UI.
    </span>
  );
}
