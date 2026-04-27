/**
 * Copyright (c) 2026 Freelens K8s SRE Assistant Authors.
 * Licensed under MIT License.
 *
 * Streaming-safe Markdown renderer for chat messages.
 *
 * Instead of regex-replacing markdown inline (which breaks during streaming
 * when code fences are still open), we split the content into *blocks* first
 * (code blocks vs prose) and render each block independently. Incomplete
 * code fences are rendered as `<pre>` so text never "jumps" between styles.
 */

import { useEffect, useMemo, useRef, useState } from "react";

/* ── public component ─────────────────────────────────────────────── */

interface MarkdownRendererProps {
  content: string;
}

/**
 * Split content into prose/mermaid segments so mermaid blocks can be rendered
 * as isolated React components while the rest remains as HTML.
 */
interface Segment {
  type: "html" | "mermaid";
  content: string;
}

function splitMermaidSegments(content: string): Segment[] {
  const segments: Segment[] = [];
  const mermaidRe = /```mermaid\n([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = mermaidRe.exec(content)) !== null) {
    if (match.index > last) {
      segments.push({ type: "html", content: content.slice(last, match.index) });
    }
    segments.push({ type: "mermaid", content: match[1].trim() });
    last = match.index + match[0].length;
  }
  if (last < content.length) {
    segments.push({ type: "html", content: content.slice(last) });
  }
  return segments.length > 0 ? segments : [{ type: "html", content }];
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const segments = useMemo(() => splitMermaidSegments(content), [content]);
  return (
    <div className="k8s-sre-md">
      {segments.map((seg, i) =>
        seg.type === "mermaid"
          ? <MermaidBlock key={i} source={seg.content} />
          : <HtmlBlock key={i} content={seg.content} />,
      )}
    </div>
  );
}

function HtmlBlock({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

/* ── Canvas-based graph renderer ─────────────────────────────────── */

interface GNode { id: string; label: string; }
interface GEdge { from: string; to: string; label?: string; }

interface GraphLayout {
  nodes: Array<GNode & { x: number; y: number; w: number; h: number }>;
  edges: GEdge[];
  width: number;
  height: number;
  isLR: boolean;
}

// Color-code nodes by Kubernetes resource kind
const KIND_PALETTE: Array<[RegExp, string, string]> = [
  [/^pod/i,              "#a6e3a1", "rgba(166,227,161,.13)"],
  [/^(deploy|replica|stateful|daemon)/i, "#89dceb", "rgba(137,220,235,.13)"],
  [/^(service|svc)/i,   "#89b4fa", "rgba(137,180,250,.13)"],
  [/^ingress/i,          "#cba6f7", "rgba(203,166,247,.13)"],
  [/^(configmap|cm)/i,  "#f9e2af", "rgba(249,226,175,.13)"],
  [/^secret/i,           "#fab387", "rgba(250,179,135,.13)"],
  [/^(pvc|pv|volume)/i,  "#f38ba8", "rgba(243,139,168,.13)"],
  [/^(hpa|node)/i,       "#94e2d5", "rgba(148,226,213,.13)"],
];

function nodeColor(label: string): [string, string] {
  const s = label.toLowerCase().replace(/^[^a-z]+/, "");
  for (const [re, stroke, fill] of KIND_PALETTE) {
    if (re.test(s)) return [stroke, fill];
  }
  return ["#89b4fa", "rgba(137,180,250,.13)"];
}

function parseMermaidGraph(src: string): { nodes: Map<string, GNode>; edges: GEdge[]; isLR: boolean } | null {
  const lines = src.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("%%"));
  if (!lines.length) return null;

  const header = lines[0].match(/^(?:graph|flowchart)\s+(TD|LR|BT|RL|TB)\b/i);
  if (!header) return null;
  const rawDir = header[1].toUpperCase();
  const isLR = rawDir === "LR" || rawDir === "RL";

  const nodes = new Map<string, GNode>();
  const edges: GEdge[] = [];

  // Strip bracket wrappers, surrounding quotes, HTML tags (<br/>, etc.)
  const strip = (s?: string) =>
    s?.replace(/^[\[({>]/g, "")
      .replace(/[\])}]$/g, "")
      .replace(/^"|"$/g, "")
      .replace(/<br\s*\/?>/gi, " · ")
      .replace(/<[^>]+>/g, "")
      .trim();
  const ensure = (id: string, lbl?: string) => {
    if (!nodes.has(id)) nodes.set(id, { id, label: lbl ?? id });
    else if (lbl) nodes.get(id)!.label = lbl;
  };

  for (const line of lines.slice(1)) {
    if (/^(subgraph|end|style|class|classDef)\b/.test(line)) continue;

    // A[lbl] -->|edgeLbl| B[lbl]  or  A --> B  etc.
    const e1 = line.match(
      /^([A-Za-z0-9_-]+)([\[({>][^\])}]*[\])}])?\s*(?:--[>.\-]+|==>[>]?)\s*(?:\|([^|]*)\|)?\s*([A-Za-z0-9_-]+)([\[({>][^\])}]*[\])}])?/
    );
    if (e1) {
      ensure(e1[1], strip(e1[2]));
      ensure(e1[4], strip(e1[5]));
      edges.push({ from: e1[1], to: e1[4], label: e1[3]?.trim() || undefined });
      continue;
    }

    // A -- text --> B
    const e2 = line.match(
      /^([A-Za-z0-9_-]+)([\[({>][^\])}]*[\])}])?\s*--\s+(.+?)\s+-->\s*([A-Za-z0-9_-]+)([\[({>][^\])}]*[\])}])?/
    );
    if (e2) {
      ensure(e2[1], strip(e2[2]));
      ensure(e2[4], strip(e2[5]));
      edges.push({ from: e2[1], to: e2[4], label: e2[3]?.trim() || undefined });
      continue;
    }

    // standalone node declaration
    const n = line.match(/^([A-Za-z0-9_-]+)([\[({>][^\])}]*[\])}])/);
    if (n) ensure(n[1], strip(n[2]));
  }

  return nodes.size > 0 ? { nodes, edges, isLR } : null;
}

function buildLayout(nodes: Map<string, GNode>, edges: GEdge[], isLR: boolean): GraphLayout {
  const NW = 144, NH = 38, HGAP = 44, VGAP = 60, PAD = 20;

  // BFS level assignment
  const inDeg = new Map<string, number>();
  const adj   = new Map<string, string[]>();
  for (const id of nodes.keys()) { inDeg.set(id, 0); adj.set(id, []); }
  for (const { from, to } of edges) {
    inDeg.set(to, (inDeg.get(to) ?? 0) + 1);
    adj.get(from)?.push(to);
  }

  const lvl  = new Map<string, number>();
  const queue = [...nodes.keys()].filter(id => (inDeg.get(id) ?? 0) === 0);
  if (!queue.length) queue.push([...nodes.keys()][0]); // cycle guard
  queue.forEach(id => lvl.set(id, 0));

  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi], cl = lvl.get(cur) ?? 0;
    for (const nxt of (adj.get(cur) ?? [])) {
      if (!lvl.has(nxt) || (lvl.get(nxt) ?? 0) < cl + 1) {
        lvl.set(nxt, cl + 1);
        queue.push(nxt);
      }
    }
  }
  for (const id of nodes.keys()) if (!lvl.has(id)) lvl.set(id, 0);

  const byLevel = new Map<number, string[]>();
  for (const [id, l] of lvl) {
    if (!byLevel.has(l)) byLevel.set(l, []);
    byLevel.get(l)!.push(id);
  }
  const maxL = Math.max(...byLevel.keys());

  type LN = GNode & { x: number; y: number; w: number; h: number };
  const laid: LN[] = [];

  if (isLR) {
    const maxRows = Math.max(...[...byLevel.values()].map(a => a.length));
    const totalH  = maxRows * NH + (maxRows - 1) * HGAP;
    for (let l = 0; l <= maxL; l++) {
      const ids = byLevel.get(l) ?? [];
      const x = PAD + l * (NW + VGAP);
      const bh = ids.length * NH + (ids.length - 1) * HGAP;
      const sy = PAD + (totalH - bh) / 2;
      ids.forEach((id, i) => laid.push({ ...nodes.get(id)!, x, y: sy + i * (NH + HGAP), w: NW, h: NH }));
    }
    return { nodes: laid, edges, isLR,
      width:  PAD * 2 + (maxL + 1) * NW + maxL * VGAP,
      height: PAD * 2 + Math.max(...[...byLevel.values()].map(ids => ids.length * NH + (ids.length - 1) * HGAP)),
    };
  } else {
    const maxCols = Math.max(...[...byLevel.values()].map(a => a.length));
    const totalW  = maxCols * NW + (maxCols - 1) * HGAP;
    for (let l = 0; l <= maxL; l++) {
      const ids = byLevel.get(l) ?? [];
      const y = PAD + l * (NH + VGAP);
      const bw = ids.length * NW + (ids.length - 1) * HGAP;
      const sx = PAD + (totalW - bw) / 2;
      ids.forEach((id, i) => laid.push({ ...nodes.get(id)!, x: sx + i * (NW + HGAP), y, w: NW, h: NH }));
    }
    return { nodes: laid, edges, isLR,
      width:  PAD * 2 + totalW,
      height: PAD * 2 + (maxL + 1) * NH + maxL * VGAP,
    };
  }
}

function paintGraph(canvas: HTMLCanvasElement, layout: GraphLayout) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = layout.width  * dpr;
  canvas.height = layout.height * dpr;
  canvas.style.width  = `${layout.width}px`;
  canvas.style.height = `${layout.height}px`;

  const c = canvas.getContext("2d")!;
  c.scale(dpr, dpr);
  c.fillStyle = "#11111b";
  c.fillRect(0, 0, layout.width, layout.height);

  const nm = new Map(layout.nodes.map(n => [n.id, n]));

  // edges
  for (const edge of layout.edges) {
    const f = nm.get(edge.from), t = nm.get(edge.to);
    if (!f || !t) continue;

    let x1: number, y1: number, x2: number, y2: number;
    let cp1x: number, cp1y: number, cp2x: number, cp2y: number;

    if (layout.isLR) {
      x1 = f.x + f.w; y1 = f.y + f.h / 2;
      x2 = t.x;       y2 = t.y + t.h / 2;
      const mid = (x1 + x2) / 2;
      cp1x = mid; cp1y = y1; cp2x = mid; cp2y = y2;
    } else {
      x1 = f.x + f.w / 2; y1 = f.y + f.h;
      x2 = t.x + t.w / 2; y2 = t.y;
      const mid = (y1 + y2) / 2;
      cp1x = x1; cp1y = mid; cp2x = x2; cp2y = mid;
    }

    c.beginPath();
    c.moveTo(x1, y1);
    c.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
    c.strokeStyle = "#585b70";
    c.lineWidth = 1.5;
    c.stroke();

    // arrowhead at (x2, y2) pointing from last control point
    const ang = Math.atan2(y2 - cp2y, x2 - cp2x);
    const hs = 7;
    c.beginPath();
    c.moveTo(x2, y2);
    c.lineTo(x2 - hs * Math.cos(ang - 0.38), y2 - hs * Math.sin(ang - 0.38));
    c.lineTo(x2 - hs * Math.cos(ang + 0.38), y2 - hs * Math.sin(ang + 0.38));
    c.closePath();
    c.fillStyle = "#585b70";
    c.fill();

    // edge label
    if (edge.label) {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      c.font = "10px system-ui,sans-serif";
      const tw = c.measureText(edge.label).width;
      c.fillStyle = "rgba(17,17,27,.85)";
      c.fillRect(mx - tw / 2 - 3, my - 7, tw + 6, 14);
      c.fillStyle = "#a6adc8";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(edge.label, mx, my);
    }
  }

  // nodes
  c.textAlign = "center";
  c.textBaseline = "middle";
  for (const n of layout.nodes) {
    const [stroke, fill] = nodeColor(n.label);
    const r = 6;
    c.beginPath();
    c.moveTo(n.x + r, n.y);
    c.lineTo(n.x + n.w - r, n.y);
    c.arcTo(n.x + n.w, n.y,      n.x + n.w, n.y + r,      r);
    c.lineTo(n.x + n.w, n.y + n.h - r);
    c.arcTo(n.x + n.w, n.y + n.h, n.x + n.w - r, n.y + n.h, r);
    c.lineTo(n.x + r, n.y + n.h);
    c.arcTo(n.x, n.y + n.h,      n.x, n.y + n.h - r, r);
    c.lineTo(n.x, n.y + r);
    c.arcTo(n.x, n.y,            n.x + r, n.y,        r);
    c.closePath();
    c.fillStyle = fill;
    c.fill();
    c.strokeStyle = stroke;
    c.lineWidth = 1;
    c.stroke();

    c.font = "11px 'JetBrains Mono',Menlo,monospace";
    c.fillStyle = "#cdd6f4";
    // Strip Kind/ prefix — the node color already conveys the resource kind
    let lbl = n.label.replace(/^[A-Za-z]+\//, "");
    const maxW = n.w - 14;
    while (c.measureText(lbl).width > maxW && lbl.length > 2) lbl = lbl.slice(0, -1);
    if (lbl.length < n.label.length) lbl = lbl.slice(0, -1) + "…";
    c.fillText(lbl, n.x + n.w / 2, n.y + n.h / 2);
  }
}

/** Renders a mermaid graph definition on an HTML Canvas — no external library. */
function MermaidBlock({ source }: { source: string }) {
  const canvasRef      = useRef<HTMLCanvasElement>(null);
  const modalCanvasRef = useRef<HTMLCanvasElement>(null);
  const [expanded, setExpanded] = useState(false);

  const layout = useMemo((): GraphLayout | null => {
    try {
      const parsed = parseMermaidGraph(source);
      if (!parsed) return null;
      return buildLayout(parsed.nodes, parsed.edges, parsed.isLR);
    } catch { return null; }
  }, [source]);

  // Paint inline canvas
  useEffect(() => {
    if (!layout || !canvasRef.current) return;
    try { paintGraph(canvasRef.current, layout); } catch { /* silently skip bad diagrams */ }
  }, [layout]);

  // Paint modal canvas when it becomes visible
  useEffect(() => {
    if (!expanded || !layout || !modalCanvasRef.current) return;
    try { paintGraph(modalCanvasRef.current, layout); } catch {}
  }, [expanded, layout]);

  function handleSavePng() {
    const c = canvasRef.current;
    if (!c) return;
    const url = c.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = "k8s-graph.png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  const toolbarBtnStyle: React.CSSProperties = {
    padding: "2px 10px",
    fontSize: "11px",
    border: "1px solid var(--borderColor,#313244)",
    borderRadius: 6,
    background: "rgba(137,180,250,.1)",
    color: "#89b4fa",
    cursor: "pointer",
  };

  if (!layout) {
    return (
      <>
        <div className="code-header"><span>diagram</span></div>
        <pre><code>{source}</code></pre>
      </>
    );
  }

  return (
    <div style={{ margin: "8px 0" }}>
      {/* toolbar */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginBottom: 4 }}>
        <button style={toolbarBtnStyle} onClick={handleSavePng} title="Save as PNG">&#8659; PNG</button>
        <button style={toolbarBtnStyle} onClick={() => setExpanded(true)} title="Expand diagram">⛶ Expand</button>
      </div>
      {/* inline canvas — scrollable if graph is wider than the chat panel */}
      <div style={{ overflow: "auto", borderRadius: 8, border: "1px solid var(--borderColor,#313244)" }}>
        <canvas ref={canvasRef} style={{ display: "block" }} />
      </div>
      {/* legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", padding: "6px 2px 0", fontSize: "10px", color: "#a6adc8" }}>
        {([
          ["Pod",          "#a6e3a1", "rgba(166,227,161,.18)"],
          ["Deploy / SS / DS", "#89dceb", "rgba(137,220,235,.18)"],
          ["Service",      "#89b4fa", "rgba(137,180,250,.18)"],
          ["Ingress",      "#cba6f7", "rgba(203,166,247,.18)"],
          ["ConfigMap",    "#f9e2af", "rgba(249,226,175,.18)"],
          ["Secret",       "#fab387", "rgba(250,179,135,.18)"],
          ["PVC / Volume", "#f38ba8", "rgba(243,139,168,.18)"],
          ["HPA / Node",   "#94e2d5", "rgba(148,226,213,.18)"],
        ] as Array<[string, string, string]>).map(([name, stroke, fill]) => (
          <span key={name} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: fill, border: `1px solid ${stroke}`, flexShrink: 0 }} />
            {name}
          </span>
        ))}
      </div>
      {/* expand modal */}
      {expanded && (
        <div
          style={{
            position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
            background: "rgba(17,17,27,.92)", zIndex: 9999,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onClick={() => setExpanded(false)}
        >
          <div
            style={{
              position: "relative",
              maxWidth: "92vw", maxHeight: "92vh",
              overflow: "auto", borderRadius: 12,
              border: "1px solid var(--borderColor,#313244)",
              background: "#11111b",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, padding: "10px 14px 6px" }}>
              <button style={toolbarBtnStyle} onClick={handleSavePng} title="Save as PNG">&#8659; Save PNG</button>
              <button
                style={{ ...toolbarBtnStyle, color: "#f38ba8", borderColor: "rgba(243,139,168,.35)", background: "rgba(243,139,168,.08)" }}
                onClick={() => setExpanded(false)}
              >
                ✕ Close
              </button>
            </div>
            <canvas ref={modalCanvasRef} style={{ display: "block", margin: "0 16px 16px" }} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ── CSS injected once ────────────────────────────────────────────── */

const MD_STYLES = `
.k8s-sre-md { font-size:13px; line-height:1.6; }
.k8s-sre-md h1,.k8s-sre-md h2,.k8s-sre-md h3,.k8s-sre-md h4 {
  margin:12px 0 4px; font-weight:600; color:var(--textColorPrimary,#cdd6f4);
}
.k8s-sre-md h1 { font-size:18px; }
.k8s-sre-md h2 { font-size:16px; }
.k8s-sre-md h3 { font-size:14px; }
.k8s-sre-md h4 { font-size:13px; }
.k8s-sre-md p  { margin:6px 0; }
.k8s-sre-md ul,.k8s-sre-md ol { margin:4px 0; padding-left:20px; }
.k8s-sre-md li { margin:2px 0; }
.k8s-sre-md strong { font-weight:600; }
.k8s-sre-md em { font-style:italic; }
.k8s-sre-md hr { border:none; border-top:1px solid var(--borderColor,#313244); margin:10px 0; }
.k8s-sre-md a { color:#89b4fa; text-decoration:none; }
.k8s-sre-md a:hover { text-decoration:underline; }
.k8s-sre-md code {
  font-family:'JetBrains Mono','Fira Code','Cascadia Code',Menlo,Monaco,Consolas,monospace;
  font-size:12px;
  background:rgba(137,180,250,.1);
  color:#89b4fa;
  padding:1px 5px;
  border-radius:3px;
}
.k8s-sre-md pre {
  margin:8px 0;
  padding:12px 14px;
  border-radius:8px;
  background:#11111b;
  border:1px solid var(--borderColor,#313244);
  overflow-x:auto;
}
.k8s-sre-md pre code {
  background:none;
  color:#cdd6f4;
  padding:0;
  font-size:12px;
  line-height:1.5;
  white-space:pre;
}
.k8s-sre-md .code-header {
  display:flex; justify-content:space-between; align-items:center;
  padding:4px 14px;
  background:rgba(137,180,250,.08);
  border-radius:8px 8px 0 0;
  border:1px solid var(--borderColor,#313244);
  border-bottom:none;
  font-size:11px; color:var(--textColorSecondary,#a6adc8);
}
.k8s-sre-md .code-header+pre { border-radius:0 0 8px 8px; margin-top:0; }
.k8s-sre-md table {
  border-collapse:collapse; margin:8px 0; width:100%; font-size:12px;
}
.k8s-sre-md th,.k8s-sre-md td {
  padding:6px 10px;
  border:1px solid var(--borderColor,#313244);
  text-align:left;
}
.k8s-sre-md th {
  background:rgba(137,180,250,.08);
  font-weight:600;
}
.k8s-sre-md blockquote {
  margin:6px 0; padding:4px 12px;
  border-left:3px solid #89b4fa;
  color:var(--textColorSecondary,#a6adc8);
}
`;

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  try {
    const s = document.createElement("style");
    s.textContent = MD_STYLES;
    document.head.appendChild(s);
  } catch { /* SSR-safe */ }
}

/* ── block-level parser ───────────────────────────────────────────── */

interface Block {
  type: "code" | "prose";
  lang?: string;
  content: string;
  closed: boolean; // code blocks: whether the closing ``` was found
}

/**
 * Split raw markdown into code blocks and prose blocks.
 * Handles incomplete (still-streaming) code fences gracefully.
 */
function splitBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.split("\n");
  let current: Block | null = null;

  for (const line of lines) {
    if (current?.type === "code" && !current.closed) {
      // inside a code block
      if (/^```\s*$/.test(line)) {
        current.closed = true;
        current = null;
      } else {
        current.content += (current.content ? "\n" : "") + line;
      }
    } else if (/^```(\w*)/.test(line)) {
      // open a new code block
      const lang = line.match(/^```(\w*)/)?.[1] || "";
      current = { type: "code", lang, content: "", closed: false };
      blocks.push(current);
    } else {
      // prose
      if (!current || current.type !== "prose") {
        current = { type: "prose", content: "", closed: true };
        blocks.push(current);
      }
      current.content += (current.content ? "\n" : "") + line;
    }
  }

  return blocks;
}

/* ── render pipeline ──────────────────────────────────────────────── */

function renderMarkdown(md: string): string {
  ensureStyles();
  const blocks = splitBlocks(md);
  return blocks.map(renderBlock).join("");
}

function renderBlock(block: Block): string {
  if (block.type === "code") {
    return renderCodeBlock(block);
  }
  return renderProse(block.content);
}

function renderCodeBlock(block: Block): string {
  const escaped = escapeHtml(block.content);
  if (block.lang === "mermaid") {
    // Mermaid diagrams are not supported — render as a styled info block
    return `<div class="code-header"><span>diagram (text)</span></div><pre><code>${escaped}</code></pre>`;
  }
  if (block.lang) {
    const header = `<div class="code-header"><span>${escapeHtml(block.lang)}</span></div>`;
    return `${header}<pre><code>${escaped}</code></pre>`;
  }
  return `<pre><code>${escaped}</code></pre>`;
}

/**
 * Render a prose block: tables, headers, bold, italic, lists, links, etc.
 * We only apply inline markdown transforms to prose — never inside code blocks.
 *
 * Tables are detected first and rendered to HTML. Lines that are part of a
 * rendered table are marked with a sentinel prefix so the line-by-line
 * processor passes them through without escaping.
 */
const TABLE_HTML_SENTINEL = "\x00TABLE_HTML\x00";

function renderProse(text: string): string {
  // Tables first (multi-line structure) — returns mix of raw lines and
  // sentinel-prefixed HTML lines for table output.
  const withTables = processSimpleTables(text);

  // Process line by line for block-level elements
  const lines = withTables.split("\n");
  const out: string[] = [];
  let inUl = false;
  let inOl = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Table HTML lines — already rendered, pass through
    if (line.startsWith(TABLE_HTML_SENTINEL)) {
      closeList();
      out.push(line.slice(TABLE_HTML_SENTINEL.length));
      continue;
    }

    // Headers
    const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      closeList();
      const level = hMatch[1].length;
      out.push(`<h${level}>${inlineFormat(escapeHtml(hMatch[2]))}</h${level}>`);
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      closeList();
      out.push("<hr/>");
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      closeList();
      out.push(`<blockquote>${inlineFormat(escapeHtml(line.slice(2)))}</blockquote>`);
      continue;
    }

    // Unordered list item
    const ulMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (ulMatch) {
      if (!inUl) { closeList(); out.push("<ul>"); inUl = true; }
      out.push(`<li>${inlineFormat(escapeHtml(ulMatch[1]))}</li>`);
      continue;
    }

    // Ordered list item
    const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (olMatch) {
      if (!inOl) { closeList(); out.push("<ol>"); inOl = true; }
      out.push(`<li>${inlineFormat(escapeHtml(olMatch[1]))}</li>`);
      continue;
    }

    // Regular text / blank line
    closeList();
    const trimmed = line.trim();
    if (!trimmed) {
      // Empty line = paragraph break (skip consecutive)
      if (out.length > 0 && out[out.length - 1] !== "<br/>") {
        out.push("<br/>");
      }
    } else {
      out.push(`<p>${inlineFormat(escapeHtml(trimmed))}</p>`);
    }
  }
  closeList();
  return out.join("\n");

  function closeList() {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  }
}

/** Apply inline formatting (bold, italic, code, links) to already-escaped HTML */
function inlineFormat(html: string): string {
  // Inline code (must be before bold/italic so backtick content is protected)
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold + italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Links  [text](url)
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );

  return html;
}

/* ── helpers ───────────────────────────────────────────────────────── */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function processSimpleTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith("|") && line.endsWith("|")) {
      const nextLine = lines[i + 1]?.trim() || "";
      const isSeparator = /^\|[\s\-:|]+\|$/.test(nextLine);

      if (!inTable) {
        result.push(TABLE_HTML_SENTINEL + "<table>");
        inTable = true;
        const cells = line.split("|").filter((c) => c.trim());
        result.push(TABLE_HTML_SENTINEL + "<tr>" + cells.map((c) => `<th>${inlineFormat(escapeHtml(c.trim()))}</th>`).join("") + "</tr>");
        if (isSeparator) i++;
      } else if (/^\|[\s\-:|]+\|$/.test(line)) {
        // skip separator rows inside table
      } else {
        const cells = line.split("|").filter((c) => c.trim());
        result.push(TABLE_HTML_SENTINEL + "<tr>" + cells.map((c) => `<td>${inlineFormat(escapeHtml(c.trim()))}</td>`).join("") + "</tr>");
      }
    } else {
      if (inTable) { result.push(TABLE_HTML_SENTINEL + "</table>"); inTable = false; }
      result.push(lines[i]);
    }
  }
  if (inTable) result.push(TABLE_HTML_SENTINEL + "</table>");
  return result.join("\n");
}
