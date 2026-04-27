/**
 * Copyright (c) 2026 Freelens K8s SRE Assistant Authors.
 * Licensed under MIT License.
 *
 * Fidelity Evaluator — benchmarks compressed K8s context against raw data.
 *
 * No external dependencies (uses Node.js http directly, same as OllamaService).
 *
 * Flow:
 *  1. Send BOTH raw and compressed data to Ollama in parallel with the same
 *     diagnostic prompt → collect Diagnosis A (raw) and Diagnosis B (compressed).
 *  2. Extract resource names (pod/deployment/service/node) from the raw data
 *     and scan Diagnosis B for invented names (hallucination check).
 *  3. Send both diagnoses to Ollama with a Judge Prompt → parse 1-5 score.
 *  4. Compute token savings (chars / 4 approximation) and latency delta.
 *  5. Return a FidelityReport ready for the "Model Fidelity" UI tab.
 */

import http from "http";
import https from "https";
import type { ApiProvider, FidelityDiscrepancy, FidelityReport } from "../../common/types";

/* ─── HTTP helper (duplicated from ollama-service to keep this module standalone) ── */

interface NodeResponse { status: number; ok: boolean; body: string }

function nodePost(url: string, body: string, timeoutMs = 120_000): Promise<NodeResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => { data += c.toString(); });
        res.on("end", () => {
          const s = res.statusCode ?? 0;
          resolve({ status: s, ok: s >= 200 && s < 300, body: data });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Fidelity request timeout")); });
    req.write(body);
    req.end();
  });
}

function nodePostWithHeaders(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs = 120_000,
): Promise<NodeResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => { data += c.toString(); });
        res.on("end", () => {
          const s = res.statusCode ?? 0;
          resolve({ status: s, ok: s >= 200 && s < 300, body: data });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Fidelity request timeout")); });
    req.write(body);
    req.end();
  });
}

/* ─── Internal helpers ───────────────────────────────────────────────────── */

/** Approximate token count: OpenAI-style ~4 chars per token. */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Extract all Kubernetes resource names from raw data (string or object).
 * Matches names in common K8s fields: .metadata.name, .name, and also
 * anything that looks like a k8s resource name (lowercase, hyphens, dots).
 */
function extractResourceNames(raw: string): Set<string> {
  const names = new Set<string>();
  // Match values next to common name keys in JSON/YAML
  const jsonNameRe = /"(?:name|metadata\.name|pod|deployment|service|node)"\s*:\s*"([^"]{3,80})"/gi;
  let m: RegExpExecArray | null;
  while ((m = jsonNameRe.exec(raw)) !== null) {
    names.add(m[1].toLowerCase());
  }
  // Also capture bare k8s-style names (e.g. "prometheus-0", "kube-system")
  const k8sNameRe = /\b([a-z][a-z0-9-]{2,63}(?:\.[a-z0-9-]+)*)\b/g;
  let km: RegExpExecArray | null;
  while ((km = k8sNameRe.exec(raw)) !== null) {
    // Only keep multi-segment names or names with dashes — avoids noise
    const candidate = km[1];
    if (candidate.includes("-") || candidate.includes(".")) {
      names.add(candidate.toLowerCase());
    }
  }
  return names;
}

/**
 * Parse the judge's 1-5 score from its text response.
 * Accepts "Score: 4", "4/5", "I give it a 3", etc.
 */
function parseJudgeScore(text: string): number | null {
  const patterns = [
    /score[:\s]+([1-5])/i,
    /([1-5])\s*\/\s*5/,
    /\b([1-5])\s*out\s+of\s*5/i,
    /give[s]?\s+(?:it\s+)?(?:a\s+)?([1-5])\b/i,
    /rating[:\s]+([1-5])/i,
    /punteggio[:\s]+([1-5])/i,
    // fallback: first standalone digit 1-5
    /\b([1-5])\b/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Extract structured discrepancies from the judge text.
 * We look for lines that mention missing info, hallucinations, or severity differences.
 */
function extractDiscrepancies(judgeText: string, hallucinatedResources: string[]): FidelityDiscrepancy[] {
  const discrepancies: FidelityDiscrepancy[] = [];

  // Hallucinations come in first — determined programmatically, not by the judge
  for (const name of hallucinatedResources) {
    discrepancies.push({
      type: "hallucinated_resource",
      description: `Resource "${name}" appears in Diagnosis B but not in the raw cluster data.`,
    });
  }

  // ── Primary: parse structured DISCREPANCIES_JSON section ─────────────────
  const jsonSection = judgeText.match(/DISCREPANCIES_JSON:\s*(\[[\s\S]*?\])/i);
  if (jsonSection) {
    try {
      const parsed = JSON.parse(jsonSection[1]) as Array<{ type: string; description: string }>;
      const validTypes = new Set<FidelityDiscrepancy["type"]>(
        ["missing_info", "wrong_severity", "extra_info", "hallucinated_resource"],
      );
      for (const item of parsed) {
        if (typeof item.description === "string" && item.description.trim().length > 10) {
          discrepancies.push({
            type: validTypes.has(item.type as FidelityDiscrepancy["type"])
              ? (item.type as FidelityDiscrepancy["type"])
              : "missing_info",
            description: item.description.trim(),
          });
        }
      }
      // Structured parse succeeded — deduplicate and return
      const seen = new Set<string>();
      return discrepancies.filter((d) => {
        const key = d.description.slice(0, 60);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 15);
    } catch {
      // Fall through to regex fallback
    }
  }

  // ── Fallback: regex sentence extraction (model ignored the format) ────────
  const missingRe = /(?:miss(?:ing|es?)|manca|omit|lacks?|absent|not\s+mention)/i;
  const wrongSevRe = /(?:severity|criticit[àa]|gravit[àa]|underestimat|overestimat|wrong\s+(?:severity|level)|incorrect(?:ly)?)/i;
  const extraRe = /(?:hallucin|invent|fabbric|fabricat|add(?:ed|s)\s+information|extra\s+detail)/i;

  const sentences = judgeText
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && !/^[#\-|*>]/.test(s) && !/^\d+\./.test(s));

  for (const sentence of sentences) {
    if (missingRe.test(sentence)) {
      discrepancies.push({ type: "missing_info", description: sentence });
    } else if (wrongSevRe.test(sentence)) {
      discrepancies.push({ type: "wrong_severity", description: sentence });
    } else if (extraRe.test(sentence)) {
      discrepancies.push({ type: "hallucinated_resource", description: sentence });
    }
  }

  // Deduplicate by description prefix
  const seen = new Set<string>();
  return discrepancies.filter((d) => {
    const key = d.description.slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 15);
}

/* ─── Single non-streaming Ollama call ──────────────────────────────────── */

interface CallResult { text: string; latencyMs: number; promptTokens: number; evalTokens: number }

/**
 * Parse an Ollama /api/chat response body.
 * Handles both:
 *  - stream:false — single JSON object
 *  - stream:true  — NDJSON (multiple JSON lines); Ollama cloud models sometimes
 *    ignore stream:false and stream anyway
 */
function parseOllamaBody(body: string): { text: string; promptTokens: number; evalTokens: number } {
  // Try single JSON first (expected for stream:false)
  try {
    const data = JSON.parse(body);
    // Qwen3/QwQ thinking models: content may be empty when thinking tokens fill
    // num_predict budget; fall back to the thinking field so we at least get something.
    const text = (data.message?.content as string | undefined)
      || (data.message?.thinking as string | undefined)
      || "";
    return { text, promptTokens: data.prompt_eval_count ?? 0, evalTokens: data.eval_count ?? 0 };
  } catch {
    // Fall back to NDJSON (stream:true response despite stream:false request)
    let text = "";
    let promptTokens = 0;
    let evalTokens = 0;
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const chunk = JSON.parse(trimmed);
        if (chunk.message?.content) text += chunk.message.content as string;
        if (chunk.done) {
          promptTokens = chunk.prompt_eval_count ?? 0;
          evalTokens = chunk.eval_count ?? 0;
        }
      } catch { /* skip malformed lines */ }
    }
    return { text, promptTokens, evalTokens };
  }
}

async function ollamaCall(
  endpoint: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
  timeoutMs: number,
): Promise<CallResult> {
  const request = {
    model,
    stream: false,
    // think:false disables extended thinking mode on Qwen3/QwQ models in Ollama.
    // Without this, thinking tokens consume num_predict before any content is emitted.
    // Ignored by models that do not support the option.
    think: false,
    options: { temperature: 0.1, num_predict: 2000, top_p: 0.9, repeat_penalty: 1.1 },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  };

  const t0 = Date.now();
  const res = await nodePost(`${endpoint}/api/chat`, JSON.stringify(request), timeoutMs);
  const latencyMs = Date.now() - t0;

  if (!res.ok) throw new Error(`Ollama API error: HTTP ${res.status} — ${res.body.slice(0, 200)}`);

  const parsed = parseOllamaBody(res.body);
  if (!parsed.text) {
    console.warn("[Fidelity] ollamaCall returned empty content. Body preview:", res.body.slice(0, 300));
  }
  return {
    text: parsed.text,
    latencyMs,
    promptTokens: parsed.promptTokens,
    evalTokens: parsed.evalTokens,
  };
}

async function openAICompatibleCall(
  endpoint: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
  timeoutMs: number,
  apiKey?: string,
): Promise<CallResult> {
  const payload = {
    model,
    stream: false,
    temperature: 0.1,
    top_p: 0.9,
    max_tokens: 2000,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;

  const url = `${endpoint.replace(/\/+$/, "")}/v1/chat/completions`;
  const t0 = Date.now();
  const res = await nodePostWithHeaders(url, JSON.stringify(payload), headers, timeoutMs);
  const latencyMs = Date.now() - t0;
  if (!res.ok) throw new Error(`OpenAI-compatible API error: HTTP ${res.status} — ${res.body.slice(0, 200)}`);

  const data = JSON.parse(res.body);
  return {
    text: data?.choices?.[0]?.message?.content || "",
    latencyMs,
    promptTokens: data?.usage?.prompt_tokens ?? 0,
    evalTokens: data?.usage?.completion_tokens ?? 0,
  };
}

/* ─── Public API ─────────────────────────────────────────────────────────── */

export interface FidelityEvalOptions {
  /** Full Ollama endpoint, e.g. "http://localhost:11434". */
  endpoint: string;
  /** Model name to use for all three calls (diagnose A, diagnose B, judge). */
  model: string;
  /** API provider used by the chat runtime. */
  provider?: ApiProvider;
  /** Optional API key for OpenAI-compatible endpoints. */
  apiKey?: string;
  /**
   * The diagnostic prompt template.
   * Use {{data}} as placeholder for the K8s context block.
   * Defaults to a concise SRE root-cause prompt.
   */
  diagnosticPrompt?: string;
  /** Per-call timeout in ms. Defaults to 120 000 (2 min). */
  timeoutMs?: number;
  /**
   * Authoritative list of all known resource names in the cluster
   * (namespaces, pod names, deployment names, service names, node names).
   * When provided, this is passed directly to the judge — no regex extraction needed.
   */
  knownResourceNames?: string[];
}

const DEFAULT_DIAGNOSTIC_PROMPT = `You are a senior Kubernetes SRE. Analyse the following cluster data and identify the primary problem.
Be concise: state the Root Cause in one sentence, list the top 2-3 supporting signals, and name the affected resource(s).

{{data}}`;

const JUDGE_SYSTEM = `You are an expert evaluator comparing two Kubernetes SRE diagnoses.
Diagnosis A was produced from COMPLETE cluster data.
Diagnosis B was produced from COMPRESSED cluster data.
Your task: assess whether B retains all the critical information from A.
You must follow the output format exactly.`;

const JUDGE_USER_TEMPLATE = `KNOWN RESOURCES (extracted from the raw cluster data — use this list for hallucination detection):
{{knownNames}}

DIAGNOSIS A (from complete data):
---
{{diagA}}
---

DIAGNOSIS B (from compressed data):
---
{{diagB}}
---

Does Diagnosis B retain all critical information from Diagnosis A?

Reply using EXACTLY this format. Do NOT use markdown. Do NOT add any other sections.

SCORE: <integer 1-5>

HALLUCINATED_RESOURCES: <comma-separated list of resource names cited in B that are NOT in the KNOWN RESOURCES list above, or "none">

DISCREPANCIES_JSON: <valid JSON array, or []>

EXPLANATION:
<plain text, no markdown, no bullet points, no headers>

Rules:
- SCORE 5 = identical critical content. SCORE 1 = completely different or misleading.
- HALLUCINATED_RESOURCES: only Kubernetes resource names (pods, deployments, services, nodes). Ignore generic English words.
- DISCREPANCIES_JSON: array of objects with keys "type" (missing_info | wrong_severity | extra_info) and "description" (one plain sentence). Maximum 5 items. Use [] if none.
- Do NOT include hallucinations in DISCREPANCIES_JSON.
- EXPLANATION: plain text only.`;

/**
 * Run a fidelity evaluation: compare model output on raw vs compressed K8s data.
 *
 * Both diagnostic calls are fired in parallel; the judge call runs after both complete.
 *
 * @param rawData   The original K8s context (JSON string or serialisable object).
 * @param compressed  The compressed context string (output of compressForPrompt/buildSystemPrompt).
 * @param options   Endpoint, model, optional overrides.
 */
export async function runFidelityEvaluation(
  rawData: string | object,
  compressed: string,
  options: FidelityEvalOptions,
): Promise<FidelityReport> {
  const { endpoint, model, provider = "ollama", apiKey, timeoutMs = 120_000 } = options;
  const diagPromptTemplate = options.diagnosticPrompt ?? DEFAULT_DIAGNOSTIC_PROMPT;
  const rawStr = typeof rawData === "string" ? rawData : JSON.stringify(rawData, null, 2);

  // Build the two diagnostic prompts
  const promptA = diagPromptTemplate.replace("{{data}}", rawStr);
  const promptB = diagPromptTemplate.replace("{{data}}", compressed);

  const systemPrompt = "You are a senior Kubernetes SRE assistant.";

  console.log("[Fidelity] Starting evaluation — model:", model, "| raw chars:", rawStr.length, "| compressed chars:", compressed.length);

  const callModel = provider === "openai-compatible"
    ? (systemPrompt: string, userPrompt: string) => openAICompatibleCall(endpoint, model, systemPrompt, userPrompt, timeoutMs, apiKey)
    : (systemPrompt: string, userPrompt: string) => ollamaCall(endpoint, model, systemPrompt, userPrompt, timeoutMs);

  // ── Step 1: Run both diagnostic calls in parallel ───────────────────────
  const [resultA, resultB] = await Promise.all([
    callModel(systemPrompt, promptA),
    callModel(systemPrompt, promptB),
  ]);

  console.log("[Fidelity] DiagA:", resultA.text.length, "chars,", resultA.latencyMs, "ms");
  console.log("[Fidelity] DiagB:", resultB.text.length, "chars,", resultB.latencyMs, "ms");

  // ── Step 2: Build known names list ─────────────────────────────────────────
  // Prefer the authoritative list passed from the caller (built from structured
  // ClusterContext — 100% accurate). Fall back to regex extraction only if not provided.
  let knownNamesList: string;
  if (options.knownResourceNames && options.knownResourceNames.length > 0) {
    knownNamesList = options.knownResourceNames.map((n) => n.toLowerCase()).join(", ");
    console.log("[Fidelity] Known resource names (structured):", options.knownResourceNames.length, "entries");
  } else {
    const knownNamesSet = extractResourceNames(rawStr);
    knownNamesList = [...knownNamesSet]
      .filter((n) => /\d/.test(n) || n.split("-").length >= 3)
      .slice(0, 120)
      .join(", ") || "(none extracted)";
    console.log("[Fidelity] Known resource names (regex fallback):", knownNamesList.slice(0, 200));
  }

  // ── Step 3: Judge call ──────────────────────────────────────────────────
  let judgeScore: number | null = null;
  let judgeExplanation = "(judge call skipped)";
  let discrepancies: FidelityDiscrepancy[] = [];
  let hallucinatedResources: string[] = [];

  try {
    const judgeUserMsg = JUDGE_USER_TEMPLATE
      .replace("{{knownNames}}", knownNamesList)
      .replace("{{diagA}}", resultA.text)
      .replace("{{diagB}}", resultB.text);

    const judgeResult = await callModel(JUDGE_SYSTEM, judgeUserMsg);
    judgeScore = parseJudgeScore(judgeResult.text);

    // Parse HALLUCINATED_RESOURCES section from judge response
    const hallucinatedMatch = judgeResult.text.match(/HALLUCINATED_RESOURCES:\s*([^\n]+)/i);
    const hallucinatedRaw = hallucinatedMatch ? hallucinatedMatch[1].trim() : "";
    hallucinatedResources = hallucinatedRaw.toLowerCase() === "none" || !hallucinatedRaw
      ? []
      : hallucinatedRaw.split(/,\s*/).map((s) => s.trim()).filter((s) => s.length > 2);
    console.log("[Fidelity] Hallucinated resources (judge):", hallucinatedResources.length > 0 ? hallucinatedResources : "none");

    // Show only the EXPLANATION section in the UI; fall back to full text if format was ignored
    const explanationMatch = judgeResult.text.match(/EXPLANATION:\s*([\s\S]+)/i);
    judgeExplanation = explanationMatch ? explanationMatch[1].trim() : judgeResult.text;
    discrepancies = extractDiscrepancies(judgeResult.text, hallucinatedResources);
    console.log("[Fidelity] Judge score:", judgeScore, "| discrepancies:", discrepancies.length);
  } catch (e: any) {
    console.warn("[Fidelity] Judge call failed:", e?.message);
    judgeExplanation = `(judge call failed: ${e?.message ?? "unknown error"})`;
    // Still produce discrepancies from hallucinationcheck alone
    discrepancies = extractDiscrepancies("", hallucinatedResources);
  }

  // ── Step 4: Metrics ─────────────────────────────────────────────────────

  // compressionRatio: fraction of characters removed
  const compressionRatio = rawStr.length > 0
    ? Math.max(0, 1 - compressed.length / rawStr.length)
    : 0;

  // Token savings (approximate)
  const rawTokens = resultA.promptTokens > 0 ? resultA.promptTokens : approxTokens(rawStr);
  const compTokens = resultB.promptTokens > 0 ? resultB.promptTokens : approxTokens(compressed);
  const tokenSavings = rawTokens - compTokens;

  const latencyDifferenceMs = resultA.latencyMs - resultB.latencyMs;

  // Composite score: 70% judge (normalised to 0-1), 30% hallucination penalty
  const judgeNorm = judgeScore != null ? (judgeScore - 1) / 4 : 0.5; // 1-5 → 0-1
  const hallucinationPenalty = Math.min(0.3, hallucinatedResources.length * 0.05);
  const score = Math.max(0, Math.min(1, judgeNorm - hallucinationPenalty));

  return {
    score: Math.round(score * 100) / 100,
    judgeScore,
    compressionRatio: Math.round(compressionRatio * 1000) / 1000,
    tokenSavings,
    rawLatencyMs: resultA.latencyMs,
    compressedLatencyMs: resultB.latencyMs,
    latencyDifferenceMs,
    hallucinatedResources,
    discrepancies,
    diagnosisA: resultA.text,
    diagnosisB: resultB.text,
    judgeExplanation,
    evaluatedAt: new Date().toISOString(),
    model,
  };
}
