import { describe, expect, it } from "vitest";
import { DEMO_AGENT_ID, WIDGET_SCRIPT_SRI, WIDGET_SCRIPT_URL, renderDemoPage } from "../../src/demo/page";
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

describe("renderDemoPage", () => {
  it("embeds the widget element and the exact pinned script", () => {
    const html = renderDemoPage(null);
    expect(html).toContain(`<telnyx-ai-agent agent-id="${DEMO_AGENT_ID}"></telnyx-ai-agent>`);
    expect(html).toContain(
      `<script async src="${WIDGET_SCRIPT_URL}" integrity="${WIDGET_SCRIPT_SRI}" crossorigin="anonymous"></script>`,
    );
    expect(WIDGET_SCRIPT_URL).toBe("https://unpkg.com/@telnyx/ai-agent-widget@0.36.0/dist/bundle.min.js");
    expect(WIDGET_SCRIPT_SRI).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
  });

  it("loads only the widget and Google Fonts from other origins", () => {
    const html = renderDemoPage(guide());
    expect(externalOrigins(html)).toEqual([
      "https://fonts.googleapis.com",
      "https://fonts.gstatic.com",
      "https://unpkg.com",
    ]);
    expect(html).toContain("family=Geist:wght@400;500;600");
    expect(html).toContain("family=Geist+Mono:wght@400;500");
    expect(html).toContain("family=Inter:wght@400;500;600");
  });

  it("renders the three scenarios with keyboard targets", () => {
    const html = renderDemoPage(null);
    expect(html).toContain("Join the incident");
    expect(html).toContain("Open a new ticket");
    expect(html).toContain("Lockout &amp; human");
    for (const n of [1, 2, 3]) expect(html).toContain(`id="scenario-${n}"`);
    // the lockout scenario must never lock the published demo sites
    expect(html).toContain("D M M zero one one");
  });

  it("marks the headline phrase with the highlighter and shows shortcut badges", () => {
    const html = renderDemoPage(null);
    expect(html).toContain("<mark>AI fault line</mark>");
    expect(html).toContain('Start call <span class="kbd">C</span>');
    expect(html).toContain('Board JSON <span class="kbd">B</span>');
    expect(html).toContain("On this page");
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

  it("polls /ops/board with an abort timeout and no overlap", () => {
    const html = renderDemoPage(null);
    expect(html).toContain("fetch('/ops/board'");
    expect(html).toContain("AbortController");
    expect(html).toContain("if (polling) return;");
  });

  it("renders both PIN chips when the guide secret is present", () => {
    const html = renderDemoPage(guide());
    expect(html).toContain(`data-pin="${PIN_JOIN}"`);
    expect(html).toContain(`data-pin="${PIN_NEW}"`);
    expect(html).toContain(`PIN ${PIN_JOIN}`);
    expect(html).toContain(`PIN ${PIN_NEW}`);
    expect(html).not.toContain("PIN: see the README reviewer guide");
  });

  it("falls back to the README guide without the secret and leaks no PIN or phone", () => {
    const html = renderDemoPage(null);
    expect(html).toContain("PIN: see the README reviewer guide");
    expect(html).not.toContain("data-pin=");
    expect(html).not.toContain(PIN_JOIN);
    expect(html).not.toContain(PIN_NEW);
    expect(html).not.toMatch(/\+[0-9]{8,15}/);
  });

  it("keeps the board, operator drawer and footer copy", () => {
    const html = renderDemoPage(null);
    expect(html).toContain("Live board");
    expect(html).toContain("Event feed");
    expect(html).toContain("How it works");
    expect(html).toContain('<summary id="opTitle">Operator</summary>');
    expect(html).toContain("'/ops/reset'");
    expect(html).toContain("'/ops/stage-incident?region=riyadh-north'");
    expect(html).toContain("'/ops/ack?region=riyadh-north'");
    expect(html).toContain("'/ops/resolve?region=riyadh-north'");
    expect(html).toContain("'/ops/unlock?site=RUH-114'");
    expect(html).toContain("'/ops/unlock?site=JED-007'");
    expect(html).toContain("sessionStorage");
    expect(html).toContain("Live from Stateful Actors via /ops/board");
    expect(html).toContain("backend code authored by OpenCode on Telnyx Inference");
    expect(html).toContain("Calls are recorded and handled by an AI assistant.");
  });
});
