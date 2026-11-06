import { describe, it, expect } from "vitest";
import { panelHtml } from "../../src/ui/html";
describe("agent webview", () => {
  it("uses a restrictive CSP, named controls and native theme tokens", () => {
    const html = panelHtml(
      "nonce-test",
      "vscode-resource:/panel.css",
      "vscode-resource:/panel.js",
      "vscode-resource:",
    );
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-nonce-test'");
    expect(html).toContain('id="instruction"');
    expect(html).toContain('for="instruction"');
    expect(html).toContain('id="cancel"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("novalidate");
    expect(html).not.toMatch(/https:\/\//);
  });
});
