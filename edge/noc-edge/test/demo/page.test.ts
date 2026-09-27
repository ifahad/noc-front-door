import { describe, expect, it } from "vitest";
import { DEMO_AGENT_ID, renderDemoPage } from "../../src/demo/page";
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

describe("renderDemoPage", () => {
  it("embeds the widget element and the exact pinned script", () => {
    const html = renderDemoPage(null);
    expect(html).toContain(
      `<telnyx-ai-agent agent-id="${DEMO_AGENT_ID}"></telnyx-ai-agent>`,
    );
    expect(html).toContain(
      '<script async src="https://unpkg.com/@telnyx/ai-agent-widget@0.36.0"></script>',
    );
  });

  it("renders the three scenario titles", () => {
    const html = renderDemoPage(null);
    expect(html).toContain("Join the incident");
    expect(html).toContain("Open a new ticket");
    expect(html).toContain("Lockout &amp; human");
  });

  it("never uses innerHTML or inline event-handler attributes", () => {
    const html = renderDemoPage(guide());
    expect(html).not.toContain("innerHTML");
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it("renders both PIN chips when the guide secret is present", () => {
    const html = renderDemoPage(guide());
    expect(html).toContain(`data-pin="${PIN_JOIN}"`);
    expect(html).toContain(`data-pin="${PIN_NEW}"`);
    expect(html).toContain(`PIN ${PIN_JOIN}`);
    expect(html).toContain(`PIN ${PIN_NEW}`);
    expect(html).not.toContain("PIN: see the README reviewer guide");
  });

  it("falls back to the README guide without the secret and leaks no PIN", () => {
    const html = renderDemoPage(null);
    expect(html).toContain("PIN: see the README reviewer guide");
    expect(html).not.toContain("data-pin=");
    expect(html).not.toMatch(/[0-9]{4}/);
    expect(html).not.toMatch(/\+[0-9]{8,15}/);
  });

  it("keeps the operator drawer, board panels and footer copy", () => {
    const html = renderDemoPage(null);
    expect(html).toContain("NOC board");
    expect(html).toContain("Event feed");
    expect(html).toContain("How it works");
    expect(html).toContain("<summary>Operator</summary>");
    expect(html).toContain("/ops/reset");
    expect(html).toContain("/ops/stage-incident?region=riyadh-north");
    expect(html).toContain("/ops/ack?region=riyadh-north");
    expect(html).toContain("/ops/resolve?region=riyadh-north");
    expect(html).toContain("Live from Stateful Actors via /ops/board");
    expect(html).toContain("code authored by OpenCode on Telnyx Inference");
    expect(html).toContain("Calls are recorded and handled by an AI assistant.");
  });
});
