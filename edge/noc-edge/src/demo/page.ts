import type { DemoGuide, GuideScenario } from "./guide";

// Public front page of the Najd Networks NOC line. Visual design and markup
// authored by Claude (architect) at the product owner's request; the data it
// renders comes from the OpenCode-authored /ops/board endpoint.
//
// Two layers:
// - the production page: call Sanad (browser in English or Arabic, or phone),
//   live region status on a network map, how a call goes;
// - a hidden operator console (open with #console or the ` key): detailed
//   board, event feed, walkthrough scenarios with demo PINs, architecture and
//   presenter controls.
//
// Security contract (enforced by tests):
// - the only external origins are the pinned Telnyx widget script and Google
//   Fonts; everything else is inline;
// - every dynamic value is written with createElement/textContent — the page
//   never assigns HTML strings, and has no inline event-handler attributes;
// - demo PINs come from the DEMO_GUIDE Edge secret at request time, never from
//   source; without the secret the console points at the README instead.
//
// Load contract: the public map polls /ops/board every 15 s and only while the
// tab is visible; the console polls every 10 s while open; failures back off to
// 60 s; after 10 min without any input the page stops polling until the viewer
// interacts again. Every board build fans out to the Stateful Actors.

export const DEMO_AGENT_ID = "assistant-a2d301b3-f112-48f6-84c8-9e4d052cf3b7";
// The Saudi-Arabic assistant, called directly so an Arabic call never depends
// on the platform's English→Arabic voice hand-off.
export const DEMO_AGENT_AR_ID = "assistant-60f3a28e-5a12-49e3-bce1-1f2136e4aa5a";
// Sanad's public line (a US Telnyx number on the verified account). Written
// with visual separators: it is a published business line, not a personal
// number, and the RFC 3966 separators keep tel: dialable.
export const SANAD_PHONE_DISPLAY = "+1 512 980 6105";
export const SANAD_PHONE_TEL = "tel:+1-512-980-6105";
export const WIDGET_SCRIPT_URL = "https://unpkg.com/@telnyx/ai-agent-widget@0.36.0/dist/bundle.min.js";
// Subresource Integrity for the pinned bundle: the browser refuses to run the
// widget if unpkg ever serves different bytes for this version.
export const WIDGET_SCRIPT_SRI = "sha384-HpQCPH/+U7KWqJp+MLUc/a2uw01ta4Mytbb0NxHShFezMnrsao9SpxjPm7H+7Se6";
export const PUBLIC_POLL_MS = 15000;
export const CONSOLE_POLL_MS = 10000;
export const IDLE_PAUSE_MS = 600000;
const FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Inter:wght@400;500;600&family=IBM+Plex+Sans+Arabic:wght@400;500&display=swap";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pinChip(scenario: GuideScenario | undefined): string {
  if (scenario === undefined) {
    return `<p class="pin-fallback">PIN: see the README reviewer guide</p>`;
  }
  const pin = esc(scenario.pin);
  return (
    `<button type="button" class="pin" data-pin="${pin}" aria-label="Copy the demo PIN for ${esc(scenario.site)}">` +
    `<span class="pin-label">PIN ${pin}</span><span class="pin-copy">copy</span></button>`
  );
}

interface ScenarioCopy {
  n: number;
  title: string;
  steps: string[];
  watch: string;
  chip: string;
}

function scenarioCard(s: ScenarioCopy): string {
  const steps = s.steps.map((step) => `<li>${step}</li>`).join("");
  return (
    `<article class="scenario" id="scenario-${s.n}">` +
    `<header><span class="num">${s.n}</span><h4>${s.title}</h4></header>` +
    `<ol class="steps">${steps}</ol>` +
    `<p class="watch"><span class="tag">watch</span>${s.watch}</p>` +
    s.chip +
    `</article>`
  );
}

const CSS = `
:root{
  --bg:#0f0f0e;--bg-2:#141413;--panel:#171716;--panel-2:#1d1d1b;
  --line:#262624;--line-2:#34342f;
  --text:#ecece8;--text-2:#b4b4ac;--muted:#85857d;--faint:#56564f;
  --hl:#f2f28a;
  --p1:#e5484d;--p2:#f5a524;--ok:#46a758;--info:#8d95f7;
  --display:'Geist','Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
  --sans:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
  --mono:'Geist Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  --arabic:'IBM Plex Sans Arabic','Geeza Pro','Segoe UI',sans-serif;
  color-scheme:dark;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:400 15px/1.55 var(--sans);letter-spacing:-0.006em;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:inherit}
:focus-visible{outline:2px solid var(--text);outline-offset:2px;border-radius:3px}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.ar{font-family:var(--arabic)}
telnyx-ai-agent[hidden]{display:none!important}
.wrap{max-width:1120px;margin:0 auto;padding:0 28px}

/* top bar */
.top{position:sticky;top:0;z-index:20;background:rgba(15,15,14,.92);border-bottom:1px solid var(--line)}
.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;height:60px}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none}
.wordmark{font:600 16px/1 var(--display);letter-spacing:-0.02em}
.wordmark span{color:var(--muted);font-weight:500}
.top-right{display:flex;align-items:center;gap:12px}
.status{display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 12px;border:1px solid var(--line-2);border-radius:999px;font-size:13px;color:var(--text-2);white-space:nowrap}
.status .dot{width:7px;height:7px;border-radius:50%;background:var(--faint)}
.status.s-ok .dot{background:var(--ok)}
.status.s-p2 .dot{background:var(--p2)}
.status.s-p1 .dot{background:var(--p1)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:9px;height:34px;padding:0 14px;border-radius:6px;border:1px solid var(--line-2);background:transparent;color:var(--text);font:500 14px/1 var(--sans);letter-spacing:-0.01em;cursor:pointer;text-decoration:none;white-space:nowrap}
.btn:hover{border-color:var(--muted)}
.btn-primary{background:var(--text);color:var(--bg);border-color:var(--text)}
.btn-primary:hover{background:#fff;border-color:#fff}
.btn-lg{height:46px;padding:0 20px;font-size:15px;border-radius:8px}
.btn svg{flex:none}

/* hero */
.hero{padding:76px 0 40px}
.hero .wrap{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.05fr);gap:56px;align-items:center}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font:500 12.5px/1 var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.eyebrow .live{width:6px;height:6px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px rgba(70,167,88,.18)}
h1{margin:18px 0 18px;font:600 clamp(36px,5vw,56px)/1.04 var(--display);letter-spacing:-0.035em}
h1 em{font-style:normal;color:var(--hl)}
.lede{max-width:500px;margin:0;color:var(--text-2);font-size:17px;line-height:1.6}
.cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:32px}
.callstate{display:flex;align-items:center;gap:8px;min-height:20px;margin:16px 0 0;font:400 12.5px/1.4 var(--mono);color:var(--muted)}
.callstate .dot{width:6px;height:6px;border-radius:50%;background:var(--ok)}
.callstate .dot.wait{background:var(--p2);animation:blink 1.2s ease-in-out infinite}
.langs{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:28px;padding-top:22px;border-top:1px solid var(--line);font-size:14px;color:var(--text-2)}
.lang{display:inline-flex;align-items:center;height:28px;padding:0 10px;border:1px solid var(--line-2);border-radius:999px;color:var(--text);font-size:13.5px}
.lang.ar{font-size:14.5px}

/* network map */
.map{position:relative;border:1px solid var(--line);border-radius:14px;background:var(--bg-2);overflow:hidden}
.map-head{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--line);font-size:13px;color:var(--text-2)}
.map-head b{font:500 13px/1 var(--sans);color:var(--text)}
.map-head .upd{font:400 12px/1 var(--mono);color:var(--muted)}
.map svg{display:block;width:100%;height:auto}
.grid-dot{fill:#2a2a27}
.link{stroke:var(--line-2);stroke-width:1.5;fill:none}
.link.flow{stroke:#4a4a44;stroke-dasharray:3 7;animation:flow 2.4s linear infinite}
.node .core{fill:var(--bg-2);stroke:var(--ok);stroke-width:2}
.node .fill{fill:var(--ok)}
.node .ring{fill:none;stroke:var(--ok);stroke-width:1.5;opacity:0;transform-box:fill-box;transform-origin:center}
.node text{fill:var(--text-2);font:500 13px var(--sans);paint-order:stroke;stroke:var(--bg-2);stroke-width:5px;stroke-linejoin:round}
.node text.sub{fill:var(--muted);font:400 11px var(--mono)}
.node.st-unknown .core{stroke:var(--faint)} .node.st-unknown .fill{fill:var(--faint)}
.node.st-p2 .core{stroke:var(--p2)} .node.st-p2 .fill{fill:var(--p2)} .node.st-p2 .ring{stroke:var(--p2);animation:pulse 2s ease-out infinite}
.node.st-p1 .core{stroke:var(--p1)} .node.st-p1 .fill{fill:var(--p1)} .node.st-p1 .ring{stroke:var(--p1);animation:pulse 1.3s ease-out infinite}
.node.st-p1 text,.node.st-p2 text{fill:var(--text)}
.regions{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.regions li{display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:10px;align-items:center;padding:11px 18px;border-top:1px solid var(--line);font-size:14px}
.regions li:first-child{border-top:0}
.regions .dot{width:8px;height:8px;border-radius:50%;background:var(--faint)}
.regions .st-ok .dot{background:var(--ok)} .regions .st-p2 .dot{background:var(--p2)} .regions .st-p1 .dot{background:var(--p1)}
.regions .what{color:var(--text-2);font-size:13px;text-align:right}
.regions .st-p1 .what,.regions .st-p2 .what{color:var(--text)}

/* steps */
.band{padding:56px 0 64px;border-top:1px solid var(--line)}
.band h2{margin:0 0 28px;font:600 22px/1.2 var(--display);letter-spacing:-0.02em}
.steps3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;list-style:none;margin:0;padding:0}
.steps3 li{padding:22px;border:1px solid var(--line);border-radius:12px;background:var(--bg-2)}
.steps3 .n{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;border:1px solid var(--line-2);font:500 13px/1 var(--mono);color:var(--text-2)}
.steps3 h3{margin:16px 0 6px;font:600 16px/1.3 var(--display);letter-spacing:-0.01em}
.steps3 p{margin:0;color:var(--text-2);font-size:14.5px}

footer{border-top:1px solid var(--line);padding:26px 0 40px;font-size:13px;color:var(--muted)}
footer .wrap{display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px 24px}

/* console (hidden until #console or the \` key) */
.console{border-top:1px solid var(--line);background:var(--bg-2);padding:40px 0 64px;scroll-margin-top:60px}
.console-head{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:26px}
.console-head h2{margin:0;font:600 20px/1.2 var(--display);letter-spacing:-0.02em}
.console-head p{margin:4px 0 0;color:var(--muted);font-size:13.5px}
.console h3{margin:34px 0 12px;font:500 14px/1.2 var(--sans);color:var(--text)}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--line);border-radius:10px;overflow:hidden}
.stat{padding:14px 16px;border-right:1px solid var(--line)}
.stat:last-child{border-right:0}
.stat span{display:block;font-size:12.5px;color:var(--muted)}
.stat b{display:block;margin-top:6px;font:500 22px/1 var(--mono);font-variant-numeric:tabular-nums}
.stat b.hot{color:var(--p1)}
.cgrid{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:24px}
.tbl-wrap{border:1px solid var(--line);border-radius:10px;overflow:auto;background:var(--panel)}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font:500 12px/1 var(--sans);color:var(--muted);padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap;color:var(--text-2)}
tr:last-child td{border-bottom:0}
td.strong{color:var(--text)}
tr.flash td{animation:flash 1.6s ease-out}
.chip{display:inline-block;padding:3px 7px;border-radius:4px;font:500 11px/1 var(--mono);letter-spacing:.03em;border:1px solid var(--line-2);color:var(--text-2)}
.chip.p1{color:var(--p1);border-color:rgba(229,72,77,.45)}
.chip.p2{color:var(--p2);border-color:rgba(245,165,36,.45)}
.chip.ok{color:var(--ok);border-color:rgba(70,167,88,.45)}
.chip.stale{color:var(--p2);border-color:rgba(245,165,36,.45)}
.empty{padding:18px 14px;color:var(--muted);font-size:13.5px;border:1px dashed var(--line-2);border-radius:10px}
.events{list-style:none;margin:0;padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:var(--panel);min-height:120px}
.events li{padding:0 0 12px 14px;position:relative;font-size:13px;line-height:1.35;color:var(--text-2)}
.events li::before{content:"";position:absolute;left:0;top:6px;width:6px;height:6px;border-radius:50%;background:var(--faint)}
.events li.k-p1::before{background:var(--p1)} .events li.k-p2::before{background:var(--p2)} .events li.k-ok::before{background:var(--ok)} .events li.k-info::before{background:var(--info)}
.events time{display:block;margin-top:3px;font:400 11.5px/1 var(--mono);color:var(--muted)}
.scenarios{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.scenario{display:flex;flex-direction:column;padding:18px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
.scenario header{display:flex;align-items:center;gap:10px}
.scenario h4{margin:0;font:600 15px/1.2 var(--display)}
.num{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:4px;border:1px solid var(--line-2);font:500 12px/1 var(--mono);color:var(--text-2)}
.steps{margin:14px 0 0;padding-left:18px;font-size:13.5px;color:var(--text-2)}
.steps li{margin-bottom:8px}
.steps q{color:var(--text)}
.watch{margin:auto 0 0;padding-top:12px;font-size:13px;color:var(--text-2)}
.tag{display:inline-block;margin-right:6px;padding:2px 6px;border-radius:3px;background:var(--panel-2);font:500 11px/1.3 var(--mono);color:var(--muted)}
.pin{display:inline-flex;align-self:flex-start;gap:10px;margin-top:12px;padding:6px 10px;border-radius:5px;border:1px solid var(--line-2);background:transparent;color:var(--text);font:500 12.5px/1 var(--mono);cursor:pointer}
.pin-copy{color:var(--muted)}
.pin-fallback{margin:12px 0 0;font:400 12.5px/1.3 var(--mono);color:var(--muted)}
.flow{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}
.flow .node2{padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
.flow .node2 b{display:block;font:500 13px/1.3 var(--sans)}
.flow .node2 span{display:block;margin-top:4px;font:400 12px/1.35 var(--mono);color:var(--muted)}
.facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:8px}
.fact{padding:12px;border:1px solid var(--line);border-radius:8px;font-size:13px;color:var(--text-2)}
.fact b{display:block;margin-bottom:4px;color:var(--text);font-weight:500}
.op{padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
.op .hint{margin:0 0 12px;font-size:13px;color:var(--muted)}
.op-row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
.op input{flex:1;min-width:220px;height:34px;padding:0 10px;border-radius:6px;border:1px solid var(--line-2);background:var(--bg);color:var(--text);font:400 13px/1 var(--mono)}
.op-out{margin:6px 0 0;white-space:pre-wrap;font:400 12px/1.45 var(--mono);color:var(--text-2)}

@keyframes pulse{0%{opacity:.8;transform:scale(1)}100%{opacity:0;transform:scale(2.8)}}
@keyframes flow{to{stroke-dashoffset:-20}}
@keyframes blink{50%{opacity:.35}}
@keyframes flash{0%{background:rgba(242,242,138,.10)}100%{background:transparent}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;scroll-behavior:auto!important}}
@media (max-width:900px){
  .hero{padding:44px 0 28px}
  .hero .wrap{grid-template-columns:minmax(0,1fr);gap:36px}
  .steps3,.scenarios,.facts{grid-template-columns:minmax(0,1fr)}
  .cgrid{grid-template-columns:minmax(0,1fr)}
  .flow{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .top .btn{display:none}
}
@media (max-width:520px){.wrap{padding:0 18px}.status{display:none}}
`;

const JS = `
(function () {
  'use strict';
  var PUBLIC_POLL = ${PUBLIC_POLL_MS}, CONSOLE_POLL = ${CONSOLE_POLL_MS}, MAX_BACKOFF = 60000, IDLE_PAUSE = ${IDLE_PAUSE_MS};
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  /* ---- call ---- */
  var callDot = $('callDot'), callText = $('callText');
  function setCall(wait, text) { callDot.className = wait ? 'dot wait' : 'dot'; callText.textContent = text; }
  // One widget per assistant; only the one in use is shown, so the two
  // floating launchers never stack.
  var AGENTS = { en: '${DEMO_AGENT_ID}', ar: '${DEMO_AGENT_AR_ID}' };
  function startCall(lang) {
    var hosts = document.querySelectorAll('telnyx-ai-agent'), host = null;
    for (var i = 0; i < hosts.length; i++) if (hosts[i].getAttribute('agent-id') === AGENTS[lang]) host = hosts[i];
    var launcher = host && host.shadowRoot ? host.shadowRoot.querySelector('button') : null;
    if (!launcher) { setCall(true, 'Connecting… try again in a moment.'); return; }
    for (var j = 0; j < hosts.length; j++) hosts[j].hidden = hosts[j] !== host;
    setCall(true, (lang === 'ar' ? 'Starting the Arabic call' : 'Starting the call') +
      ' — allow your microphone. The call panel opens bottom-right.');
    launcher.click();
  }
  var callButtons = document.querySelectorAll('[data-action="call"]');
  for (var i = 0; i < callButtons.length; i++) callButtons[i].addEventListener('click', function () {
    startCall(this.getAttribute('data-lang') === 'ar' ? 'ar' : 'en');
  });

  /* ---- hidden console ---- */
  var consoleEl = $('console');
  function consoleOpen() { return !consoleEl.hidden; }
  function showConsole(on) {
    consoleEl.hidden = !on;
    if (on) { consoleEl.scrollIntoView({ block: 'start' }); schedule(0); }
  }
  if (location.hash === '#console') showConsole(true);
  window.addEventListener('hashchange', function () { if (location.hash === '#console') showConsole(true); });
  $('closeConsole').addEventListener('click', function () {
    showConsole(false);
    if (location.hash === '#console') history.replaceState(null, '', location.pathname);
    window.scrollTo(0, 0);
  });
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === '\`') { e.preventDefault(); showConsole(!consoleOpen()); }
    else if (!consoleOpen()) return;
    else if (e.key === '1' || e.key === '2' || e.key === '3') {
      var s = $('scenario-' + e.key);
      if (s) { e.preventDefault(); s.scrollIntoView({ block: 'center' }); }
    }
  });

  /* ---- PIN chips (console) ---- */
  var pins = document.querySelectorAll('button.pin');
  for (var p = 0; p < pins.length; p++) (function (b) {
    b.addEventListener('click', function () {
      var lab = b.querySelector('.pin-copy');
      var pin = b.getAttribute('data-pin') || '';
      function done(t) { lab.textContent = t; setTimeout(function () { lab.textContent = 'copy'; }, 1600); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(pin).then(function () { done('copied'); }, function () { done('copy failed'); });
      } else { done('copy failed'); }
    });
  })(pins[p]);

  /* ---- live status ---- */
  var ORDER = ['riyadh-north', 'riyadh-south', 'jeddah', 'dammam'];
  var last = null, lastOk = 0, polling = false, timer = null, failures = 0;
  var lastInput = Date.now(), paused = false;
  var events = [];
  function rtime(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + ' s ago';
    var m = Math.round(s / 60);
    return m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago';
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function regionState(r) {
    if (r.incident) return r.incident.priority === 'P1' ? 'p1' : 'p2';
    return 'ok';
  }
  function regionText(r) {
    if (!r.incident) return 'Normal';
    return r.incident.priority + ' incident · ' + plural(r.incident.site_count, 'branch', 'branches');
  }
  function renderPublic(board) {
    var incidents = 0, worst = 'ok';
    var list = $('regionList');
    clear(list);
    ORDER.forEach(function (id) {
      var r = null;
      for (var i = 0; i < board.regions.length; i++) if (board.regions[i].region === id) r = board.regions[i];
      var node = $('node-' + id);
      if (!r) { if (node) node.setAttribute('class', 'node st-unknown'); return; }
      var st = regionState(r);
      if (st !== 'ok') incidents++;
      if (st === 'p1' || (st === 'p2' && worst === 'ok')) worst = st;
      if (node) node.setAttribute('class', 'node st-' + st);
      var sub = $('sub-' + id);
      if (sub) sub.textContent = r.incident ? r.incident.priority + ' · ' + plural(r.incident.site_count, 'branch', 'branches') : 'normal';
      var li = el('li', 'st-' + st);
      li.appendChild(el('span', 'dot'));
      li.appendChild(el('span', '', r.label));
      li.appendChild(el('span', 'what', regionText(r)));
      list.appendChild(li);
    });
    var pill = $('statusPill');
    pill.className = 'status s-' + worst;
    $('statusText').textContent = incidents === 0 ? 'All regions normal' : plural(incidents, 'active incident', 'active incidents');
  }
  function setUnknown() {
    $('statusPill').className = 'status';
    $('statusText').textContent = 'Status updating…';
    ORDER.forEach(function (id) { var n = $('node-' + id); if (n) n.setAttribute('class', 'node st-unknown'); });
  }

  /* ---- console board ---- */
  function pushEvent(kind, text) {
    events.unshift({ kind: kind, text: text, at: Date.now() });
    if (events.length > 10) events.length = 10;
    renderEvents();
  }
  function renderEvents() {
    var list = $('events');
    clear(list);
    if (events.length === 0) { list.appendChild(el('li', '', 'Waiting for the first board…')); return; }
    events.forEach(function (ev) {
      var li = el('li', 'k-' + ev.kind, ev.text);
      var t = el('time', '', rtime(ev.at));
      t.setAttribute('data-at', String(ev.at));
      li.appendChild(t);
      list.appendChild(li);
    });
  }
  function index(arr, key) { var m = {}; arr.forEach(function (x) { m[x[key]] = x; }); return m; }
  var flashKeys = {};
  function diff(prev, next) {
    var pr = index(prev.regions, 'region'), nr = index(next.regions, 'region');
    Object.keys(nr).forEach(function (k) {
      var a = pr[k] && pr[k].incident, b = nr[k].incident, name = nr[k].label;
      if (!a && b) { pushEvent(b.priority === 'P1' ? 'p1' : 'p2', b.id + ' declared · ' + name + ' · ' + b.priority); flashKeys['r:' + k] = 1; }
      else if (a && !b) { pushEvent('ok', a.id + ' resolved · ' + name); flashKeys['r:' + k] = 1; }
      else if (a && b) {
        if (a.priority !== b.priority) { pushEvent(b.priority === 'P1' ? 'p1' : 'p2', b.id + ' raised to ' + b.priority); flashKeys['r:' + k] = 1; }
        else if (a.site_count !== b.site_count) { pushEvent('p2', b.id + ' now affects ' + plural(b.site_count, 'branch', 'branches')); flashKeys['r:' + k] = 1; }
        var ea = pr[k].esc, eb = nr[k].esc;
        if (eb && ea && eb.level > ea.level) pushEvent('p1', b.id + ' escalated · page L' + eb.level);
        if (eb && ea && eb.acked && !ea.acked) pushEvent('ok', b.id + ' acknowledged');
      }
    });
    var ps = index(prev.sites || [], 'site_id'), ns = index(next.sites || [], 'site_id');
    Object.keys(ns).forEach(function (k) {
      var a = ps[k] && ps[k].open_ticket, b = ns[k].open_ticket;
      if (!a && b) { pushEvent('info', b.id + ' opened · ' + k + ' · ' + b.priority); flashKeys['s:' + k] = 1; }
      else if (a && !b) pushEvent('ok', a.id + ' closed · ' + k);
    });
  }
  function cell(tr, text, cls) { tr.appendChild(el('td', cls || '', text)); }
  function monoCell(tr, text) { var td = el('td'); td.appendChild(el('span', 'mono', text)); tr.appendChild(td); }
  function chipCell(tr, text, cls) { var td = el('td'); td.appendChild(el('span', 'chip ' + cls, text)); tr.appendChild(td); }
  function label(s) { return String(s || '').replace(/^the /i, ''); }
  function renderConsole(board) {
    var sites = board.sites || [];
    var regions = board.regions.slice().sort(function (a, b) { return ORDER.indexOf(a.region) - ORDER.indexOf(b.region); });
    var inc = 0, p1 = 0, tickets = 0;
    regions.forEach(function (r) { if (r.incident) { inc++; if (r.incident.priority === 'P1') p1++; } });
    sites.forEach(function (s) { if (s.open_ticket) tickets++; });
    $('stIncidents').textContent = String(inc);
    $('stP1').textContent = String(p1);
    $('stP1').className = p1 > 0 ? 'hot' : '';
    $('stTickets').textContent = String(tickets);
    $('stMode').textContent = board.actor_mode || '—';
    var rb = $('regionRows');
    clear(rb);
    regions.forEach(function (r) {
      var st = regionState(r);
      var tr = el('tr', flashKeys['r:' + r.region] ? 'flash' : '');
      cell(tr, r.label, 'strong');
      chipCell(tr, st === 'ok' ? 'NORMAL' : st.toUpperCase(), st);
      if (r.incident) {
        monoCell(tr, r.incident.id);
        cell(tr, plural(r.incident.site_count, 'branch', 'branches'));
        monoCell(tr, r.incident.declared_local || '—');
      } else { cell(tr, '—'); cell(tr, '—'); cell(tr, '—'); }
      var e = r.esc;
      if (e && r.incident) { if (e.acked) chipCell(tr, 'ACKED', 'ok'); else monoCell(tr, 'L' + e.level + (e.due_local ? ' · due ' + e.due_local : '')); }
      else cell(tr, '—');
      rb.appendChild(tr);
    });
    var tb = $('ticketRows');
    clear(tb);
    var open = sites.filter(function (s) { return s.open_ticket; });
    $('ticketsEmpty').hidden = open.length !== 0;
    $('ticketsTable').hidden = open.length === 0;
    open.forEach(function (s) {
      var tr = el('tr', flashKeys['s:' + s.site_id] ? 'flash' : '');
      monoCell(tr, s.site_id);
      cell(tr, label(s.label), 'strong');
      monoCell(tr, s.open_ticket.id);
      chipCell(tr, s.open_ticket.priority, s.open_ticket.priority === 'P1' ? 'p1' : 'p2');
      monoCell(tr, s.open_ticket.opened_local || '—');
      tb.appendChild(tr);
    });
    flashKeys = {};
  }
  function ageTick() {
    var txt = paused ? 'paused while idle — move the mouse to resume' : lastOk ? 'updated ' + rtime(lastOk) : 'connecting…';
    $('mapUpdated').textContent = txt;
    $('conUpdated').textContent = txt;
    $('staleChip').hidden = !(lastOk && Date.now() - lastOk > 45000);
    var times = document.querySelectorAll('#events time[data-at]');
    for (var i = 0; i < times.length; i++) times[i].textContent = rtime(Number(times[i].getAttribute('data-at')));
  }
  function interval() {
    if (failures > 0) return Math.min(MAX_BACKOFF, PUBLIC_POLL * Math.pow(2, failures - 1));
    return consoleOpen() ? CONSOLE_POLL : PUBLIC_POLL;
  }
  function schedule(ms) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(poll, ms);
  }
  function poll() {
    timer = null;
    if (document.visibilityState === 'hidden') return;
    if (Date.now() - lastInput > IDLE_PAUSE) { paused = true; ageTick(); return; }
    if (polling) return;
    polling = true;
    var ctl = new AbortController();
    var abort = setTimeout(function () { ctl.abort(); }, 8000);
    fetch('/ops/board', { signal: ctl.signal, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (b) {
        if (!b || !Array.isArray(b.regions) || !Array.isArray(b.sites)) throw new Error('bad board');
        var prev = last;
        last = b; lastOk = Date.now(); failures = 0;
        if (prev) diff(prev, b); else pushEvent('info', 'Board synced · ' + b.regions.length + ' regions');
        renderPublic(b); renderConsole(b); ageTick();
      })
      .catch(function () { failures++; if (!last) setUnknown(); })
      .then(function () { clearTimeout(abort); polling = false; schedule(interval()); });
  }
  function onInput() {
    lastInput = Date.now();
    if (paused) { paused = false; ageTick(); schedule(0); }
  }
  ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart'].forEach(function (t) {
    window.addEventListener(t, onInput, { passive: true });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') schedule(0);
    else if (timer) { clearTimeout(timer); timer = null; }
  });
  renderEvents();
  setUnknown();
  poll();
  setInterval(ageTick, 1000);

  /* ---- operator: the token lives in sessionStorage only ---- */
  var TOKEN_KEY = 'noc.opsToken';
  var tokenInput = $('opsToken'), out = $('opOut');
  try { tokenInput.value = sessionStorage.getItem(TOKEN_KEY) || ''; } catch (err) { /* storage disabled */ }
  tokenInput.addEventListener('input', function () {
    try { sessionStorage.setItem(TOKEN_KEY, tokenInput.value); } catch (err) { /* storage disabled */ }
  });
  var OPS = {
    reset: '/ops/reset',
    stage: '/ops/stage-incident?region=riyadh-north',
    ack: '/ops/ack?region=riyadh-north',
    resolve: '/ops/resolve?region=riyadh-north',
    unlock: ['/ops/unlock?site=RUH-114', '/ops/unlock?site=JED-007']
  };
  var opButtons = document.querySelectorAll('[data-op]');
  for (var o = 0; o < opButtons.length; o++) (function (b) {
    b.addEventListener('click', function () {
      var path = OPS[b.getAttribute('data-op')];
      var token = tokenInput.value.trim();
      if (!path) return;
      if (!token) { out.textContent = 'Enter the ops token first.'; return; }
      var paths = Array.isArray(path) ? path : [path];
      var lines = [];
      out.textContent = b.textContent + ' …';
      paths.reduce(function (chain, one) {
        return chain.then(function () {
          return fetch(one, { method: 'POST', headers: { Authorization: 'Bearer ' + token } })
            .then(function (r) { return r.text().then(function (t) { lines.push(one + ' → HTTP ' + r.status + (t ? ' ' + t.slice(0, 300) : '')); }); });
        });
      }, Promise.resolve())
        .then(function () { out.textContent = b.textContent + '\\n' + lines.join('\\n'); schedule(0); })
        .catch(function (err) { out.textContent = b.textContent + ' failed: ' + String(err && err.message || err); });
    });
  })(opButtons[o]);
})();
`;

const LOGO = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="1.5" y="1.5" width="21" height="21" rx="6" stroke="currentColor" stroke-width="1.5"/><path d="M7.5 17.5V7l9 10.5V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PHONE_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.2 1.8 3.4 2.3a1.5 1.5 0 0 0-1.1 1.6c.5 5 4.8 9.3 9.8 9.8a1.5 1.5 0 0 0 1.6-1.1l.5-1.8-2.9-1.5-1.3 1.3a7 7 0 0 1-3.6-3.6l1.3-1.3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
const MIC_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M3 8a5 5 0 0 0 10 0M8 13v1.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

// Regions placed roughly where they are: Jeddah on the Red Sea coast, the two
// Riyadh regions in the centre, Dammam on the Gulf coast.
const NODES: Array<{ id: string; label: string; x: number; y: number; anchor: "start" | "end" }> = [
  { id: "jeddah", label: "Jeddah", x: 60, y: 170, anchor: "start" },
  { id: "riyadh-north", label: "Riyadh North", x: 235, y: 95, anchor: "end" },
  { id: "riyadh-south", label: "Riyadh South", x: 255, y: 145, anchor: "start" },
  { id: "dammam", label: "Dammam", x: 365, y: 60, anchor: "end" },
];

function mapSvg(): string {
  const nodes = NODES.map((n) => {
    const tx = n.anchor === "start" ? n.x + 16 : n.x - 16;
    return (
      `<g class="node st-unknown" id="node-${n.id}">` +
      `<circle class="ring" cx="${n.x}" cy="${n.y}" r="8"/>` +
      `<circle class="core" cx="${n.x}" cy="${n.y}" r="8"/>` +
      `<circle class="fill" cx="${n.x}" cy="${n.y}" r="3.5"/>` +
      `<text x="${tx}" y="${n.y - 2}" text-anchor="${n.anchor}">${n.label}</text>` +
      `<text class="sub" id="sub-${n.id}" x="${tx}" y="${n.y + 13}" text-anchor="${n.anchor}">—</text>` +
      `</g>`
    );
  }).join("");
  return (
    `<svg viewBox="0 0 420 230" role="img" aria-label="Najd Networks regions and their live status">` +
    `<defs><pattern id="dots" width="14" height="14" patternUnits="userSpaceOnUse"><circle class="grid-dot" cx="1.5" cy="1.5" r="1.1"/></pattern></defs>` +
    `<rect width="420" height="230" fill="url(#dots)"/>` +
    `<path class="link" d="M60 170 C 130 160, 190 152, 255 145"/>` +
    `<path class="link flow" d="M60 170 C 130 160, 190 152, 255 145"/>` +
    `<path class="link" d="M235 95 L 255 145"/>` +
    `<path class="link" d="M235 95 C 280 80, 320 66, 365 60"/>` +
    `<path class="link flow" d="M235 95 C 280 80, 320 66, 365 60"/>` +
    `<path class="link" d="M60 170 C 110 135, 170 105, 235 95"/>` +
    nodes +
    `</svg>`
  );
}

export function renderDemoPage(guide: DemoGuide | null): string {
  const byKey = new Map<string, GuideScenario>();
  for (const scenario of guide?.scenarios ?? []) byKey.set(scenario.key, scenario);

  const scenarios = [
    scenarioCard({
      n: 1,
      title: "Join the incident",
      steps: [
        "Press <b>Call from your browser</b>, then say: <q>Hi, this is Ahmed from Al-Waha Pharmacies. Our Al Yasmin branch is offline — site R U H one one four.</q>",
        "Read the PIN digit by digit when Sanad asks.",
        "When Sanad mentions the Riyadh North incident, say <q>yes, add us.</q>",
      ],
      watch: "Riyadh North turn P1 at 3 branches, and a new ticket row appear.",
      chip: pinChip(byKey.get("join")),
    }),
    scenarioCard({
      n: 2,
      title: "Open a new ticket",
      steps: [
        "Say: <q>Our site is J E D zero zero seven in Jeddah.</q> and give the PIN.",
        "Describe the fault: <q>The internet is down and the card machines don't work — customers are affected.</q>",
        "Any time, say <q>Can we continue in Arabic?</q> — the Saudi-Arabic assistant takes over. Or start in Arabic with <b class=\"ar\" lang=\"ar\">اتصل بالعربي</b>.",
      ],
      watch: "a new Jeddah ticket appear with its priority, read back to you by Sanad.",
      chip: pinChip(byKey.get("new")),
    }),
    scenarioCard({
      n: 3,
      title: "Lockout &amp; human",
      steps: [
        "Say: <q>Our site is D M M zero one one.</q> — a spare site, so the demo sites stay unlocked.",
        "Give a wrong PIN three times, then ask: <q>Can I speak to an engineer?</q>",
      ],
      watch: "verification lock for the call, then the warm transfer to the on-call engineer (or a callback message).",
      chip: "",
    }),
  ].join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Najd Networks NOC — Report an outage, 24/7</title>
<meta name="description" content="Call Sanad, the Najd Networks NOC assistant, to report a network outage at any hour — in English or Saudi Arabic.">
<meta name="theme-color" content="#0f0f0e">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONTS_URL}" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="wrap">
    <a class="brand" href="/" aria-label="Najd Networks NOC — home">${LOGO}<span class="wordmark">Najd Networks <span>NOC</span></span></a>
    <div class="top-right">
      <span class="status" id="statusPill" role="status"><span class="dot"></span><span id="statusText">Status updating…</span></span>
      <button type="button" class="btn btn-primary" data-action="call">Report an outage</button>
    </div>
  </div>
</header>

<main>
  <section class="hero" aria-labelledby="heroTitle">
    <div class="wrap">
      <div>
        <span class="eyebrow"><span class="live"></span>24/7 fault line</span>
        <h1 id="heroTitle">Report a network outage <em>in under a minute.</em></h1>
        <p class="lede">Sanad, our NOC assistant, answers every call. It verifies your branch, recognises an outage already in progress and opens or joins the right ticket. When it's urgent, an on-call engineer is paged.</p>
        <div class="cta">
          <button type="button" class="btn btn-primary btn-lg" data-action="call">${MIC_ICON}Call from your browser</button>
          <a class="btn btn-lg" href="${SANAD_PHONE_TEL}">${PHONE_ICON}Call ${SANAD_PHONE_DISPLAY}</a>
          <button type="button" class="btn btn-lg ar" data-action="call" data-lang="ar" lang="ar" dir="rtl">${MIC_ICON}اتصل بالعربي</button>
        </div>
        <p class="callstate"><span class="dot" id="callDot"></span><span id="callText">Have your site ID and 4-digit site PIN ready.</span></p>
        <div class="langs"><span>Speaks</span><span class="lang">English</span><span class="lang ar" lang="ar">العربية</span><span>— start in Arabic, or ask for it at any time.</span></div>
      </div>
      <figure class="map" aria-labelledby="mapTitle" style="margin:0">
        <div class="map-head"><b id="mapTitle">Network status</b><span class="upd" id="mapUpdated">connecting…</span></div>
        ${mapSvg()}
        <ul class="regions" id="regionList" aria-live="polite"></ul>
      </figure>
    </div>
  </section>

  <section class="band" aria-labelledby="howTitle">
    <div class="wrap">
      <h2 id="howTitle">What happens when you call</h2>
      <ol class="steps3">
        <li><span class="n">1</span><h3>Tell Sanad your site</h3><p>Say your site ID and 4-digit site PIN. Sanad never reads your PIN back.</p></li>
        <li><span class="n">2</span><h3>Sanad checks the network</h3><p>If other branches in your region are already down, your branch joins that incident — no duplicate tickets.</p></li>
        <li><span class="n">3</span><h3>Your ticket, read back</h3><p>You hear your ticket number. Critical outages page the on-call engineer, or ask for a person at any time.</p></li>
      </ol>
    </div>
  </section>
</main>

<section class="console" id="console" aria-labelledby="consoleTitle" hidden>
  <div class="wrap">
    <div class="console-head">
      <div><h2 id="consoleTitle">Operator console</h2><p>Live from Stateful Actors via /ops/board · <span id="conUpdated">connecting…</span> <span class="chip stale" id="staleChip" hidden>stale</span></p></div>
      <button type="button" class="btn" id="closeConsole">Close</button>
    </div>
    <div class="stats">
      <div class="stat"><span>Open incidents</span><b id="stIncidents">–</b></div>
      <div class="stat"><span>P1 incidents</span><b id="stP1">–</b></div>
      <div class="stat"><span>Open tickets</span><b id="stTickets">–</b></div>
      <div class="stat"><span>Actor mode</span><b id="stMode">–</b></div>
    </div>
    <div class="cgrid">
      <div>
        <h3>Regions</h3>
        <div class="tbl-wrap"><table>
          <thead><tr><th>Region</th><th>Status</th><th>Incident</th><th>Branches</th><th>Declared</th><th>Escalation</th></tr></thead>
          <tbody id="regionRows"></tbody>
        </table></div>
        <h3>Open tickets</h3>
        <div class="tbl-wrap" id="ticketsTable" hidden><table>
          <thead><tr><th>Site</th><th>Branch</th><th>Ticket</th><th>Priority</th><th>Opened</th></tr></thead>
          <tbody id="ticketRows"></tbody>
        </table></div>
        <div class="empty" id="ticketsEmpty">No open tickets.</div>
      </div>
      <div>
        <h3>Event feed</h3>
        <ol class="events" id="events" aria-live="polite"></ol>
      </div>
    </div>

    <h3 id="scenarios">Scenarios <span class="tag">1 · 2 · 3</span></h3>
    <div class="scenarios">${scenarios}</div>

    <h3>How it works</h3>
    <div class="flow">
      <div class="node2"><b>Caller</b><span>phone · browser</span></div>
      <div class="node2"><b>Telnyx Voice AI</b><span>Sanad EN → Sanad AR handoff</span></div>
      <div class="node2"><b>Edge Function</b><span>/dv · tools · MCP</span></div>
      <div class="node2"><b>Stateful Actors + KV</b><span>tickets · incidents · flags</span></div>
      <div class="node2"><b>Live board</b><span>/ops/board · masked</span></div>
    </div>
    <div class="facts">
      <div class="fact"><b>Race test</b>10 concurrent opens for one site: actors create exactly 1 ticket; plain KV creates 10.</div>
      <div class="fact"><b>Fails safe</b>If KV or actors fail, Sanad answers with safe defaults and hands over to a human.</div>
      <div class="fact"><b>Observable</b>An external prober checks deep health every 10 s; one trace id per call across every hop.</div>
    </div>

    <h3>Operator</h3>
    <div class="op">
      <p class="hint">Presenter controls. The ops token stays in this browser tab (sessionStorage) and is sent only as a bearer header to this site's /ops routes.</p>
      <div class="op-row"><input id="opsToken" type="password" autocomplete="off" spellcheck="false" placeholder="Ops token" aria-label="Ops token"></div>
      <div class="op-row">
        <button type="button" class="btn" data-op="reset">Reset demo</button>
        <button type="button" class="btn" data-op="stage">Stage Riyadh North incident</button>
        <button type="button" class="btn" data-op="ack">Acknowledge</button>
        <button type="button" class="btn" data-op="resolve">Resolve</button>
        <button type="button" class="btn" data-op="unlock">Unlock demo sites</button>
      </div>
      <p class="op-out" id="opOut" aria-live="polite"></p>
    </div>
  </div>
</section>

<footer>
  <div class="wrap">
    <span>Najd Networks Network Operations Centre · Riyadh</span>
    <span>Calls are recorded and handled by an AI assistant.</span>
    <span>Runs on Telnyx Voice AI and Edge Compute</span>
  </div>
</footer>

<telnyx-ai-agent agent-id="${DEMO_AGENT_ID}"></telnyx-ai-agent>
<telnyx-ai-agent agent-id="${DEMO_AGENT_AR_ID}" hidden></telnyx-ai-agent>
<script async src="${WIDGET_SCRIPT_URL}" integrity="${WIDGET_SCRIPT_SRI}" crossorigin="anonymous"></script>
<script>${JS}</script>
</body>
</html>`;
}
