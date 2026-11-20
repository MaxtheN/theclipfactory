// Architecture diagrams as hand-placed boxes and arrows, rendered to accessible inline SVG. The Mermaid versions in
// docs/architecture.md describe the same structure for readers of the repository.
import { escapeHtml } from "./markdown.mjs";

const node = (id, x, y, w, h, kind, label, sub = "") => ({ id, x, y, w, h, kind, label, sub });

export const DIAGRAMS = {
  "system-context": {
    title: "System context",
    desc: "You use the Growth Factory app on your computer, which keeps your library and runs local AI and media tools. It talks to the Growth Factory cloud for sign-in, posting and billing, and optionally to cloud models with your own key. The cloud uses Stripe for subscriptions and Zernio to publish to seven social platforms. The website hosts the docs, pricing and Checkout return pages.",
    size: [1220, 600],
    groups: [{ x: 330, y: 20, w: 360, h: 560, label: "Your computer" }],
    nodes: [
      node("you", 20, 85, 150, 90, "you", "You", "Creator or team"),
      node("web", 20, 420, 150, 90, "ext", "Website", "Docs · pricing\nCheckout pages"),
      node("app", 355, 70, 310, 120, "app", "Growth Factory app", "Window, engine and your library.\nEpisodes, clips and results\nstay on this computer."),
      node("local", 355, 400, 310, 110, "local", "Local AI and media", "Ollama · Whisper · FFmpeg"),
      node("ai", 880, 30, 320, 90, "ext", "Cloud models (optional)", "OpenRouter for agents · Groq for speech\nyour own key, billed by the provider"),
      node("cloud", 880, 200, 320, 100, "cloud", "Growth Factory cloud", "Sign-in · posting · billing\non Supabase"),
      node("stripe", 880, 380, 150, 80, "ext", "Stripe", "Checkout · billing portal"),
      node("zernio", 1050, 380, 150, 80, "ext", "Zernio", "Posting partner"),
      node("platforms", 1020, 500, 180, 80, "ext", "7 social platforms", "TikTok · Instagram · more"),
    ],
    edges: [
      { from: "you", to: "app", label: "Approve and post" },
      { from: "you", to: "web", label: "Read, choose a plan" },
      { from: "app", to: "local", label: "Transcribe, see, render" },
      { from: "app", to: "ai", label: "Text; frames if allowed", dashed: true },
      { from: "app", to: "cloud", label: "Session, plan, posts", both: true },
      { from: "cloud", to: "stripe", label: "Subscriptions", both: true },
      { from: "cloud", to: "zernio", label: "Publish" },
      { from: "zernio", to: "platforms" },
    ],
  },
  containers: {
    title: "Containers",
    desc: "Inside the app, a native window shows the React interface, which calls the engine on 127.0.0.1. The engine runs a job queue, the agents and local tools, keeps the library in SQLite and media files, and keeps keys in the system key store. In the cloud, Supabase Auth signs you in, and two functions handle posting and billing over Postgres tables protected by row-level security. The posting function talks to Zernio; the billing function talks to Stripe.",
    size: [1000, 600],
    groups: [
      { x: 20, y: 20, w: 560, h: 560, label: "Growth Factory app, on your computer" },
      { x: 620, y: 20, w: 360, h: 420, label: "Growth Factory cloud (Supabase)" },
    ],
    nodes: [
      node("window", 50, 60, 500, 70, "app", "App window", "pywebview: Cocoa on Mac · WebView2 on Windows · Qt on Linux"),
      node("ui", 50, 160, 500, 70, "app", "Interface", "React, one bundled page · Factory, Library, Studio, Results"),
      node("engine", 50, 260, 500, 80, "app", "Engine", "FastAPI on 127.0.0.1, session-gated\nJob queue: one heavy task at a time"),
      node("agents", 50, 380, 240, 80, "local", "Agents", "Listen · Watch · Scout · Editor\nCritic · Strategist · Builder"),
      node("tools", 310, 380, 240, 80, "local", "Local tools", "Ollama · Whisper · FFmpeg"),
      node("store", 50, 490, 240, 70, "local", "Library", "SQLite and media files"),
      node("keys", 310, 490, 240, 70, "local", "Key store", "System keychain"),
      node("auth", 650, 60, 300, 70, "cloud", "Auth", "Email and password sign-in"),
      node("posting", 650, 160, 300, 70, "cloud", "posting function", "Plan check · ownership · Zernio key"),
      node("billing", 650, 260, 300, 70, "cloud", "billing function", "Checkout · portal · webhooks · plan"),
      node("db", 650, 360, 300, 60, "cloud", "Postgres, row-level security", "Workspaces · posts · subscriptions"),
      node("zernio", 620, 490, 170, 80, "ext", "Zernio", "7 platforms"),
      node("stripe", 810, 490, 170, 80, "ext", "Stripe", "Payments"),
    ],
    edges: [
      { from: "window", to: "ui", label: "Shows" },
      { from: "ui", to: "engine", label: "Same-origin API" },
      { from: "engine", to: "agents" },
      { from: "agents", to: "tools" },
      { from: "agents", to: "store", label: "Save" },
      { from: "engine", to: "keys", via: [[565, 300], [565, 525]] },
      { from: "engine", to: "auth" },
      { from: "engine", to: "posting", label: "HTTPS + session", labelAt: [585, 245] },
      { from: "engine", to: "billing" },
      { from: "billing", to: "db" },
      { from: "posting", to: "db", via: [[965, 195], [965, 390]] },
      { from: "posting", to: "zernio", via: [[605, 195], [605, 530]] },
      { from: "billing", to: "stripe", via: [[990, 295], [990, 530]], both: true },
    ],
  },
  posting: {
    title: "Posting flow",
    desc: "You approve an exact clip revision and post it now or schedule it. The publisher in the engine uploads the file and creates the post through the posting function, which checks your plan and ownership and passes it to Zernio, which publishes to the platforms. Zernio reports status back by webhook; the engine reads it back and Results compares the metrics with your usual numbers.",
    size: [980, 340],
    nodes: [
      node("approve", 20, 50, 135, 96, "you", "You approve", "That exact\nrevision"),
      node("post", 181, 50, 135, 96, "app", "Post or\nschedule", "Caption per\nplatform"),
      node("publisher", 342, 50, 135, 96, "app", "Publisher", "In the engine,\nwhile app is open"),
      node("fn", 503, 50, 135, 96, "cloud", "posting\nfunction", "Checks plan\nand owner"),
      node("zernio", 664, 50, 135, 96, "ext", "Zernio", "Publishes"),
      node("platforms", 825, 50, 135, 96, "ext", "Platforms", "TikTok, Instagram\nand 5 more"),
      node("status", 664, 225, 135, 90, "ext", "Status", "Webhook,\nstored by owner"),
      node("results", 342, 225, 135, 90, "app", "Results", "Metrics vs your\nusual numbers"),
    ],
    edges: [
      { from: "approve", to: "post" },
      { from: "post", to: "publisher" },
      { from: "publisher", to: "fn" },
      { from: "fn", to: "zernio" },
      { from: "zernio", to: "platforms" },
      { from: "zernio", to: "status" },
      { from: "status", to: "results", label: "Engine reads it back" },
    ],
  },
  "learning-loop": {
    title: "Learning loop",
    desc: "Footage goes through Listen and Watch, then the scout swarm finds moments and the Editor cuts them. The Critic and quality gate check each clip before you approve it. Approved clips are posted and measured, the Strategist reads the results and proposes a Style rules update, which you approve before it applies to the next clips. When the factory lacks an editing skill, the Factory builder writes a work order and builds it for your review.",
    size: [1000, 480],
    nodes: [
      node("footage", 20, 40, 150, 80, "local", "Footage in", "Your episode"),
      node("listen", 210, 40, 150, 80, "local", "Listen", "Transcript"),
      node("watch", 400, 40, 150, 80, "local", "Watch", "What is on screen"),
      node("scout", 590, 40, 150, 80, "app", "Scout swarm", "Candidate moments"),
      node("editor", 780, 40, 180, 80, "app", "Editor", "Hook, cut, captions"),
      node("critic", 780, 200, 180, 80, "cloud", "Critic + gate", "Checks every clip"),
      node("approve", 780, 360, 180, 80, "you", "You approve", "Nothing posts without it"),
      node("post", 590, 360, 150, 80, "app", "Post", "7 platforms"),
      node("measure", 400, 360, 150, 80, "ext", "Measure", "Views, engagement"),
      node("strategist", 210, 360, 150, 80, "cloud", "Strategist", "Patterns, not proof"),
      node("rules", 20, 200, 150, 80, "you", "Style rules", "You approve updates"),
      node("builder", 290, 200, 350, 80, "app", "Factory builder", "Gap → work order → build → your review"),
    ],
    edges: [
      { from: "footage", to: "listen" },
      { from: "listen", to: "watch" },
      { from: "watch", to: "scout" },
      { from: "scout", to: "editor" },
      { from: "editor", to: "critic" },
      { from: "critic", to: "approve" },
      { from: "approve", to: "post" },
      { from: "post", to: "measure" },
      { from: "measure", to: "strategist" },
      { from: "strategist", to: "rules", via: [[95, 400]] },
      { from: "rules", to: "scout", via: [[95, 160], [665, 160]], label: "Next clips" },
      { from: "critic", to: "builder", label: "Missing skill", dashed: true },
    ],
  },
  billing: {
    title: "Billing flow",
    desc: "From Settings, the app asks the billing function for a Stripe Checkout page and opens it in your browser. After paying, Stripe returns you to the website's success page and sends a signed webhook, which records the subscription. The app reads your plan and limits from the billing function, on return and every 15 seconds for ten minutes, and keeps the last plan for up to 7 days offline.",
    size: [1000, 380],
    nodes: [
      node("app", 20, 50, 180, 96, "app", "App", "Settings → Plan\nand billing"),
      node("fn", 290, 50, 190, 96, "cloud", "billing function", "Creates Checkout\nor portal session"),
      node("checkout", 570, 50, 190, 96, "ext", "Stripe Checkout", "In your browser"),
      node("web", 840, 50, 140, 96, "ext", "Website", "Success, cancel\nand return pages"),
      node("db", 290, 250, 190, 96, "cloud", "Subscriptions", "One row per\nworkspace"),
    ],
    edges: [
      { from: "app", to: "fn", label: "Upgrade" },
      { from: "fn", to: "checkout", label: "Session URL" },
      { from: "checkout", to: "web", label: "Paid" },
      { from: "checkout", to: "db", via: [[665, 298]], label: "Signed webhook" },
      { from: "db", to: "app", via: [[110, 298]], label: "Plan and limits" },
    ],
  },
};

const center = (n) => [n.x + n.w / 2, n.y + n.h / 2];

/** Point where the segment from the box centre towards (tx, ty) leaves the box, with a small gap. */
function exit(n, [tx, ty], gap = 6) {
  const [cx, cy] = center(n);
  const dx = tx - cx;
  const dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const sx = dx ? (n.w / 2 + gap) / Math.abs(dx) : Infinity;
  const sy = dy ? (n.h / 2 + gap) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return [cx + dx * s, cy + dy * s];
}

const round = (v) => Math.round(v * 10) / 10;

function textLines(lines, x, y, cls, lineHeight) {
  const start = y - ((lines.length - 1) * lineHeight) / 2;
  return lines.map((line, i) => `<text class="${cls}" x="${round(x)}" y="${round(start + i * lineHeight)}">${escapeHtml(line)}</text>`).join("");
}

export function renderDiagram(id) {
  const spec = DIAGRAMS[id];
  if (!spec) throw new Error(`Unknown diagram: ${id}`);
  const nodes = new Map(spec.nodes.map((n) => [n.id, n]));
  const [width, height] = spec.size;
  const parts = [];
  for (const g of spec.groups || []) {
    parts.push(`<rect class="d-group" x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="20" /><text class="d-group-label" x="${g.x + 18}" y="${g.y - 6 + 2}" dy="-0.2em">${escapeHtml(g.label)}</text>`);
  }
  const labels = [];
  for (const e of spec.edges) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (!a || !b) throw new Error(`${id}: edge ${e.from} -> ${e.to} names a missing node`);
    const via = e.via || [];
    const first = exit(a, via[0] || center(b));
    const last = exit(b, via.at(-1) || center(a));
    const points = [first, ...via, last];
    const cls = `d-edge${e.dashed ? " d-dashed" : ""}`;
    const start = e.both ? ` marker-start="url(#${id}-start)"` : "";
    parts.push(`<polyline class="${cls}" points="${points.map((p) => p.map(round).join(",")).join(" ")}"${start} marker-end="url(#${id}-end)" />`);
    if (e.label) {
      // Label the longest segment, at its middle, unless the edge places its label itself.
      let best = e.labelAt ? Infinity : 0;
      let at = e.labelAt || [0, 0];
      for (let i = 1; i < points.length; i++) {
        const [x1, y1] = points[i - 1];
        const [x2, y2] = points[i];
        const length = Math.hypot(x2 - x1, y2 - y1);
        if (length > best) { best = length; at = [(x1 + x2) / 2, (y1 + y2) / 2]; }
      }
      const w = e.label.length * 6.6 + 16;
      labels.push(`<rect class="d-label-bg" x="${round(at[0] - w / 2)}" y="${round(at[1] - 11)}" width="${round(w)}" height="22" rx="11" /><text class="d-label" x="${round(at[0])}" y="${round(at[1])}">${escapeHtml(e.label)}</text>`);
    }
  }
  for (const n of spec.nodes) {
    const [cx, cy] = center(n);
    const title = n.label.split("\n");
    const sub = n.sub ? n.sub.split("\n") : [];
    const titleHeight = title.length * 19;
    const subHeight = sub.length * 16;
    const top = cy - (titleHeight + (sub.length ? 6 + subHeight : 0)) / 2;
    parts.push(`<g class="d-node d-${n.kind}"><rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="14" />` +
      textLines(title, cx, top + titleHeight / 2 + 2, "d-title", 19) +
      (sub.length ? textLines(sub, cx, top + titleHeight + 6 + subHeight / 2 + 2, "d-sub", 16) : "") + "</g>");
  }
  return `<svg class="diagram" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${id}-title ${id}-desc" xmlns="http://www.w3.org/2000/svg">
<title id="${id}-title">${escapeHtml(spec.title)}</title><desc id="${id}-desc">${escapeHtml(spec.desc)}</desc>
<defs><marker id="${id}-end" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" /></marker><marker id="${id}-start" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M10 0L0 5L10 10z" /></marker></defs>
${parts.join("\n")}
${labels.join("\n")}
</svg>`;
}
