# Testing and evidence

Use Node 22.14 or newer, install with `npm ci`, and compile before VS Code tests. The deterministic suite and real inference suite answer different questions. A skipped live test means no evidence of live behavior; an enabled live test with missing services is a prerequisite failure.

```powershell
npm.cmd run typecheck
npm.cmd run test:unit
npm.cmd run test:integration
npm.cmd run test:extension
npm.cmd run package:vsix
```

Unit checks cover context/path constraints, staged review and setup helpers. Integration checks use controlled endpoints or subprocesses to exercise actual MCP/SDK transport, command policy, cancellation and recoverable failures. Read each test's dependency requirements. Mocked OpenAI/SDK output cannot establish that the chosen GGUF produces dependable tool calls.

The setup unit suite was observed failing before implementation, then passing **13 tests** on Linux/Node 24.22.1. It covers private directory resolution, repeated setup preserving configuration/authentication, invalid JSON preservation, asset SHA-256 verification, port collisions, native Node SDK imports, model flags, approval/compaction configuration, fixture isolation and refusal to overwrite unmanaged directories. This does not certify Windows filesystem or GPU behavior.

Actual Linux setup also installed and ran the private uv 0.9.28 binary, cloned the exact Flask fixture with Python 3.12.14, synced the locked tests group into an external venv, verified the fixture import and passed all **58 baseline CLI tests**. Repeating setup/fixture preparation preserved clean source. A deliberately added setup-owned untracked probe made fixture reuse fail while preserving the probe; removing only that probe restored a clean status. This verifies fixture preparation, not either task's requested modification.

## Real tool-use gate

Start the real primary model and pinned TrueForge; run `harness:configure`. Activate the extension in a trusted fixture so its MCP server is available. Then enable the live suite explicitly:

```powershell
$env:CODEAUDITOR_LIVE = '1'
$env:TRUEFORGE_BASE_URL = 'http://127.0.0.1:8790'
$env:TRUEFORGE_AGENT_ID = 'codeauditor-primary'
npm.cmd run test:live
```

Preserve and restore any preexisting environment values after the check. `TRUEFORGE_AGENT_ID` is a registry name. No external-model key is required for the default local configuration. Live checks must observe a genuine workspace read, the resulting tool content, streamed assistant content, a terminal turn and the associated TrueForge session. Also verify cancellation reaches TrueForge rather than merely hiding UI output.

In the initial cloud build there is no verified llama.cpp/GGUF asset, GPU runtime or Windows desktop run. The real TrueForge settings registration can be checked without inference; it does not satisfy this gate. Record enabled-live prerequisite failures honestly and rerun after services are available.

## Fixed tasks on Flask 3.1.3

Prepare fixtures with `npm run fixtures:prepare`. Record full HEAD, Python patch version, uv version and clean status before each task. Use the PDF prompts verbatim during evaluation. Do not prepatch solutions or give Task B filenames. Create fresh named A/B/C fixtures for each of three rehearsal cycles.

**A — inline edit.** Select `get_debug_flag` in `src/flask/helpers.py` and request the specified case-insensitive `off`/`n` false handling plus complete documentation. Verify actual function behavior for unset, empty, `0`, `false`, `no`, `off`, `OFF`, `n`, `N`, mixed-case false strings and an ordinary truthy value. Check the docstring covers every false value and unset/empty behavior. Show the editor diff and accepted change.

PowerShell equivalent of the required `FLASK_DEBUG=off` command, preserving the user's earlier value:

```powershell
$hadDebug = Test-Path Env:FLASK_DEBUG
$oldDebug = $env:FLASK_DEBUG
try {
  $env:FLASK_DEBUG = 'off'
  & "$env:LOCALAPPDATA\CodeAuditor\venvs\flask-a\Scripts\python.exe" -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
} finally {
  if ($hadDebug) { $env:FLASK_DEBUG = $oldDebug }
  else { Remove-Item Env:FLASK_DEBUG -ErrorAction SilentlyContinue }
}
```

Run from the corresponding fixture root and substitute its printed interpreter path when using an override or another run name. The required result after the accepted/saved edit is `False`.

**B — autonomous multi-file task.** Request the PDF's `flask config` feature without filenames or mentions. Record how search/retrieval finds implementation, tests and documentation, with selected files/reasons and estimated budget visible. Require changes in at least three discovered files. Review hunks, save accepted changes, run `tests/test_cli.py -q` and show the new command in `flask --help`. Use the external standalone demo app to demonstrate parseable JSON and `***` masking for keys containing SECRET/PASSWORD/TOKEN/KEY. Verify substring/case behavior, nonstring secret values and masking **before** conversion/serialization. Test real Flask defaults such as `timedelta`; document the chosen representation of values that JSON cannot encode natively. Show the TrueForge session and actual tool calls. A test stub or an easy string-only app is insufficient evidence.

**C — resilience and clean failure.** Start from a separate clean pinned fixture. Break the primary endpoint reliably by stopping its process or configuring an unreachable port; local servers may ignore invalid API keys. Repeat A, show the failure/fallback status and keep any fallback diff unaccepted. Record `git status --porcelain=v1 --untracked-files=all` before and after; both must be empty. Separately make both endpoints unavailable, and cancel while recovery is pending. Verify clear terminal failure, responsive editor, no late application, no duplicate approved command and preservation of existing user edits.

Also demonstrate mixed accept/reject, undo after an applied hunk, an edit conflict, cancellation during generation and cancellation during an approved command. On Windows confirm the complete command process tree exits and the MCP port is released on extension shutdown.

When manually running pytest outside the helper, disable source-tree caches for clean evidence. Use `PYTHONDONTWRITEBYTECODE=1` and `PYTEST_ADDOPTS=-p no:cacheprovider` as process-scoped environment values, preserving/restoring earlier values. Do not delete unexplained files to make status look clean; create a fresh fixture instead.

## Submission evidence

For each of three fresh A/B/C cycles record success/failure, tool-call validity, test outcomes, first-token time, end-to-end task time, cancellation acknowledgement, fallback time and peak RAM/VRAM. Keep failures in the denominator. Capture the exact selected release/model hashes privately and publish only nonsecret provenance. Use [benchmarks.md](benchmarks.md) and [scorecard.md](scorecard.md).

The video must show A, B and C in order, actual verification and the TrueForge Task B session. Rehearse an uninterrupted sequence within the organiser's time limit; do not fake model output, hide failed rehearsals or assume editing is permitted. Replace pending timestamps only after watching the final recording. The user supplies team affiliations/handles and publishes the final video/PDF/repository links.
