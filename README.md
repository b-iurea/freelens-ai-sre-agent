# K8s SRE Assistant — Freelens Extension 

https://b-iurea.github.io/freelens-ollama-extension/

An AI-powered **Kubernetes SRE (Site Reliability Engineer)** assistant embedded directly in Freelens. Chat with any AI model — via **Ollama** or any **OpenAI-compatible endpoint** (LocalAI, OpenAI, LM Studio, etc.) — that sees your live cluster state and adapts its response format to what you're actually asking.

![Freelens Extension](https://img.shields.io/badge/Freelens-Extension-blue)
![Version](https://img.shields.io/badge/version-0.4.0-orange)
![License](https://img.shields.io/badge/license-MIT-green)

<b>This is a vibecoded plugin so feel free to steal, edit, update or improve.
All suggestions are welcome. </b>

---

## Features

### Core

- **AI Chat Interface** — Conversational assistant integrated directly into the Freelens cluster view
- **Live Cluster Awareness** — The model sees pods, deployments, services, nodes, and events via direct `KubeApi.list()` calls
- **AI Engine Agnostic** — Works with **Ollama**, **LocalAI**, **OpenAI**, or any OpenAI-compatible endpoint; no mandatory cloud dependency. Auto-detects the provider from the endpoint URL — just paste and go
- **Streaming Responses** — Block-level Markdown renderer safe for incomplete streamed output
- **Cancelable** — Interrupt generation at any time

### Network & Compatibility

- **No Mixed-Content Issues** — All AI API calls use Node.js `http`/`https` modules; plain HTTP remote endpoints work reliably from the Electron renderer
- **Remote Ollama** — Full support for remote instances (`OLLAMA_ORIGINS=*`, `OLLAMA_HOST=0.0.0.0:11434`)
- **OpenAI-compatible endpoints** — LocalAI, LM Studio, OpenAI, or any `/v1/chat/completions`-compatible backend; optional API key support
- **Cloud endpoints** — `num_predict: -1` and other Ollama-specific params are automatically stripped before sending to OpenAI-compatible APIs

---

### Smart Context Management (v0.1.0)

Designed to work well on small (4–9B) models against mid sized clusters.

- **Context Pipeline** — ChunkManager → BM25 Retriever → SummaryManager → ContextBuilder prevents "lost-in-the-middle" on long conversations
- **K8s-Aware BM25 Retrieval** — Pure TypeScript BM25 that preserves compound terms (`kube-system`, `apps/v1`, pod names, IPs) as searchable tokens. Runs only on non-summarised messages to avoid duplicating the compressed history
- **Non-Blocking Summarisation** — After 20 exchange pairs, old turns are compressed into a two-part summary (**Facts & Decisions** + **Rolling Context**) via a background Ollama call delivered *after* the response — zero added latency
- **Anomaly-First Sorting** — CrashLoopBackOff/OOMKilled pods, replica-mismatch deployments, and NotReady nodes are sorted to the top before any truncation
- **Clean Data** — `managedFields`, long annotations, `pod-template-hash`, and other noisy metadata stripped before passing to the model
- **Token Budget** — Conversation history capped at ~2800 words; cluster context capped at ~1000 tokens

---

### Cluster Memory (v0.2.0)

Eliminates the "full cluster dump on every message" problem for large clusters.

- **Persistent Snapshot** — Cluster state saved to `localStorage` after every refresh. Freelens restart warm-starts instantly — no waiting for a K8s API scan
- **Namespace Health Rollup** — Every prompt includes a compact per-namespace overview at ~10 tokens/namespace:
  ```
  NAMESPACE OVERVIEW (5):
    prod-api:    43 Running · 2 CrashLoopBackOff   12 deps (1 degraded)   3 warnings
    staging:     28 Running · 2 Pending             10 deps (1 degraded)
    prod-db:      8 Running                          3 deps
    monitoring:  11 Running · 1 Pending              5 deps
    kube-system: 22 Running                          8 deps
  ```
- **Query-Relevant Filtering** — Each message injects only the 15 most BM25-relevant pods/deployments/services for the current query, plus all anomalous resources. The prompt shows `(15 shown of 180, most relevant + all anomalies)` so the model knows it is working with a subset
- **Health Aggregates** — Cluster-wide status counts (`170 Running · 7 Pending · 3 CrashLoopBackOff`) and deployment health (`105 healthy · 15 degraded`) computed once at snapshot time
- **Snapshot Age** — Shown in the Sources panel; stale snapshots (> 30 min) are flagged but still used as a fallback
- **Always-Live Context** — The data actually passed to the model is always a fresh `KubeApi.list()` fetch, not the persisted snapshot. The snapshot is used only to warm-start the namespace selector on Freelens restart

**Token impact on a 180-pod cluster:**

| | v0.1.0 | v0.2.0 |
|--|--|--|
| System prompt cluster section | ~6,500 tokens | ~1,000 tokens |
| Reduction | — | ~85% |

---

### SRE-Native Agent Workflow (v0.2.0)

The assistant adapts its response format to the intent of the query — no more Evidence/Correlation/Hypotheses sections for a simple YAML request.

**Intent Detection** — every query is classified automatically:

| Intent | Triggered by | Response format |
|--------|-------------|-----------------|
| `write` | "write a deployment", "give me a YAML", "create a…" | Direct manifest + one-line RISK rating + verification step |
| `investigate` | "why is…", "debug…", "crashloop", "not working" | Evidence → Correlation → Hypotheses → Checks → Actions |
| `explain` | "what is…", "how does…", "explain…" | Clean prose explanation |
| `general` | Everything else | Concise direct answer |

**SRE Mode Presets** — six UI modes override intent detection:

| Mode | Behaviour |
|------|-----------|
| Auto | Intent detected from query text |
| Troubleshoot | Always full investigation format |
| Security | RBAC, PodSecurity, NetworkPolicy, image and secret risks |
| Cost | Waste reduction, right-sizing, autoscaling |
| Capacity | Saturation signals, scheduling pressure, scaling strategy |
| YAML | Always direct manifest output, no analysis preamble |

**Token-Aware Signals** — the Correlated Signals block (warning events, CrashLoop pods, replica mismatches) is injected only for `investigate` queries; skipped entirely for write/explain/general.

**Exports** — export the current investigation as a structured Markdown runbook, or export the full session as Markdown.

---

### Tool Calling & Human-in-the-Loop (v0.3.0)

The assistant can inspect the cluster on-demand during a conversation, rather than relying solely on the upfront context snapshot.

- **Tool Approval Cards** — Every tool call requires explicit user approval before execution; approval cards are colour-coded (🔧 blue = inspection, 🔐 yellow = sensitive log access)
- **`get_namespace_detail`** — Full pod/deployment/service list for a specific namespace
- **`get_pod_detail`** — Container states, restart counts, exit codes, and termination reasons for a single pod
- **`get_resource_events`** — Recent warning events for any named K8s resource
- **`get_deployment_detail`** — Replica status and pod states for a deployment
- **`get_nodes`** — All cluster nodes with Ready/NotReady status
- **`get_resource_chain`** — Full upstream/downstream graph: owner controller, PVCs, missing Secrets/ConfigMaps, HPA, service endpoints, Ingress chain
- **`get_pod_logs`** — Last 30 log lines (signal-filtered); gated behind a dedicated 🔐 approval requiring the model to state its rationale first
- **`list_resources`** — Full inventory of any resource kind: pods, deployments, services, nodes, namespaces, secrets, configmaps, ingresses, statefulsets, daemonsets, jobs, cronjobs, pvcs
- **Tools Panel** — Grouped as Inspect / List / Sensitive; each tool individually toggleable in Preferences
- **Auto Container Resolution** — For `get_pod_logs`, the correct container name is auto-resolved from context so the model doesn't have to guess

---

### Canvas Graph Renderer (v0.3.0)

Mermaid relationship diagrams render as native Canvas — zero npm dependencies, no renderer crashes.

- **Pure Canvas** — BFS layout engine, bezier edges, rounded-rect nodes; no external library
- **K8s Colour Coding** — Pods green · Deployments/StatefulSets cyan · Services blue · Ingresses mauve · ConfigMaps yellow · Secrets peach · PVCs red · Nodes/HPA teal
- **Inline Scroll** — Oversized graphs scroll horizontally inside the chat panel instead of overflowing
- **⛶ Expand** — Opens a full-screen `92vw × 92vh` overlay with the graph rendered at full resolution
- **↓ PNG** — Downloads the current graph as a lossless PNG via `canvas.toDataURL`

---

### Secret & ConfigMap Resolution (v0.3.0)

- **Correct API names** — Secrets now fetched via `secretsApi` (previously `secretApi` — undefined — caused every secret reference to be falsely reported as `MISSING`)
- **Namespace fallback** — When a namespace-scoped list call strips `metadata.namespace` from items (Freelens behaviour), the filter namespace is used as fallback, preventing false MISSING reports

---

### Suggestion Carousel (v0.3.0)

- **Collapsible** — Collapsed by default; a `▸ / ▾` toggle opens or closes the suggestion chips to save vertical space
- **25-item banks** — Separate suggestion pools for all-namespaces view (cluster-wide health) and single-namespace view (workload investigation)
- **60-second rotation** — Chips rotate every minute; random start offset prevents always showing the same first page

---

### UI & Developer Experience (v0.3.0)

- **Fixed Toolbar** — All controls live in a dedicated toolbar row below the title bar; scrolls horizontally on narrow windows, never wraps or jumps
- **Always-Visible Buttons** — ⚙️ Params, 📚 Runbook, 📄 Export, 🗑️ Clear are always present and disabled (greyed out) when inactive, not hidden
- **Model Selector** — Always visible; shows last-used model grayed out when disconnected
- **Hover Effects** — All toolbar buttons have smooth blue highlight transitions; send button shows a glow ring on hover
- **Fidelity Inline Score** — Fidelity button shows the score (e.g. `🔬 Fidelity 87%`) in blue when a report is available, not green (BUGs on small context, WIP)
- **SRE Mode Selector** — Select mode: Auto / Troubleshoot / Security / Cost / Capacity / YAML
- **Suggested Actions** — Context-aware follow-up chips (collapsible) shown in the input bar to accelerate investigation loops
- **Sources Panel** — Shows what data the model used: snapshot age, filtered resource counts, warning event count
- **Performance Stats** — After each response: tokens/sec, prompt tokens, generation time, model load time. Cloud models show `0 t/s` — this is normal (no timing data returned by cloud endpoints)
- **In-Chat Model Parameters** — Tune temperature, top_p, top_k, repeat penalty, and max tokens
- **In-Chat Connection Panel** — Configure Ollama endpoint and test via Node.js HTTP (no mixed-content issues)
- **Session Persistence** — Chat history persisted per `cluster + namespace`, restored on Freelens restart
- **Object-Aware Prompt Entry** — URL params (`kind/name/namespace/reason`) prefill a targeted investigation prompt
- **Workload Analysis Shortcuts** — single robot-icon button in the toolbar and 3-dot context menu opens a 640 px floating side panel with the SRE chat already running a relationship/dependency graph diagnosis for the selected workload, without leaving the workload view
- **Persistent Settings** — All settings saved to `localStorage` and synced across Freelens contexts
- **Back Navigation** — One-click return to the cluster dashboard

---

### Workload Analysis Shortcuts (v0.3.2)

Launch SRE analysis directly from any workload — no need to open the chat and type. Clicking opens a **floating side panel** with the full chat experience right next to the workload, without leaving the page.

**Context menu** (3-dot `⋮` button next to each workload):
- 🤖 **SRE: Diagnose** — maps the full dependency chain: owner controller, PVCs, referenced Secrets/ConfigMaps, Services, Ingresses, HPA. The result appears in the SRE chat panel rendered inline at the right of the screen

**Toolbar** (breadcrumb action bar when a workload row is selected):
- Robot icon only — same diagnosis action, minimal footprint

**Detail drawer** (click any workload to open the side panel):
- Robot icon button at the bottom of the detail view — same one-click diagnosis

**Floating chat popup** — instead of navigating away to the SRE page, a 640 px slide-in panel opens at the right edge of the window. The analysis starts immediately; close it with ✕ to return to the workload list. Messages use the full panel width so tables and structured output are readable.

Supported kinds: **Pod**, **Deployment**, **StatefulSet**, **DaemonSet**, **ReplicaSet**.

---

### OpenAI-Compatible Endpoint Support (v0.4.0)

Use any AI backend that speaks the OpenAI API — no manual configuration needed.

- **Auto-detection** — paste the base URL; the plugin probes `/api/tags` (Ollama) and `/v1/models` (OpenAI-compatible) and selects the right mode automatically
- **Optional API Key** — enter once in the Connection Panel or Preferences; sent as `Authorization: Bearer <key>` on every request
- **Endpoint normalisation** — pasting a full URL like `http://host:8080/v1/models` works; the `/v1/models` suffix is stripped automatically
- **Auth-aware probing** — `401 Unauthorized` from `/v1/models` is correctly recognised as "endpoint reachable, API key required" (not "unreachable")
- **Tested with** Ollama, LocalAI, LM Studio, OpenAI API

---

## Requirements

- **Freelens** >= 1.4.0
- **Ollama** running locally or on the network, **or** any **OpenAI-compatible AI backend** (LocalAI, LM Studio, OpenAI, etc.)
- At least one model available on your endpoint

---

## Quick Start

### Option A — Ollama (local)

```bash
# macOS / Linux
curl -fsSL https://ollama.com/install.sh | sh
ollama serve

# Pull a model (minimum 7B recommended)
ollama pull qwen2.5:7b      # 7B   — strong at YAML, structured data, and tool use
ollama pull mistral          # 7B   — solid all-rounder
ollama pull gemma3:9b        # 9B   — strong reasoning, handles large clusters well
ollama pull llama3.1:8b     # 8B   — good tool-calling support
```

### Option B — OpenAI-compatible endpoint (LocalAI, LM Studio, OpenAI, etc.)

Any backend that exposes `/v1/chat/completions` and `/v1/models` works out of the box.

```bash
# LocalAI example
docker run -p 8080:8080 localai/localai:latest

# Or point directly to OpenAI / any hosted endpoint
# Endpoint: https://api.openai.com
# API Key:  sk-...
```

In the plugin's **Connection Panel**, enter the base URL (e.g. `http://localhost:8080`).  
The provider is **auto-detected** — no manual toggle needed. If your endpoint requires authentication, fill in the optional **API Key** field.

> ⚠️ **Models smaller than 4B parameters are not reliably supported.** Tool-calling, structured JSON, and multi-step reasoning require sufficient model capacity. Models like `llama3.2:3b` or `phi4-mini:3.8b` may work for simple queries but fail on tool calls and investigation workflows.

### 3. Install the Extension

```bash
git clone https://github.com/biurea/freelens-k8s-sre-assistant.git
cd freelens-k8s-sre-assistant
pnpm install
pnpm build
pnpm pack
```

In Freelens: **Extensions** → **Add Local Extension** → select the `.tgz` file.

---

## What Can It Do?

| Category | Example queries |
|----------|----------------|
| **Cluster health** | "What's the overall health of my cluster?" · "Are there any pods in CrashLoopBackOff?" |
| **Troubleshooting** | "Why is my deployment not rolling out?" · "Help me debug this crashing pod" |
| **YAML authoring** | "Write a simple nginx deployment" · "Add a liveness probe to this deployment" |
| **Optimization** | "Are there pods without resource limits?" · "Suggest HPA configs for my deployments" |
| **Security** | "Check for pods running as root" · "Review my RBAC configuration" |
| **Operations** | "How do I scale this deployment?" · "Generate a NetworkPolicy for namespace isolation" |

---

## Configuration

### Context Bar

Shows cluster name · namespace selector · pod/deployment counts · warning count · SRE mode selector · Refresh button.

Click **Refresh** to force a new K8s API scan and update the cluster memory snapshot.

### Sources Panel

Shows what data was used for the last response:

| Row | Description |
|-----|-------------|
| Cluster Memory | Snapshot age; flagged as stale if > 30 min |
| Pods | `N shown of M total` when query-filtered |
| Deployments | Filtered count + degraded count |
| Warning Events | Number of active warning events |

### Connection Panel (AI endpoint badge)

Click the provider badge (e.g. **Ollama**, **OpenAI-compatible**, or **Disconnected**):

- **Endpoint** — base URL of your AI backend (e.g. `http://localhost:11434`, `http://192.168.1.239:8080`, `https://api.openai.com`)
- **API Key** — optional; required for endpoints that enforce authentication
- **Test Connection** — auto-detects provider (Ollama or OpenAI-compatible), uses Node.js HTTP, bypasses browser mixed-content
- **Debug log** — detailed diagnostics with troubleshooting hints

### Namespace Selector

Scopes the AI's view to a single namespace. Nodes and the namespace list remain global. Changing namespace triggers an automatic context refresh.

### Performance Stats

After each response a button shows generation speed. Click to expand:

| Metric | Description |
|--------|-------------|
| Tokens/sec | Generation speed (green >= 20, yellow >= 8, red < 8) |
| Total time | End-to-end response time |
| Prompt tokens | Total tokens sent to the model |
| Prompt eval | Time to process the prompt |
| Generated tokens | Tokens in the response |
| Generation time | Time spent generating |
| Model load | Time to load the model |

> **Note:** Cloud-routed models (e.g. `qwen3.5:cloud`) return `0 t/s` — this is expected. Cloud endpoints do not expose per-token timing metadata. All other stats remain accurate.

### Model Parameters

| Parameter | Range | Description |
|-----------|-------|-------------|
| Temperature | 0 – 2 | Creativity vs determinism |
| Top P | 0 – 1 | Nucleus sampling threshold |
| Top K | 0 – 200 | Token vocabulary limit |
| Repeat Penalty | 1 – 2 | Penalize repeated tokens |
| Max Tokens | -1 – 8192 | Response length (-1 = model default) |

### Preferences Panel

**Freelens → Preferences → K8s SRE Assistant**

| Setting | Default | Description |
|---------|---------|-------------|
| AI Endpoint | `http://localhost:11434` | Base URL of your Ollama or OpenAI-compatible backend |
| API Key | _(empty)_ | Optional authentication key for endpoints that require it |
| Auto-refresh context | `true` | Gather cluster state before each message |

---

## Architecture

```
src/
├── main/
│   └── index.ts                    # Main process entry (Freelens lifecycle)
├── renderer/
│   ├── index.tsx                   # Renderer entry (registers pages, menus, preferences)
│   ├── components/
│   │   ├── sre-chat.tsx                  # Chat UI + all panels (Connection, Params, Stats, Sources, Tools)
│   │   ├── markdown-renderer.tsx         # Streaming-safe Markdown + pure-Canvas Mermaid renderer
│   │   ├── workload-analysis-menu.tsx    # Context-menu items for workload 3-dot menus
│   │   └── workload-analysis-detail.tsx  # SRE panel injected into the workload detail drawer
│   ├── icons/sre-icon.tsx
│   ├── pages/sre-assistant-page.tsx
│   ├── preferences/sre-preferences.tsx
│   ├── services/
│   │   ├── ollama-service.ts       # AI service: Node.js HTTP, auto-detects Ollama or OpenAI-compatible, streaming, stats, system prompt
│   │   ├── k8s-context-service.ts  # K8s context via KubeApi.list() + raw resource cache
│   │   └── context/
│   │       ├── index.ts            # Barrel export
│   │       ├── chunk-manager.ts    # Sliding-window chunker (~300 words, 50 overlap)
│   │       ├── bm25-retriever.ts   # Pure-TS BM25 (k1=1.5, b=0.75), K8s-aware tokenizer
│   │       ├── summary-manager.ts  # Background AI-based conversation compression
│   │       ├── context-builder.ts  # Assembles: system -> summary -> BM25 chunks -> recent -> query
│   │       ├── cluster-memory.ts   # Persistent snapshot, namespace rollup, BM25 query filter
│   │       ├── k8s-tools.ts        # Tool definitions + executors (all tool kinds)
│   │       └── k8s-compressor.ts   # Token-efficient K8s resource serialisers
│   └── stores/
│       └── chat-store.ts           # MobX state, pipeline orchestration, HiL tool approval
└── common/
    └── types.ts                    # Shared TypeScript types (ClusterContext, OllamaTool, ToolsConfig)
```

### Context Pipeline (per message)

```
 1. inferQueryIntent(query)
        -> write | investigate | explain | general

 2. buildFocusedContext(query)         [ClusterMemoryService]
        -> top-15 BM25-relevant pods/deps/svcs + all anomalous resources
        -> namespace health rollup (~10 tokens/namespace)
        -> cluster-wide status aggregates

 3. buildSystemPrompt(focusedCtx)      [OllamaService]
        -> SRE persona + NAMESPACE OVERVIEW + filtered resources

 4. [investigate only] buildCorrelatedSignalsBlock()
        -> warning events, crash pods, replica mismatches

 5. buildSreWorkflowInstruction(intent)
        -> format contract (skipped entirely for write/explain/general)

 6. ChunkManager.buildChunks()
        -> non-summarised history split into ~300-word overlapping chunks

 7. BM25Retriever.retrieve(query, 5)
        -> top-5 keyword-relevant conversation chunks

 8. ContextBuilder.assemble()
        -> system + summary + BM25 chunks + recent turns + query
        -> Jaccard deduplication removes chunks redundant with recent messages

 9. OllamaService.streamChatAssembled()  [Ollama /api/chat or OpenAI /v1/chat/completions]
        -> streaming response + performance stats capture

10. [post-response] SummaryManager.maybeCompress()
        -> background compression when history > 20 pairs
        -> FACTS & DECISIONS (stable) + ROLLING CONTEXT (query-focused)

11. ClusterMemoryService.save(ctx)
        -> persist fresh snapshot after every K8s API refresh
```

**Key properties:**
- Zero npm dependencies for the pipeline — pure TypeScript
- Summarisation runs after the response, never blocking it
- BM25 retrieves only from non-summarised messages (no duplicate context)
- Anomalous resources always survive filtering regardless of query
- Namespace health rollup gives global cluster visibility at negligible token cost
- Intent detection skips all analysis overhead for YAML/explain/general queries
---

## Known Issues

| # | Issue | Impact | Status |
|---|-------|--------|--------|
| 1 | **Models < 4B not reliable** | Small models (e.g. `llama3.2:3b`, `phi4-mini:3.8b`) fail on tool calls, structured JSON output, and multi-step investigation. Minimum effective size is ~7B. | Won't fix — model capability constraint |
| 2 | **Fidelity score not working as intended** | The hallucination detector produces noisy results on small or fast models and may flag correct K8s names. Score should be treated as indicative only. | WIP |
| 3 | **Canvas graph: node labels truncated** — resource names are truncated to fit the fixed node width, making it hard to distinguish replicas of the same resource (e.g. three pods named `api-server-7fd464bcc...` all look identical). Kind prefix (`Deployment:`, `Pod:`) uses characters that could be used for the actual name. | Low readability for large graphs | Planned fix: shorter kind prefix abbreviations (`Dp:`, `Pod:`, `Svc:`, `Ing:`) |
| 4 | **Canvas vs Mermaid graph quality** | The canvas renderer produces a simpler layout than the Mermaid reference. Complex graphs with many cross-level edges are harder to read in canvas form. Node positioning, subgraph support, and edge routing are more limited. | Cosmetic | Gradual improvement planned |
| 5 | **Cloud / OpenAI models show `0 t/s`** | OpenAI-compatible and cloud endpoints do not return per-token timing data. The stats panel shows `0 t/s` which looks like an error but is normal. A UI label now clarifies this. | Cosmetic — labelled in UI |
| 6 | **Fidelity eval works only with Ollama** | The fidelity hallucination detector uses a separate AI call internally. On OpenAI-compatible endpoints this call may doesn't work or return unexpected output, producing no score or a misleading result. | WIP — OpenAI-compatible fidelity support planned |

---

## Roadmap

### Completed

- [x] Preset SRE modes (Auto / Troubleshoot / Security / Cost / Capacity / YAML)
- [x] Suggested follow-up actions (collapsible carousel)
- [x] Object-aware entry points (URL param prefill)
- [x] Sources / data visibility panel
- [x] Session persistence per cluster + namespace
- [x] Incident summary and runbook export
- [x] Internal SRE roles (Investigator / Explainer / YAML Author / Change Planner)
- [x] Read-first / write-later response contract
- [x] Correlated signal block (warnings + anomaly cues)
- [x] Cluster memory with warm-start and namespace health rollup
- [x] BM25 query-relevant filtering (~85-90% token reduction on large clusters)
- [x] Intent detection with format-per-intent responses
- [x] Tool calling with human-in-the-loop approval for all tools
- [x] `list_resources` for all major K8s resource types
- [x] Pod log access (`get_pod_logs`) gated behind explicit approval
- [x] Canvas graph renderer (no external dependencies, expand + PNG export)
- [x] Auto container name resolution for `get_pod_logs`
- [x] Secret/ConfigMap MISSING false-positive fix (`secretsApi` API name)
- [x] Workload analysis shortcuts — context-menu and detail-drawer buttons for relationship map and resource analysis
- [x] OpenAI-compatible endpoint support — auto-detection, optional API key, endpoint URL normalisation (works with Ollama, LocalAI, LM Studio, OpenAI, etc.)

### Planned

- [ ] **Canvas graph node abbreviations** — shorter kind prefixes (`Dp:`, `Svc:`, `Ing:`) to expose more of the resource name in fixed-width nodes
- [ ] **Canvas graph layout improvements** — better edge routing, subgraph support, reduced cross-level edge crossings
- [ ] **Fidelity score rework** — more reliable hallucination detection across model sizes
- [ ] **Event and log correlation** — log correlation alongside warning event correlation
- [ ] **Cluster diff awareness** — compare snapshots across refreshes to explain what changed
- [ ] **Safe action queue** — queue kubectl commands/manifests for review before execution
- [ ] **Model/provider profiles** — ready-made profiles (Fast local / Balanced / Cloud deep analysis)
- [ ] **MCP support** — integrations with GitHub issues, runbook repos, incident systems, observability tools
- [ ] **Incident timeline UI** — visual timeline of warnings, restarts, rollout events, and assistant conclusions
- [ ] **Policy and config review** — deep RBAC / NetworkPolicy / PodSecurity / probes analysis
- [ ] **Context fill bar** — visual progress bar showing context budget usage (used vs max tokens) before sending each prompt
- [ ] **Caveman response mode** — token-saving concise style presets (`lite` / `full` / `ultra`) with chat commands (`/caveman ...`, `/normal`)


---

## Development

```bash
pnpm install       # Install dependencies
pnpm type:check    # TypeScript type check
pnpm build         # Production build
pnpm build:force   # Force rebuild
pnpm pack          # Pack .tgz for local Freelens installation
```

---

## Changelog

### v0.4.0

- **OpenAI-compatible endpoint support** — works with Ollama, LocalAI, LM Studio, OpenAI, or any `/v1/chat/completions`-compatible backend
- **Auto-detection** — plugin probes the endpoint and detects provider automatically; no manual toggle needed
- **Optional API key** — `Authorization: Bearer` support for endpoints that require authentication
- **Auth-aware probing** — `401 Unauthorized` on `/v1/models` correctly treated as "endpoint reachable, key required" rather than "not reachable"
- **Endpoint normalisation** — pasting a full path like `http://host:8080/v1/models` is accepted; suffix stripped to derive the correct base URL
- **Provider-biased detection** — if endpoint path contains `/v1/`, OpenAI-compatible is probed first; if API key is set, same bias applies (Ollama never requires auth)

### v0.3.2

- **Workload analysis shortcuts** — two new entry points on every workload (Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet):
  - **3-dot context menu** — `🔗 SRE: Relationship Map` and `📊 SRE: Resource Analysis` items alongside Logs / Edit / Delete
  - **Detail drawer panel** — **SRE Assistant** section with the same two buttons at the bottom of the workload detail view
- **`triggerWorkloadAnalysis`** — new `ChatStore` action builds a context-first prompt and auto-sends it; no typing required
- **Context-first tool discipline** — tool descriptions and system prompt rules updated with explicit mandatory gates: tools are only called when the required data is genuinely absent from the live cluster context; fan-out (calling a tool for every item in a list already in context) is explicitly prohibited

### v0.3.1

- **Context-before-tools rule** — system prompt hardened with a numbered 6-step tool-call protocol: read live context first, check if data is present, only call a tool if absent, no fan-out across lists
- **Tool description gates** — every tool description now starts with an explicit `ONLY call this when X is NOT already in the LIVE CLUSTER CONTEXT` guard

### v0.3.0

- **Live cluster data** — Cluster context is now always fetched live via `KubeApi.list()` before each session; the localStorage snapshot is used only to warm-start the namespace selector, never as the data source passed to the model
- **Toolbar refactor** — Title bar and toolbar are now separate rows; toolbar scrolls horizontally on narrow windows, eliminating button wrapping and positional shifts
- **Always-visible toolbar buttons** — ⚙️, 📚, 📄, 🗑️ are always rendered; disabled with reduced opacity when inactive instead of conditionally absent
- **Model select when disconnected** — selector stays visible, showing the last-used model grayed out
- **Fidelity button** — no longer turns green after an evaluation; shows the score inline in blue (e.g. `🔬 Fidelity 87%`)
- **Disconnected indicator** — status dot pulses when Ollama is unreachable
- **Hover transitions** — toolbar buttons and send button have smooth 150ms highlight/glow effects
- **Fidelity hallucination detector fix** — sub-segments of compound K8s names (e.g. `repo-server` from `argo-cd-argocd-repo-server`) are no longer falsely flagged as hallucinations
- **Fidelity discrepancies fix** — markdown headings, bullet lines, and table rows from the judge response are filtered out and no longer appear as discrepancy items
- **Tool calling with HiL** — All tools now require explicit user approval before execution; approval cards are colour-coded (🔧 blue for inspection tools, 🔐 yellow for log access)
- **`list_resources` expanded** — Now covers all major resource types: pods, deployments, services, nodes, namespaces, secrets, configmaps, ingresses, statefulsets, daemonsets, jobs, cronjobs, pvcs
- **Secret resolution fix** — Secrets were always falsely reported `MISSING ⚠` due to a wrong API property name (`secretApi` → `secretsApi`); fixed using the verified Freelens K8sApi type declaration
- **Namespace fallback for secret/configmap lookup** — When namespace-scoped API calls strip `metadata.namespace` from items, the filter namespace is used as fallback — no more false MISSING for existing resources
- **Canvas graph renderer** — Replaced crashing Mermaid dynamic import with a pure-Canvas renderer: BFS layout, bezier edges, K8s colour-coded nodes. Zero external dependencies, no renderer crash
- **Graph Expand button** — Opens graph in a full-screen overlay (`92vw × 92vh`, scrollable)
- **Graph Save PNG** — Downloads the current diagram as a lossless PNG
- **Inline canvas scroll** — Oversized graphs scroll horizontally inside the chat panel
- **Collapsible suggestion carousel** — Suggestion chips are collapsed by default; `▸ / ▾` toggle expands/collapses on demand
- **25-item suggestion banks** — Separate pools for all-namespaces (cluster-wide) and single-namespace queries; 60-second rotation with random offset
- **Auto container name resolution** — For `get_pod_logs`, the correct container name is resolved from context automatically so the model doesn't need to guess
- **Containers captured for all pods** — Container names are now extracted for healthy pods too, not only anomalous ones, ensuring `get_pod_logs` always knows valid container targets
- **StatefulSets, DaemonSets, Jobs, CronJobs fetched** — Added to the parallel context fetch alongside deployments, services, ingresses, PVCs
- **`0 t/s` for cloud models labelled** — Stats panel note clarifies this is expected for cloud-routed endpoints

**Token impact of tool calling on a 180-pod cluster:**

| | Without tools | With tools (per call) |
|--|--|--|
| System prompt cluster section | ~1,000 tokens | ~1,000 tokens |
| Tool result (e.g. `list_resources pods`) | — | ~200–600 tokens |
| Tool result (e.g. `get_resource_chain`) | — | ~150–400 tokens |
| Tool result (e.g. `get_pod_logs`) | — | ~50–200 tokens |
| Reduction vs full cluster dump (v0.1.0) | ~85% | ~80–85% |

### v0.2.0

- **Cluster Memory** — persistent `localStorage` snapshot with warm-start on Freelens restart
- **Namespace Health Rollup** — per-namespace pod/deployment/event summary in every prompt (~10 tokens/namespace)
- **Query-Relevant Filtering** — BM25 selects top-15 relevant resources per message; anomalous resources always included
- **Health Aggregates** — cluster-wide and per-namespace status counts computed at snapshot time
- **Intent Detection** — queries classified as `write / investigate / explain / general`; response format adapts accordingly
- **Format-per-Intent** — YAML requests get a direct manifest; debugging gets full investigation structure; explanations get clean prose
- **SRE Mode Presets** — six UI-selectable modes override intent detection
- **Token Savings** — Correlated Signals block skipped for non-investigate queries; ~85-90% reduction in cluster context tokens on large clusters
- **Sources Panel** — snapshot age, filtered resource counts, warning event count
- **Suggested Actions** — contextual follow-up chips after each response
- **Session Persistence** — chat history persists per cluster + namespace
- **Runbook & Session Export** — export investigations as Markdown runbooks or full session logs
- **Popup Anchor Fix** — all panels anchor correctly to their trigger buttons

### v0.1.0

- Initial release: AI chat, live cluster awareness, streaming responses, BM25 context pipeline, non-blocking summarisation, anomaly-first sorting, K8s-aware tokenizer

---

## License

Copyright (c) 2026 b-iurea. [MIT License](https://opensource.org/licenses/MIT)

## Contacts

b.iurea94@gmail.com
