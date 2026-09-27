import type { DemoGuide, GuideScenario } from "./guide";

// Public demo page — the "NOC wall". Visual design and markup authored by
// Claude (architect) at the product owner's request; the data it renders
// comes from the OpenCode-authored /ops/board endpoint.
//
// Security contract (enforced by tests):
// - the only external origins are the pinned Telnyx widget script and Google
//   Fonts; everything else is inline;
// - every dynamic value is written with createElement/textContent — the page
//   never assigns HTML strings, and has no inline event-handler attributes;
// - demo PINs come from the DEMO_GUIDE Edge secret at request time, never from
//   source; without the secret the page points at the README instead.

export const DEMO_AGENT_ID = "assistant-a2d301b3-f112-48f6-84c8-9e4d052cf3b7";
export const WIDGET_SCRIPT_URL = "https://unpkg.com/@telnyx/ai-agent-widget@0.36.0";
const FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap";

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
    `<header><span class="num">${s.n}</span><h3>${s.title}</h3></header>` +
    `<ol class="steps">${steps}</ol>` +
    `<p class="watch"><span class="tag">watch</span>${s.watch}</p>` +
    s.chip +
    `</article>`
  );
}

const CSS = `
:root{
  --bg:#111110;--bg-2:#151514;--panel:#191918;--panel-2:#20201e;
  --line:#292927;--line-2:#383835;
  --text:#ecece8;--text-2:#b7b7af;--muted:#878780;--faint:#5f5f59;
  --hl:#f2f28a;--hl-ink:#141413;
  --p1:#e5484d;--p2:#f5a524;--ok:#46a758;--info:#8d95f7;
  --display:'Geist','Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
  --sans:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
  --mono:'Geist Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  --radius:6px;
  color-scheme:dark;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:400 15px/1.55 var(--sans);letter-spacing:-0.006em;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:inherit}
:focus-visible{outline:2px solid var(--text);outline-offset:2px;border-radius:3px}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.hatch{background-image:repeating-linear-gradient(135deg,rgba(236,236,232,.035) 0 1px,transparent 1px 7px)}

/* announcement + nav */
.announce{background:#0b0b0a;border-bottom:1px solid var(--line);color:var(--text-2);font-size:13px;text-align:center;padding:8px 16px}
.announce a{color:var(--text);text-underline-offset:3px}
.nav{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:16px;height:56px;padding:0 20px;background:var(--bg);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;min-width:0}
.brand svg{flex:none}
.wordmark{font:500 17px/1 var(--display);letter-spacing:-0.025em}
.by{font-size:12px;color:var(--muted);white-space:nowrap}
.navlinks{display:flex;gap:22px;font-size:14px}
.navlinks a{color:var(--text-2);text-decoration:none}
.navlinks a:hover{color:var(--text)}
.actions{display:flex;gap:8px}
.btn{display:inline-flex;align-items:center;gap:9px;height:32px;padding:0 10px 0 12px;border-radius:4px;border:1px solid var(--line-2);background:transparent;color:var(--text);font:500 13.5px/1 var(--sans);letter-spacing:-0.01em;cursor:pointer;text-decoration:none;white-space:nowrap}
.btn:hover{border-color:var(--muted)}
.btn-primary{background:var(--text);color:var(--bg);border-color:var(--text)}
.btn-primary:hover{background:#ffffff;border-color:#ffffff}
.btn-lg{height:38px;font-size:14.5px;padding:0 12px 0 14px}
.kbd{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 4px;border-radius:3px;border:1px solid var(--line-2);font:500 11px/1 var(--mono);color:var(--muted)}
.btn-primary .kbd{border-color:rgba(17,17,16,.28);color:rgba(17,17,16,.72)}

/* shell */
.shell{display:grid;grid-template-columns:248px minmax(0,1fr) 216px;max-width:90rem;margin:0 auto}
.side{position:sticky;top:56px;height:calc(100vh - 56px);overflow:auto;border-right:1px solid var(--line);background:var(--bg-2)}
.toc{position:sticky;top:56px;height:calc(100vh - 56px);padding:24px 18px;border-left:1px solid var(--line)}
.side-sec{padding:18px 18px 16px;border-bottom:1px solid var(--line)}
.side-sec h3{margin:0 0 12px;font:500 13.5px/1.2 var(--sans);color:var(--text)}
.kv{display:flex;justify-content:space-between;gap:12px;font-size:13px;color:var(--text-2);padding:4px 0}
.kv b{font:500 13px/1.4 var(--mono);color:var(--text);font-variant-numeric:tabular-nums}
.kv b.hot{color:var(--p1)}
.events{list-style:none;margin:0;padding:0}
.events li{padding:0 0 12px 14px;position:relative;font-size:13px;line-height:1.35;color:var(--text-2)}
.events li::before{content:"";position:absolute;left:0;top:6px;width:6px;height:6px;border-radius:50%;background:var(--faint)}
.events li.k-p1::before{background:var(--p1)}
.events li.k-p2::before{background:var(--p2)}
.events li.k-ok::before{background:var(--ok)}
.events li.k-info::before{background:var(--info)}
.events time{display:block;margin-top:3px;font:400 11.5px/1 var(--mono);color:var(--muted)}
.events li.fresh{animation:fadein .5s ease-out}
.stack{list-style:none;margin:0;padding:0;font-size:13px;color:var(--text-2)}
.stack li{display:flex;justify-content:space-between;padding:4px 0}
.stack .mono{font-size:11.5px;color:var(--muted)}

.toc h4{margin:0 0 12px;font:500 13.5px/1.2 var(--sans)}
.toc ol{list-style:none;margin:0;padding:0;border-left:1px solid var(--line)}
.toc a{display:block;padding:5px 0 5px 12px;margin-left:-1px;border-left:1px solid transparent;font-size:13.5px;color:var(--text-2);text-decoration:none}
.toc a:hover{color:var(--text)}
.toc a.active{color:var(--text);border-left:2px solid var(--text);padding-left:11px;font-weight:500}

main{min-width:0;padding:32px 36px 72px}
.wrap{max-width:880px;margin:0 auto}
section{scroll-margin-top:76px}
section+section{margin-top:64px}
.sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:14px}
h2{margin:0;font:500 24px/1.2 var(--display);letter-spacing:-0.025em}
.meta{font:400 12px/1 var(--mono);color:var(--muted);display:flex;align-items:center;gap:8px}
.lede{margin:-4px 0 18px;color:var(--text-2);font-size:14.5px;max-width:64ch}

/* hero */
.frame{position:relative;border:1px solid var(--line);background:var(--bg)}
.crop{position:absolute;width:11px;height:11px;border-color:var(--muted);border-style:solid;border-width:0}
.crop.tl{top:-6px;left:-6px;border-top-width:1px;border-left-width:1px}
.crop.tr{top:-6px;right:-6px;border-top-width:1px;border-right-width:1px}
.crop.bl{bottom:-6px;left:-6px;border-bottom-width:1px;border-left-width:1px}
.crop.br{bottom:-6px;right:-6px;border-bottom-width:1px;border-right-width:1px}
.strip{display:flex;flex-wrap:wrap;justify-content:center;gap:6px 18px;padding:11px 16px;border-bottom:1px solid var(--line);font-size:13.5px;color:var(--text-2)}
.strip b{color:var(--text);font-weight:600}
.strip .sep{color:var(--faint)}
.hero-body{padding:60px 32px 44px;text-align:center}
h1{margin:0 auto 22px;font:500 clamp(38px,5.4vw,62px)/1.04 var(--display);letter-spacing:-0.04em;max-width:14ch}
mark{background:var(--hl);color:var(--hl-ink);padding:0 .1em;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.sub{margin:0 auto;max-width:60ch;font-size:16.5px;line-height:1.55;color:var(--text-2)}
.cta{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-top:30px}
.callstate{display:flex;justify-content:center;align-items:center;gap:8px;margin-top:18px;font:400 12.5px/1.4 var(--mono);color:var(--muted)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ok);flex:none}
.dot.wait{background:var(--p2)}
.hero-foot{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--line)}
.hero-foot div{padding:14px 18px;font-size:13px;color:var(--text-2);border-right:1px solid var(--line)}
.hero-foot div:last-child{border-right:0}
.hero-foot b{display:block;margin-bottom:2px;font:500 13px/1.3 var(--sans);color:var(--text)}

/* board */
.panel{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);overflow:hidden}
.stats{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid var(--line)}
.stat{padding:14px 16px 16px;border-right:1px solid var(--line)}
.stat:last-child{border-right:0}
.stat span{display:block;font-size:12.5px;color:var(--muted);margin-bottom:6px}
.stat b{font:500 26px/1 var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-0.02em}
.stat b.hot{color:var(--p1)}
.stat small{font:400 12px/1 var(--mono);color:var(--muted);margin-left:4px}
.tbl-wrap{overflow-x:auto}
.tbl-title{display:flex;justify-content:space-between;align-items:baseline;padding:14px 16px 8px;font:500 13.5px/1.2 var(--sans)}
.tbl-title .meta{font-size:11.5px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font:500 12px/1.2 var(--sans);color:var(--muted);padding:8px 16px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--bg-2);white-space:nowrap}
td{padding:10px 16px;border-top:1px solid var(--line);color:var(--text-2);white-space:nowrap}
tbody tr:first-child td{border-top:0}
td.strong{color:var(--text)}
td .mono{color:var(--text)}
tr.st-p1 td:first-child{box-shadow:inset 2px 0 0 var(--p1)}
tr.st-p2 td:first-child{box-shadow:inset 2px 0 0 var(--p2)}
tr.st-tickets td:first-child{box-shadow:inset 2px 0 0 var(--info)}
tr.flash td{animation:flash 1.2s ease-out}
.chip{display:inline-block;padding:3px 6px;border-radius:3px;border:1px solid var(--line-2);font:500 11px/1.2 var(--mono);letter-spacing:.02em;color:var(--muted)}
.chip.p1{color:var(--p1);border-color:rgba(229,72,77,.42);background:rgba(229,72,77,.09)}
.chip.p2{color:var(--p2);border-color:rgba(245,165,36,.38);background:rgba(245,165,36,.08)}
.chip.tickets{color:var(--info);border-color:rgba(141,149,247,.38);background:rgba(141,149,247,.08)}
.chip.ok{color:var(--ok);border-color:rgba(70,167,88,.38);background:rgba(70,167,88,.08)}
.chip.stale{color:var(--p2);border-color:rgba(245,165,36,.38)}
.empty{padding:22px 16px;color:var(--muted);font-size:13px;border-top:1px solid var(--line)}
.livedot{width:6px;height:6px;border-radius:50%;background:var(--ok)}
.livedot.blink{animation:blink .8s ease-out}
.board-foot{padding:10px 16px;border-top:1px solid var(--line);font:400 11.5px/1.4 var(--mono);color:var(--muted)}

/* scenarios */
.scenarios{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.scenario{display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel)}
.scenario header{display:flex;align-items:center;gap:10px}
.num{display:inline-grid;place-items:center;width:22px;height:22px;border:1px solid var(--line-2);border-radius:4px;font:500 12px/1 var(--mono);color:var(--text-2);flex:none}
.scenario h3{margin:0;font:500 16px/1.25 var(--display);letter-spacing:-0.015em}
.steps{margin:0;padding-left:18px;color:var(--text-2);font-size:13.5px;line-height:1.5}
.steps li+li{margin-top:6px}
.steps q{color:var(--text)}
.watch{margin:auto 0 0;font-size:13px;color:var(--text-2)}
.tag{display:inline-block;margin-right:8px;padding:2px 5px;border-radius:3px;background:var(--panel-2);font:500 10.5px/1.3 var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.pin{display:flex;justify-content:space-between;align-items:center;width:100%;height:32px;padding:0 10px;border-radius:4px;border:1px solid var(--line-2);background:var(--bg-2);color:var(--text);font:500 12.5px/1 var(--mono);cursor:pointer}
.pin:hover{border-color:var(--muted)}
.pin-copy{color:var(--muted);font-size:11.5px}
.pin-fallback{margin:0;font:400 12px/1.4 var(--mono);color:var(--muted)}

/* how it works */
.flow{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:22px;padding:22px;border:1px solid var(--line);border-radius:var(--radius)}
.node{position:relative;padding:12px;border:1px solid var(--line-2);border-radius:5px;background:var(--panel)}
.node+.node::before{content:"";position:absolute;left:-22px;top:50%;width:22px;border-top:1px solid var(--muted)}
.node+.node::after{content:"";position:absolute;left:-6px;top:calc(50% - 3px);border:3px solid transparent;border-left:5px solid var(--muted)}
.node b{display:block;font:500 13px/1.3 var(--sans);color:var(--text)}
.node span{display:block;margin-top:4px;font:400 11.5px/1.4 var(--mono);color:var(--muted)}
.facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:12px;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.fact{padding:14px 16px;border-right:1px solid var(--line);font-size:13px;color:var(--text-2)}
.fact:last-child{border-right:0}
.fact b{display:block;margin-bottom:4px;font:500 13px/1.3 var(--sans);color:var(--text)}

/* operator */
details.op{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel)}
details.op summary{cursor:pointer;padding:14px 16px;font:500 14px/1 var(--sans);list-style:none;display:flex;justify-content:space-between}
details.op summary::after{content:"+";font-family:var(--mono);color:var(--muted)}
details.op[open] summary::after{content:"−"}
.op-body{padding:0 16px 16px;display:grid;gap:12px}
.op-row{display:flex;flex-wrap:wrap;gap:8px}
.op input{height:32px;flex:1 1 240px;padding:0 10px;border-radius:4px;border:1px solid var(--line-2);background:var(--bg);color:var(--text);font:400 13px/1 var(--mono)}
.op-out{margin:0;min-height:18px;font:400 12px/1.5 var(--mono);color:var(--text-2);white-space:pre-wrap}
.hint{margin:0;font-size:12.5px;color:var(--muted)}

footer{margin-top:72px;padding-top:18px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px;font-size:12.5px;color:var(--muted)}

@keyframes fadein{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}
@keyframes flash{from{background:var(--panel-2)}to{background:transparent}}
@keyframes blink{0%{opacity:1}40%{opacity:.25}100%{opacity:1}}

@media (max-width:80em){.shell{grid-template-columns:240px minmax(0,1fr)}.toc{display:none}}
@media (max-width:64em){
  .shell{grid-template-columns:minmax(0,1fr)}
  .side{position:static;height:auto;border-right:0;border-top:1px solid var(--line);order:2}
  main{order:1;padding:24px 18px 48px}
  .navlinks{display:none}
  .scenarios{grid-template-columns:minmax(0,1fr)}
  .flow{grid-template-columns:minmax(0,1fr);gap:14px}
  .node+.node::before{left:50%;top:-14px;width:0;height:14px;border-top:0;border-left:1px solid var(--muted)}
  .node+.node::after{left:calc(50% - 3px);top:-6px;border:3px solid transparent;border-top:5px solid var(--muted)}
  .facts,.hero-foot{grid-template-columns:minmax(0,1fr)}
  .fact,.hero-foot div{border-right:0;border-bottom:1px solid var(--line)}
}
@media (max-width:40em){
  .by{display:none}
  .actions .btn-secondary{display:none}
  .hero-body{padding:40px 18px 32px}
  .stats{grid-template-columns:repeat(2,1fr)}
  .stat:nth-child(2){border-right:0}
  .stat:nth-child(-n+2){border-bottom:1px solid var(--line)}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

// Client script. Plain ES5-style JS inside a TS template literal: it uses no
// backticks and no template placeholders, and it only ever writes text nodes.
const JS = `
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  function startCall() {
    var host = document.querySelector('telnyx-ai-agent');
    var launcher = host && host.shadowRoot ? host.shadowRoot.querySelector('button') : null;
    if (!launcher) { setCall(true, 'Connecting to Telnyx… try again in a moment.'); return; }
    setCall(true, 'Starting the call — allow your microphone. The call panel opens bottom-right.');
    launcher.click();
  }
  var callButtons = document.querySelectorAll('[data-action="call"]');
  for (var i = 0; i < callButtons.length; i++) callButtons[i].addEventListener('click', startCall);

  /* ---- keyboard shortcuts (Langfuse-style) ---- */
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    var k = (e.key || '').toLowerCase();
    if (k === 'c') { e.preventDefault(); startCall(); }
    else if (k === 'b') { e.preventDefault(); window.open('/ops/board', '_blank', 'noopener'); }
    else if (k === '1' || k === '2' || k === '3') {
      var s = $('scenario-' + k);
      if (s) { e.preventDefault(); s.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' }); }
    }
  });

  /* ---- PIN chips ---- */
  var pins = document.querySelectorAll('button.pin');
  for (var p = 0; p < pins.length; p++) (function (b) {
    b.addEventListener('click', function () {
      var label = b.querySelector('.pin-copy');
      var pin = b.getAttribute('data-pin') || '';
      function done(t) { label.textContent = t; setTimeout(function () { label.textContent = 'copy'; }, 1600); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(pin).then(function () { done('copied'); }, function () { done('copy failed'); });
      } else { done('copy failed'); }
    });
  })(pins[p]);

  /* ---- live board ---- */
  var ORDER = ['riyadh-north', 'riyadh-south', 'jeddah', 'dammam'];
  var last = null, lastOk = 0, stale = false, polling = false;
  var events = [];
  function rtime(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + ' s ago';
    var m = Math.round(s / 60);
    return m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago';
  }
  function regionStatus(r, sites) {
    if (r.incident) return r.incident.priority === 'P1' ? 'p1' : 'p2';
    for (var i = 0; i < sites.length; i++) if (sites[i].region === r.region && sites[i].open_ticket) return 'tickets';
    return 'quiet';
  }
  function label(s) { return String(s || '').replace(/^the\\s+/i, ''); }
  function pushEvent(kind, text, flash) {
    events.unshift({ kind: kind, text: text, at: Date.now(), fresh: true });
    if (events.length > 8) events.length = 8;
    renderEvents();
  }
  function renderEvents() {
    var list = $('events');
    clear(list);
    if (events.length === 0) { list.appendChild(el('li', '', 'Waiting for the first board…')); return; }
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var li = el('li', 'k-' + ev.kind + (ev.fresh ? ' fresh' : ''), ev.text);
      var t = el('time', '', rtime(ev.at));
      t.setAttribute('data-at', String(ev.at));
      li.appendChild(t);
      list.appendChild(li);
      ev.fresh = false;
    }
  }
  function byRegion(board) {
    var m = {};
    for (var i = 0; i < board.regions.length; i++) m[board.regions[i].region] = board.regions[i];
    return m;
  }
  function bySite(board) {
    var m = {};
    for (var i = 0; i < board.sites.length; i++) m[board.sites[i].site_id] = board.sites[i];
    return m;
  }
  var flashKeys = {};
  function diff(prev, next) {
    var pr = byRegion(prev), nr = byRegion(next);
    Object.keys(nr).forEach(function (k) {
      var a = pr[k] && pr[k].incident, b = nr[k].incident, name = nr[k].label;
      if (!a && b) { pushEvent(b.priority === 'P1' ? 'p1' : 'p2', b.id + ' declared · ' + name + ' · ' + b.priority + ' · ' + b.site_count + ' branches'); flashKeys['r:' + k] = 1; }
      else if (a && !b) { pushEvent('ok', a.id + ' resolved · ' + name); flashKeys['r:' + k] = 1; }
      else if (a && b) {
        if (a.priority !== b.priority) { pushEvent(b.priority === 'P1' ? 'p1' : 'p2', b.id + ' raised to ' + b.priority + ' · ' + b.site_count + ' branches'); flashKeys['r:' + k] = 1; }
        else if (a.site_count !== b.site_count) { pushEvent('p2', b.id + ' now affects ' + b.site_count + ' branches'); flashKeys['r:' + k] = 1; }
        var ea = pr[k].esc, eb = nr[k].esc;
        if (eb && ea && eb.level > ea.level) { pushEvent('p1', b.id + ' escalated · page L' + eb.level); flashKeys['r:' + k] = 1; }
        if (eb && ea && eb.acked && !ea.acked) { pushEvent('ok', b.id + ' acknowledged'); flashKeys['r:' + k] = 1; }
      }
    });
    var ps = bySite(prev), ns = bySite(next);
    Object.keys(ns).forEach(function (k) {
      var a = ps[k] && ps[k].open_ticket, b = ns[k].open_ticket;
      if (!a && b) { pushEvent('info', b.id + ' opened · ' + k + ' · ' + b.priority); flashKeys['s:' + k] = 1; }
      else if (a && !b) { pushEvent('ok', a.id + ' closed · ' + k); }
      else if (a && b && a.priority !== b.priority) { pushEvent('p2', b.id + ' now ' + b.priority + ' · ' + k); flashKeys['s:' + k] = 1; }
    });
  }
  function cell(tr, text, cls) { var td = el('td', cls || '', text); tr.appendChild(td); return td; }
  function monoCell(tr, text) { var td = el('td'); td.appendChild(el('span', 'mono', text)); tr.appendChild(td); return td; }
  function chipCell(tr, text, cls) { var td = el('td'); td.appendChild(el('span', 'chip ' + cls, text)); tr.appendChild(td); return td; }
  function render(board) {
    var regions = board.regions.slice().sort(function (a, b) { return ORDER.indexOf(a.region) - ORDER.indexOf(b.region); });
    var sites = board.sites || [];
    var incidents = 0, p1 = 0, tickets = 0;
    regions.forEach(function (r) { if (r.incident) { incidents++; if (r.incident.priority === 'P1') p1++; } });
    sites.forEach(function (s) { if (s.open_ticket) tickets++; });
    $('stIncidents').textContent = String(incidents);
    $('stP1').textContent = String(p1);
    $('stP1').className = p1 > 0 ? 'hot' : '';
    $('stTickets').textContent = String(tickets);
    $('sdIncidents').textContent = String(incidents);
    $('sdP1').textContent = String(p1);
    $('sdP1').className = p1 > 0 ? 'hot' : '';
    $('sdTickets').textContent = String(tickets);
    $('sdMode').textContent = board.actor_mode || 'unknown';

    var rb = $('regionRows');
    clear(rb);
    regions.forEach(function (r) {
      var st = regionStatus(r, sites);
      var tr = el('tr', 'st-' + st + (flashKeys['r:' + r.region] ? ' flash' : ''));
      cell(tr, r.label, 'strong');
      chipCell(tr, st === 'p1' ? 'P1' : st === 'p2' ? 'P2' : st === 'tickets' ? 'TICKETS' : 'QUIET', st);
      if (r.incident) {
        monoCell(tr, r.incident.id);
        cell(tr, r.incident.site_count + (r.incident.site_count === 1 ? ' branch' : ' branches'));
        monoCell(tr, r.incident.declared_local || '—');
      } else { cell(tr, '—'); cell(tr, '—'); cell(tr, '—'); }
      var e = r.esc;
      if (e && r.incident) {
        if (e.acked) chipCell(tr, 'ACKED', 'ok');
        else monoCell(tr, 'L' + e.level + (e.due_local ? ' · due ' + e.due_local : ''));
      } else cell(tr, '—');
      rb.appendChild(tr);
    });

    var tb = $('ticketRows');
    clear(tb);
    var open = sites.filter(function (s) { return s.open_ticket; }).sort(function (a, b) {
      var d = ORDER.indexOf(a.region) - ORDER.indexOf(b.region);
      return d !== 0 ? d : (a.site_id < b.site_id ? -1 : 1);
    });
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
  function setStale(on) {
    stale = on;
    $('staleChip').hidden = !on;
  }
  function ageTick() {
    var age = lastOk ? rtime(lastOk) : 'never';
    $('updated').textContent = lastOk ? 'updated ' + age : 'connecting…';
    $('stAge').textContent = lastOk ? String(Math.max(0, Math.round((Date.now() - lastOk) / 1000))) : '–';
    $('sdAge').textContent = lastOk ? age : '—';
    if (lastOk && Date.now() - lastOk > 20000) setStale(true);
    var times = document.querySelectorAll('#events time[data-at]');
    for (var i = 0; i < times.length; i++) times[i].textContent = rtime(Number(times[i].getAttribute('data-at')));
  }
  function blink() {
    var d = $('liveDot');
    d.className = 'livedot';
    void d.offsetWidth;
    d.className = 'livedot blink';
  }
  function poll() {
    if (polling) return;
    polling = true;
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 8000);
    fetch('/ops/board', { signal: ctl.signal, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (b) {
        if (!b || !Array.isArray(b.regions) || !Array.isArray(b.sites)) throw new Error('bad board');
        var prev = last;
        last = b; lastOk = Date.now(); setStale(false);
        if (prev) diff(prev, b); else pushEvent('info', 'Board synced · ' + b.regions.length + ' regions');
        render(b); blink(); ageTick();
      })
      .catch(function () { setStale(true); })
      .then(function () { clearTimeout(timer); polling = false; setTimeout(poll, 5000); });
  }
  renderEvents();
  poll();
  setInterval(ageTick, 1000);

  /* ---- on this page ---- */
  var links = document.querySelectorAll('.toc a');
  if ('IntersectionObserver' in window && links.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        for (var i = 0; i < links.length; i++) {
          links[i].className = links[i].getAttribute('href') === '#' + en.target.id ? 'active' : '';
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    ['call', 'board', 'scenarios', 'how', 'operator'].forEach(function (id) { var s = $(id); if (s) io.observe(s); });
  }

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
    resolve: '/ops/resolve?region=riyadh-north'
  };
  var opButtons = document.querySelectorAll('[data-op]');
  for (var o = 0; o < opButtons.length; o++) (function (b) {
    b.addEventListener('click', function () {
      var path = OPS[b.getAttribute('data-op')];
      var token = tokenInput.value.trim();
      if (!path) return;
      if (!token) { out.textContent = 'Enter the ops token first.'; return; }
      out.textContent = b.textContent + ' …';
      fetch(path, { method: 'POST', headers: { Authorization: 'Bearer ' + token } })
        .then(function (r) { return r.text().then(function (t) { out.textContent = b.textContent + ' → HTTP ' + r.status + (t ? '\\n' + t.slice(0, 400) : ''); }); })
        .catch(function (err) { out.textContent = b.textContent + ' failed: ' + String(err && err.message || err); });
    });
  })(opButtons[o]);
})();
`;

const LOGO = `<svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true"><rect x="1.5" y="1.5" width="19" height="19" rx="4" stroke="currentColor" stroke-width="1.5"/><path d="M7 17V6.5h8V17" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="12.8" cy="12" r="1.1" fill="currentColor"/></svg>`;

export function renderDemoPage(guide: DemoGuide | null): string {
  const byKey = new Map<string, GuideScenario>();
  for (const scenario of guide?.scenarios ?? []) byKey.set(scenario.key, scenario);

  const scenarios = [
    scenarioCard({
      n: 1,
      title: "Join the incident",
      steps: [
        "Press <b>Start call</b>, then say: <q>Hi, this is Ahmed from Al-Waha Pharmacies. Our Al Yasmin branch is offline — site R U H one one four.</q>",
        "Read the PIN digit by digit when Sanad asks.",
        "When Sanad mentions the Riyadh North incident, say <q>yes, add us.</q>",
      ],
      watch: "the Riyadh North incident turn P1 at 3 branches, and a new ticket row appear.",
      chip: pinChip(byKey.get("join")),
    }),
    scenarioCard({
      n: 2,
      title: "Open a new ticket",
      steps: [
        "Say: <q>Our site is J E D zero zero seven in Jeddah.</q> and give the PIN.",
        "Describe the fault: <q>The internet is down and the card machines don't work — customers are affected.</q>",
      ],
      watch: "a new Jeddah ticket appear with its priority, read back to you by Sanad.",
      chip: pinChip(byKey.get("new")),
    }),
    scenarioCard({
      n: 3,
      title: "Lockout &amp; human",
      steps: [
        "Give any site ID, then a wrong PIN three times.",
        "Ask: <q>Can I speak to an engineer?</q>",
      ],
      watch: "verification lock for the call, then the handover to the on-call engineer (or a callback message).",
      chip: "",
    }),
  ].join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NOC Front Door — Live NOC wall</title>
<meta name="description" content="Sanad, the 24/7 AI fault line of Najd Networks — a live Telnyx Voice AI + Edge Compute demo.">
<meta name="theme-color" content="#111110">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONTS_URL}" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<div class="announce">Live demo — call Sanad from your browser · Telnyx Voice AI + Edge Compute · <a href="#how">How it works</a></div>
<header class="nav">
  <a class="brand" href="#call" aria-label="NOC FRONT DOOR — home">${LOGO}<span class="wordmark">noc front door</span><span class="by">by Najd Networks · 24/7 AI fault line</span></a>
  <nav class="navlinks" aria-label="Sections"><a href="#call">Talk to Sanad</a><a href="#board">Live board</a><a href="#scenarios">Scenarios</a><a href="#how">How it works</a></nav>
  <div class="actions">
    <button type="button" class="btn btn-primary" data-action="call">Start call <span class="kbd">C</span></button>
    <a class="btn btn-secondary" href="/ops/board" target="_blank" rel="noopener">Board JSON <span class="kbd">B</span></a>
  </div>
</header>

<div class="shell">
  <aside class="side" aria-label="System">
    <div class="side-sec">
      <h3>System</h3>
      <div class="kv"><span>Actors</span><b id="sdMode">—</b></div>
      <div class="kv"><span>Board updated</span><b id="sdAge">—</b></div>
      <div class="kv"><span>Open incidents</span><b id="sdIncidents">–</b></div>
      <div class="kv"><span>P1 incidents</span><b id="sdP1">–</b></div>
      <div class="kv"><span>Open tickets</span><b id="sdTickets">–</b></div>
      <div class="kv"><span>Greeting webhook budget</span><b>2.5 s</b></div>
    </div>
    <div class="side-sec">
      <h3>Event feed</h3>
      <ol class="events" id="events" aria-live="polite"></ol>
    </div>
    <div class="side-sec">
      <h3>Stack</h3>
      <ul class="stack">
        <li><span>Telnyx Voice AI</span><span class="mono">workflow</span></li>
        <li><span>Edge Functions</span><span class="mono">noc-edge</span></li>
        <li><span>Stateful Actors</span><span class="mono">per site</span></li>
        <li><span>KV</span><span class="mono">flags · cache</span></li>
        <li><span>MCP server</span><span class="mono">5 tools</span></li>
      </ul>
    </div>
  </aside>

  <main>
   <div class="wrap">
    <section id="call" aria-labelledby="heroTitle">
      <div class="frame">
        <span class="crop tl"></span><span class="crop tr"></span><span class="crop bl"></span><span class="crop br"></span>
        <div class="strip"><span><b>24-node</b> conversation workflow</span><span class="sep">·</span><span><b>5</b> MCP tools</span><span class="sep">·</span><span><b>4</b> regions on the live board</span></div>
        <div class="hero-body">
          <h1 id="heroTitle">The 24/7 <mark>AI fault line</mark> for Najd Networks</h1>
          <p class="sub">Sanad takes outage calls for a Saudi managed-services provider: it verifies the site by PIN, recognises an ongoing regional incident, opens or joins the ticket, and escalates P2 → P1 when a third branch goes down — on Telnyx Voice AI, Edge Functions, KV, Stateful Actors and MCP.</p>
          <div class="cta">
            <button type="button" class="btn btn-primary btn-lg" data-action="call">Start call <span class="kbd">C</span></button>
            <a class="btn btn-lg" href="#scenarios">Scenarios <span class="kbd">1</span></a>
          </div>
          <p class="callstate"><span class="dot" id="callDot"></span><span id="callText">Ready — the call runs in your browser; allow the microphone. The Telnyx call panel opens bottom-right.</span></p>
        </div>
        <div class="hero-foot">
          <div><b>Verified callers</b>Site ID + PIN over voice; identity rides the signed webhook body.</div>
          <div><b>One ticket per site</b>Enforced by a Stateful Actor — concurrency-safe.</div>
          <div><b>Knows the outage</b>Regional incidents deflect duplicate reports.</div>
        </div>
      </div>
    </section>

    <section id="board" aria-labelledby="boardTitle">
      <div class="sec-head">
        <h2 id="boardTitle">Live board</h2>
        <div class="meta"><span class="livedot" id="liveDot"></span><span id="updated">connecting…</span><span class="chip stale" id="staleChip" hidden>stale</span></div>
      </div>
      <p class="lede">Your call changes this board: the ticket appears, and the incident's priority and branch count update within seconds.</p>
      <div class="panel">
        <div class="stats">
          <div class="stat"><span>Open incidents</span><b id="stIncidents">–</b></div>
          <div class="stat"><span>P1 incidents</span><b id="stP1">–</b></div>
          <div class="stat"><span>Open tickets</span><b id="stTickets">–</b></div>
          <div class="stat"><span>Updated</span><b id="stAge">–</b><small>s ago</small></div>
        </div>
        <div class="tbl-title"><span>Regions</span></div>
        <div class="tbl-wrap"><table>
          <thead><tr><th>Region</th><th>Status</th><th>Incident</th><th>Branches</th><th>Declared</th><th>Escalation</th></tr></thead>
          <tbody id="regionRows"></tbody>
        </table></div>
        <div class="tbl-title"><span>Open tickets</span></div>
        <div class="tbl-wrap" id="ticketsTable" hidden><table>
          <thead><tr><th>Site</th><th>Branch</th><th>Ticket</th><th>Priority</th><th>Opened</th></tr></thead>
          <tbody id="ticketRows"></tbody>
        </table></div>
        <div class="empty hatch" id="ticketsEmpty">No open tickets — all branches nominal.</div>
        <div class="board-foot">Live from Stateful Actors via /ops/board · refresh 5 s · data masked</div>
      </div>
    </section>

    <section id="scenarios" aria-labelledby="scenariosTitle">
      <div class="sec-head"><h2 id="scenariosTitle">Scenarios</h2><div class="meta">press 1 · 2 · 3</div></div>
      <p class="lede">Three short calls that exercise the whole system. The branches and PINs are fictional demo data.</p>
      <div class="scenarios">${scenarios}</div>
    </section>

    <section id="how" aria-labelledby="howTitle">
      <div class="sec-head"><h2 id="howTitle">How it works</h2></div>
      <p class="lede">Every call carries one trace id from the greeting webhook through the tools, MCP and the actors.</p>
      <div class="flow hatch">
        <div class="node"><b>Caller</b><span>web call · this page</span></div>
        <div class="node"><b>Telnyx Voice AI</b><span>Sanad · 24-node workflow</span></div>
        <div class="node"><b>Edge Function</b><span>/dv · tools · MCP</span></div>
        <div class="node"><b>Stateful Actors + KV</b><span>tickets · incidents · flags</span></div>
        <div class="node"><b>Live board</b><span>/ops/board · masked</span></div>
      </div>
      <div class="facts">
        <div class="fact"><b>Race test</b>10 concurrent opens for one site: actors create exactly 1 ticket; plain KV creates 10.</div>
        <div class="fact"><b>Fails open</b>If KV or actors are slow, Sanad still answers with safe defaults and says so honestly.</div>
        <div class="fact"><b>Observable</b>An external prober checks deep health every 10 s; one trace id per call across every hop.</div>
      </div>
    </section>

    <section id="operator" aria-labelledby="opTitle">
      <details class="op">
        <summary id="opTitle">Operator</summary>
        <div class="op-body">
          <p class="hint">Demo controls for the presenter. The ops token stays in this browser tab (sessionStorage) and is sent only as a bearer header to this site's /ops routes.</p>
          <div class="op-row"><input id="opsToken" type="password" autocomplete="off" spellcheck="false" placeholder="Ops token" aria-label="Ops token"></div>
          <div class="op-row">
            <button type="button" class="btn" data-op="reset">Reset demo</button>
            <button type="button" class="btn" data-op="stage">Stage Riyadh North incident</button>
            <button type="button" class="btn" data-op="ack">Acknowledge</button>
            <button type="button" class="btn" data-op="resolve">Resolve</button>
          </div>
          <p class="op-out" id="opOut" aria-live="polite"></p>
        </div>
      </details>
    </section>

    <footer>
      <span>Built on Telnyx Voice AI · Edge Compute · KV · Stateful Actors · MCP — backend code authored by OpenCode on Telnyx Inference.</span>
      <span>Calls are recorded and handled by an AI assistant.</span>
    </footer>
   </div>
  </main>

  <nav class="toc" aria-label="On this page">
    <h4>On this page</h4>
    <ol>
      <li><a href="#call" class="active">Talk to Sanad</a></li>
      <li><a href="#board">Live board</a></li>
      <li><a href="#scenarios">Scenarios</a></li>
      <li><a href="#how">How it works</a></li>
      <li><a href="#operator">Operator</a></li>
    </ol>
  </nav>
</div>

<telnyx-ai-agent agent-id="${DEMO_AGENT_ID}"></telnyx-ai-agent>
<script async src="${WIDGET_SCRIPT_URL}"></script>
<script>${JS}</script>
</body>
</html>`;
}
