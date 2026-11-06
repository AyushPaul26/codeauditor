import { describe, it, expect } from "vitest";
import { validatePublicFixtures } from "../../src/workspace/publicFixtures";
const value = () => ({
  version: 1,
  commit: "pinned",
  source: { repository: "https://github.com/pallets/flask.git", ref: "3.1.3" },
  files: [{ path: "tests/apps/.env", text: "FOO=public-test-value\n" }],
});
describe("public test data provenance", () => {
  it("accepts pinned public test data and returns independent copies", () => {
    const input = value(),
      result = validatePublicFixtures(input, "pinned");
    result[0].text = "changed";
    expect(input.files[0].text).toBe("FOO=public-test-value\n");
  });
  it.each([
    ".env",
    "src/.env",
    "tests/../.env",
    "tests/.env/other",
    "/tests/.env",
    "tests\\apps\\.env",
  ])("rejects a nonfixture or escaping path %s", (path) => {
    const input = value();
    input.files[0].path = path;
    expect(() => validatePublicFixtures(input, "pinned")).toThrow(/path/i);
  });
  it("rejects wrong commits, origins and duplicate paths", () => {
    const input = value();
    expect(() => validatePublicFixtures(input, "other")).toThrow(/provenance/i);
    input.source.repository = "https://private.invalid/repo";
    expect(() => validatePublicFixtures(input, "pinned")).toThrow(
      /provenance/i,
    );
    const duplicate = value();
    duplicate.files.push({ ...duplicate.files[0] });
    expect(() => validatePublicFixtures(duplicate, "pinned")).toThrow(/path/i);
  });
});
