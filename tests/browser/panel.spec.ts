import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { panelHtml } from "../../src/ui/html";
let server: Server, url: string;
const initial = {
  busy: false,
  status: "Ready",
  text: "",
  activity: [],
  context: [],
  proposals: [],
};
test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.url === "/panel.js" || req.url === "/panel.css") {
      res.setHeader(
        "Content-Type",
        req.url.endsWith(".css") ? "text/css" : "application/javascript",
      );
      res.end(await readFile(`media${req.url}`));
      return;
    }
    const html = panelHtml(
      "browser-test",
      "/panel.css",
      "/panel.js",
      "'self'",
    ).replace(
      '<script nonce="browser-test"',
      `<script nonce="browser-test">window.__messages=[];window.__draft={};window.acquireVsCodeApi=()=>({postMessage:m=>window.__messages.push(m),getState:()=>window.__draft,setState:s=>window.__draft=s});</script><script nonce="browser-test"`,
    );
    res.setHeader("Content-Type", "text/html");
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
test.beforeEach(async ({ page }) => {
  await page.goto(url);
  await page.evaluate(
    (state) =>
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "state", state } }),
      ),
    initial,
  );
});
test("label, keyboard and empty validation remain usable at narrow width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 280, height: 650 });
  await page.getByRole("button", { name: "Start task" }).click();
  await expect(page.getByRole("alert")).toContainText("Describe a task");
  await expect(page.getByLabel("What would you like to change?")).toBeFocused();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});
test("submits once and preserves the draft while host begins work", async ({
  page,
}) => {
  await page
    .getByLabel("What would you like to change?")
    .fill("Add a configuration command");
  await page.getByRole("button", { name: "Start task" }).dblclick();
  const requests = await page.evaluate(() =>
    (window as any).__messages.filter((m: any) => m.type === "run"),
  );
  expect(requests).toHaveLength(1);
  await page.evaluate(
    (state) =>
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "state", state } }),
      ),
    { ...initial, busy: true, status: "Reading code" },
  );
  await expect(page.getByRole("button", { name: "Start task" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  expect(
    await page.evaluate(() => (window as any).__messages.at(-1).type),
  ).toBe("cancel");
});
test("renders model text as text and exposes context reasons", async ({
  page,
}) => {
  await page.evaluate(
    (state) =>
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "state", state } }),
      ),
    {
      ...initial,
      text: '<img src=x onerror="alert(1)">',
      context: [
        {
          path: "src/cli.py",
          startLine: 1,
          endLine: 20,
          reason: "Matches command registration",
        },
      ],
    },
  );
  await expect(page.locator("#reply")).toHaveText(
    '<img src=x onerror="alert(1)">',
  );
  await expect(page.locator("#reply img")).toHaveCount(0);
  await expect(page.locator("#context-list")).toContainText(
    "Matches command registration",
  );
});
test("requires each hunk decision and sends the exact accepted/rejected subset", async ({
  page,
}) => {
  await page.evaluate(
    (state) =>
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "state", state } }),
      ),
    {
      ...initial,
      busy: true,
      proposals: [
        {
          id: "p1",
          status: "pending",
          approvalPending: true,
          hunks: [
            { id: "a", path: "src/a.py", before: "old", after: "new" },
            { id: "b", path: "tests/a.py", before: "before", after: "after" },
          ],
        },
      ],
    },
  );
  const apply = page.getByRole("button", { name: "Apply reviewed changes" });
  await expect(apply).toBeDisabled();
  await page.getByRole("button", { name: "Accept hunk" }).first().click();
  await expect(apply).toBeDisabled();
  await page.getByRole("button", { name: "Reject hunk" }).nth(1).click();
  await expect(apply).toBeEnabled();
  await apply.click();
  expect(await page.evaluate(() => (window as any).__messages.at(-1))).toEqual({
    type: "review",
    proposalId: "p1",
    decisions: { a: "accept", b: "reject" },
  });
});
test("composition does not accidentally submit a task", async ({ page }) => {
  const input = page.getByLabel("What would you like to change?");
  await input.fill("edit");
  await input.dispatchEvent("compositionstart");
  await page.locator("form").dispatchEvent("submit");
  expect(
    await page.evaluate(
      () =>
        (window as any).__messages.filter((m: any) => m.type === "run").length,
    ),
  ).toBe(0);
  await input.dispatchEvent("compositionend");
  await page.locator("form").dispatchEvent("submit");
  expect(
    await page.evaluate(
      () =>
        (window as any).__messages.filter((m: any) => m.type === "run").length,
    ),
  ).toBe(1);
});
