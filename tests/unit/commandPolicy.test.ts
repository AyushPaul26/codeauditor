import { describe, expect, it } from "vitest";
import { validateCommand } from "../../src/mcp/commandRunner";

describe("controlled command policy", () => {
  it.each([
    ["python", ["-m", "pytest", "tests/test_cli.py", "-q"], "pytest"],
    ["pytest", ["tests/a file.py::test_case", "-q"], "pytest"],
    ["python3.12", ["-m", "py_compile", "src/app.py"], "py_compile"],
    ["python", ["-m", "compileall", "-q", "src"], "compileall"],
    ["flask", ["--app", "demo", "config"], "flask"],
    ["python", ["-m", "flask", "--help"], "flask"],
  ])("allows a structured project check %s %j", (executable, args, module) => {
    expect(validateCommand({ executable, args, runId: "check" }).module).toBe(
      module,
    );
  });

  it.each([
    ["bash", ["-c", "echo hello"]],
    ["python -m pytest", []],
    ["python", ["-c", "print(123)"]],
    ["python", ["app.py"]],
    ["pytest", ["tests/test_app.py;touch /tmp/file"]],
    ["pytest", ["../outside.py"]],
    ["pytest", ["--rootdir=/tmp"]],
    ["pytest", ["-o", "addopts=anything"]],
    ["flask", ["run"]],
    ["flask", ["shell"]],
    ["flask", ["--app", "../external.py", "config"]],
    ["flask", ["--app", "C:\\external\\app.py", "config"]],
    ["python", ["-m", "compileall", "/tmp"]],
    ["python", ["-m", "py_compile", "-"]],
  ])(
    "rejects unsupported command %s %j with supported alternatives",
    (executable, args) => {
      expect(() =>
        validateCommand({ executable, args, runId: "check" }),
      ).toThrow(/supported|relative/i);
    },
  );

  it("does not accept malformed wire requests", () => {
    expect(() =>
      validateCommand({
        executable: "pytest",
        args: null,
        runId: "check",
      } as unknown as Parameters<typeof validateCommand>[0]),
    ).toThrow(/supported/i);
  });
});
