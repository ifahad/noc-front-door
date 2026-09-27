export const DEMO_AGENT_ID = "assistant-a2d301b3-f112-48f6-84c8-9e4d052cf3b7";

const WIDGET_SCRIPT_URL = "https://unpkg.com/@telnyx/ai-agent-widget@0.36.0";

const CSS = [
  ":root{color-scheme:light}",
  "body{margin:0;background:#f6f8fb;color:#1c2b3a;",
  'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.55}',
  "main{max-width:40rem;margin:0 auto;padding:1.5rem 1.25rem 3rem}",
  "h1{font-size:1.35rem;margin:.25rem 0 .5rem}",
  "h2{font-size:1.05rem;margin:1.5rem 0 .5rem}",
  "p{margin:.75rem 0}",
  ".card{background:#ffffff;border:1px solid #d7e0ec;border-radius:12px;",
  "padding:1rem 1.1rem;margin:1rem 0}",
  "ol{margin:.5rem 0 0;padding-left:1.25rem}",
  "li{margin:.4rem 0}",
  ".muted{color:#5b6b7f;font-size:.92rem}",
  ".badge{display:inline-block;background:#0ea5e9;color:#ffffff;",
  "border-radius:999px;padding:.15rem .6rem;font-size:.78rem;font-weight:600}",
  "a{color:#0b6ea8}",
  "footer{margin-top:2rem;border-top:1px solid #d7e0ec;padding-top:1rem}",
].join("");

export function renderDemoPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NOC Front Door — talk to Sanad</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>NOC Front Door — talk to Sanad</h1>
<p><span class="badge">live demo</span> Sanad is the 24/7 AI fault line of the
fictional KSA managed-services provider Najd Networks, built on Telnyx Voice AI
+ Edge Compute (Functions, KV, Stateful Actors) + a custom MCP server.</p>
<div class="card">
<telnyx-ai-agent agent-id="${DEMO_AGENT_ID}"></telnyx-ai-agent>
</div>
<h2>Try this</h2>
<ol>
<li>Report an outage at the Al Yasmin branch, site R U H one one four, and join
the ongoing Riyadh North incident.</li>
<li>Enter a wrong PIN three times and hear the lock.</li>
<li>Ask for a human engineer.</li>
</ol>
<p class="muted">Demo PINs for the fictional sites are in the reviewer guide of the README.</p>
<h2>Status</h2>
<p>Live status board: <a href="/ops/status">/ops/status</a>.</p>
<footer>
<p class="muted">Privacy: calls are recorded and handled by an AI assistant.</p>
</footer>
</main>
<script async src="${WIDGET_SCRIPT_URL}"></script>
</body>
</html>
`;
}
