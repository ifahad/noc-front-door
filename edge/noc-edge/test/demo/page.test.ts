import { describe, expect, it } from "vitest";
import {
  CONSOLE_POLL_MS,
  DEMO_AGENT_AR_ID,
  DEMO_AGENT_ID,
  IDLE_PAUSE_MS,
  PUBLIC_POLL_MS,
  SANAD_PHONE_DISPLAY,
  SANAD_PHONE_TEL,
  WIDGET_SCRIPT_SRI,
  WIDGET_SCRIPT_URL,
  renderDemoPage,
} from "../../src/demo/page";
import type { DemoGuide } from "../../src/demo/guide";

// PINs are secrets: assemble them at runtime so no literal PIN-shaped
// string exists in this file.
const PIN_JOIN = ["8", "2", "4", "1"].join("");
const PIN_NEW = ["7", "1", "5", "9"].join("");

function guide(): DemoGuide {
  return {
    scenarios: [
      { key: "join", site: "RUH-114", pin: PIN_JOIN },
      { key: "new", site: "JED-007", pin: PIN_NEW },
    ],
  };
}

function externalOrigins(html: string): string[] {
  const urls = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1] ?? "");
  return [...new Set(urls.map((u) => new URL(u).origin))].sort();
}

function consoleSection(html: string): string {
  const start = html.indexOf('<section class="console" id="console"');
  const end = html.indexOf("</section>", start);
  return html.slice(start, end);
}

describe("renderDemoPage", () => {
  it("embeds the widget element and the exact pinned script with SRI", () => {
    const html = renderDemoPage(null);
    expect(html).toContain(`<telnyx-ai-agent agent-id="${DEMO_AGENT_ID}"></telnyx-ai-agent>`);
    expect(html).toContain(
      `<script async src="${WIDGET_SCRIPT_URL}" integrity="${WIDGET_SCRIPT_SRI}" crossorigin="anonymous"></script>`,
    );
    expect(WIDGET_SCRIPT_URL).toBe("https://unpkg.com/@telnyx/ai-agent-widget@0.36.0/dist/bundle.min.js");
  });

  it("loads only the widget and Google Fonts from other origins", () => {
    const html = renderDemoPage(guide());
    expect(externalOrigins(html)).toEqual([
      "https://fonts.googleapis.com",
      "https://fonts.gstatic.com",
      "https://unpkg.com",
    ]);
    expect(html).toContain("family=Geist:wght@400;500;600");
    expect(html).toContain("family=IBM+Plex+Sans+Arabic:wght@400;500");
  });

  it("is a production front page: report an outage by browser or phone, in English or Arabic", () => {
    const html = renderDemoPage(null);
    expect(html).toContain("<title>Najd Networks NOC — Report an outage, 24/7</title>");
    expect(html).toContain("Report a network outage <em>in under a minute.</em>");
    expect(html).toContain('data-action="call"');
    expect(html).toContain("Call from your browser");
    expect(html).toContain(`href="${SANAD_PHONE_TEL}"`);
    expect(html).toContain(`Call ${SANAD_PHONE_DISPLAY}</a>`);
    expect(SANAD_PHONE_TEL).toMatch(/^tel:\+1(-[0-9]+)+$/);
    expect(html).toContain('<span class="lang ar" lang="ar">العربية</span>');
    expect(html).toContain("What happens when you call");
    expect(html).toContain("Calls are recorded and handled by an AI assistant.");
  });

  it("calls the Saudi-Arabic assistant directly, without the English hand-off", () => {
    const html = renderDemoPage(null);
    expect(DEMO_AGENT_AR_ID).toBe("assistant-60f3a28e-5a12-49e3-bce1-1f2136e4aa5a");
    expect(html).toContain(
      `<button type="button" class="btn btn-lg ar" data-action="call" data-lang="ar" lang="ar" dir="rtl">`,
    );
    expect(html).toContain("اتصل بالعربي</button>");
    // One widget per assistant; only the one in use is shown, so the two
    // floating launchers never stack.
    expect(html).toContain(`<telnyx-ai-agent agent-id="${DEMO_AGENT_ID}"></telnyx-ai-agent>`);
    expect(html).toContain(`<telnyx-ai-agent agent-id="${DEMO_AGENT_AR_ID}" hidden></telnyx-ai-agent>`);
    expect(html).toContain("telnyx-ai-agent[hidden]{display:none!important}");
    expect(html).toContain(`var AGENTS = { en: '${DEMO_AGENT_ID}', ar: '${DEMO_AGENT_AR_ID}' };`);
    expect(html).toContain("startCall(this.getAttribute('data-lang') === 'ar' ? 'ar' : 'en')");
  });

  it("draws the live network map with the four regions", () => {
    const html = renderDemoPage(null);
    for (const id of ["jeddah", "riyadh-north", "riyadh-south", "dammam"]) {
      expect(html).toContain(`id="node-${id}"`);
      expect(html).toContain(`id="sub-${id}"`);
    }
    expect(html).toContain('aria-label="Najd Networks regions and their live status"');
    expect(html).toContain('id="statusPill"');
  });

  it("keeps the walkthrough material in a hidden operator console", () => {
    const html = renderDemoPage(guide());
    const main = html.slice(0, html.indexOf('<section class="console"'));
    expect(html).toContain('<section class="console" id="console" aria-labelledby="consoleTitle" hidden>');
    const con = consoleSection(html);
    for (const text of ["Operator console", "Join the incident", "Open a new ticket", "Lockout &amp; human", "How it works", "Event feed", "Stateful Actors + KV", "Reset demo"]) {
      expect(con).toContain(text);
      expect(main).not.toContain(text);
    }
    expect(main).not.toContain("data-pin=");
    expect(html).toContain("location.hash === '#console'");
    expect(html).toContain("e.key === '`'");
  });

  it("never assigns HTML strings or uses inline event-handler attributes", () => {
    const html = renderDemoPage(guide());
    expect(html).not.toContain("innerHTML");
    expect(html).not.toContain("outerHTML");
    expect(html).not.toContain("insertAdjacentHTML");
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it("does not bring back the rejected neon look", () => {
    const html = renderDemoPage(null);
    expect(html).not.toContain("backdrop-filter");
    expect(html).not.toContain("conic-gradient");
    expect(html).not.toContain("radial-gradient");
  });

  it("polls /ops/board gently: 15 s public, 10 s console, only when visible, with backoff and an idle pause", () => {
    const html = renderDemoPage(null);
    expect(PUBLIC_POLL_MS).toBe(15000);
    expect(CONSOLE_POLL_MS).toBe(10000);
    expect(IDLE_PAUSE_MS).toBe(600000);
    expect(html).toContain(
      `var PUBLIC_POLL = ${PUBLIC_POLL_MS}, CONSOLE_POLL = ${CONSOLE_POLL_MS}, MAX_BACKOFF = 60000, IDLE_PAUSE = ${IDLE_PAUSE_MS};`,
    );
    expect(html).toContain("if (Date.now() - lastInput > IDLE_PAUSE) { paused = true; ageTick(); return; }");
    expect(html).toContain("if (paused) { paused = false; ageTick(); schedule(0); }");
    expect(html).toContain("fetch('/ops/board'");
    expect(html).toContain("AbortController");
    expect(html).toContain("if (polling) return;");
    expect(html).toContain("if (document.visibilityState === 'hidden') return;");
    expect(html).toContain("visibilitychange");
    expect(html).toContain("Math.pow(2, failures - 1)");
  });

  it("renders both PIN chips inside the console when the guide secret is present", () => {
    const con = consoleSection(renderDemoPage(guide()));
    expect(con).toContain(`data-pin="${PIN_JOIN}"`);
    expect(con).toContain(`data-pin="${PIN_NEW}"`);
    expect(con).toContain(`PIN ${PIN_JOIN}`);
    expect(con).not.toContain("PIN: see the README reviewer guide");
  });

  it("falls back to the README guide without the secret and leaks no PIN or phone", () => {
    const html = renderDemoPage(null);
    expect(html).toContain("PIN: see the README reviewer guide");
    expect(html).not.toContain("data-pin=");
    expect(html).not.toContain(PIN_JOIN);
    expect(html).not.toContain(PIN_NEW);
    expect(html).not.toMatch(/\+[0-9]{8,15}/);
  });

  it("keeps the operator controls and the token in sessionStorage only", () => {
    const html = renderDemoPage(null);
    expect(html).toContain("'/ops/reset'");
    expect(html).toContain("'/ops/stage-incident?region=riyadh-north'");
    expect(html).toContain("'/ops/ack?region=riyadh-north'");
    expect(html).toContain("'/ops/resolve?region=riyadh-north'");
    expect(html).toContain("sessionStorage");
    expect(html).not.toContain("localStorage");
    expect(html).toContain("Live from Stateful Actors via /ops/board");
  });
});
