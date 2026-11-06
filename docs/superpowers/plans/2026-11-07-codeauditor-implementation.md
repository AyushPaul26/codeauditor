# CodeAuditor Local Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** User approved implementation in chat. Development preview implemented; docs/implementation-progress.md records executed checks and remaining native/model acceptance gates. The checklist below must not be treated as all completed.

**Goal:** Build and package a Windows 11 VS Code coding-agent extension that meets every technical capability and submission requirement in the supplied Forge-a-thon PDF, using local TrueForge and local inference on an RTX 3050 4 GB/24 GB RAM laptop.

**Architecture:** A thin TypeScript extension creates TrueForge sessions/turns and renders its streamed events. TrueForge calls a local workspace MCP server for reads, searches, context selection, staged edits and controlled commands; approved changes are applied through VS Code. A CUDA-enabled llama.cpp process provides the model endpoint, with a second independently served small model for automatic fallback.

**Tech Stack:** TypeScript; VS Code extension APIs; official TrueForge TypeScript SDK; official MCP TypeScript SDK with Streamable HTTP on loopback; Node.js 22 LTS >=22.14; npm with committed lockfile; llama.cpp CUDA; Vitest; @vscode/test-electron; @vscode/vsce; Python 3.12 x64 and pinned uv for the Flask evaluation fixture.

**Spec:** [Proposed design and complete competition checklist](../specs/2026-11-07-codeauditor-design.md), based on the uploaded PDF. The thin-extension route is the proposed implementation; Antigravity executable analysis is not a dependency. Exact REA URL and reuse rights are unresolved and do not block this route.

## Global Constraints

- Target Windows 11, RTX 3050 with 4 GB VRAM and 24 GB system RAM; cloud Linux checks cannot certify Windows/CUDA behaviour.
- All model calls and the autonomous tool loop run inside TrueForge; never call a model provider directly from the extension or retain another project's loop.
- Use the current AyushPaul26/codeauditor checkout. Do not create a Git worktree just for this project; the current cloud task is already isolated.
- Local inference is the default. Support another model/provider configured in TrueForge without editing extension source, including the organiser's model.
- No unapproved changes to user source, no silent writes, no overwriting dirty buffers, and no cancellation-induced partial application.
- Required features: inline editing; autonomous changes across at least three discovered files; @file/@symbol and automatic retrieval; per-hunk review with undo; streaming and cancellation.
- Meet the exact Flask 3.1.3 fixture and tasks. Never hard-code its solution, file paths or tool decisions into the agent.
- Commit the tested agent definition, example model settings, lockfile, setup instructions and compatible open-source licence. Never commit credentials, model weights or local fixture data.
- Generated code and tested milestones will be committed and pushed to the current project repository after build approval, preserving any user changes and reporting the actual destination branch. If the checkout and remote remain genuinely unborn/empty, initialise the project on main; otherwise preserve existing branch history. Do not force-push.
- No accounts, hosted service, extra database server, model training, completion engine or Marketplace publishing in the submission-critical scope.
- Keep TrueForge, inference and MCP bound to loopback; use per-install MCP authentication and workspace trust. Local mode is not an internet-facing product.
- Dependencies, inference binary, model artifact and TrueForge version will be pinned after a working integration is verified. Preserve TLS/checksum verification.

## Review Focus

1. Dirty buffers and external file changes: stale proposal bases must cause a conflict, not overwrite newer work; Task 4 tests this.
2. Windows path edge cases: spaces, backslashes, case folding, CRLF and junction/symlink escapes; Tasks 3 and 4 test this.
3. Cancellation races: late stream events and child processes must not write after cancellation; Tasks 2, 6 and 8 test this.
4. Partial acceptance and model retry: rejected hunks stay rejected, applied operations are not duplicated, and undo preserves previous user edits; Tasks 4 and 8 test this.
5. Clean failure evidence: untracked caches, demo apps, secrets and fixture modifications must not contaminate Task C; Tasks 6, 8 and 9 test this.

## Proposed File Structure

```text
package.json, package-lock.json, tsconfig.json, .gitignore, LICENSE
src/extension.ts
src/contracts.ts
src/trueforge/{client,eventReducer,runController,failover}.ts
src/mcp/{server,workspaceTools,commandTool}.ts
src/workspace/{paths,snapshots}.ts
src/context/{mentions,index,retrieve,budget}.ts
src/edits/{overlay,proposals,reviewRegistry,apply,undo}.ts
src/ui/{agentPanel,inlineEdit,diffReview,contextView}.ts
media/{panel.ts,panel.css}
agents/codeauditor.json
config/{models.example.json,agent.example.json}
scripts/{doctor,setupLocal,startModel,startHarness,configureHarness,prepareFixture,package}.mjs
.vscode/{launch.json,tasks.json}
tests/unit/, tests/integration/, tests/extension/, tests/live/
docs/{windows-setup.md,testing.md,writeup.md,scorecard.md,benchmarks.md}
README.md, THIRD_PARTY_NOTICES.md
```

Do not split these into separate packages unless actual build constraints justify it. Names above identify responsibilities; source dependencies must remain small enough for a thin extension.

## Task 1: Prove Local TrueForge and Model Tool Use

**Files:** `package.json`, `package-lock.json`, `tsconfig.json`, `scripts/doctor.mjs`, `scripts/setupLocal.mjs`, `scripts/startModel.mjs`, `scripts/startHarness.mjs`, `scripts/configureHarness.mjs`, `agents/codeauditor.json`, `config/models.example.json`, `tests/integration/trueforge-contract.test.ts`.

**Interfaces:** `doctor(): Promise<DiagnosticReport>`; `TrueForgeConfig { baseUrl: string; agentId: string; fallbackAgentId?: string }`; diagnostics expose names/status, never secret values. Pin SDK versions and derive event payloads from installed SDK types rather than inventing fields. Runtime helper configuration is private local data, not credentials in the agent definition.

- [ ] Write a failing integration test for creating a session, streaming one turn, receiving a real read-tool result and reaching a terminal event; add provider-switch and cancellation contract assertions.
- [ ] Run `npm run test:integration -- trueforge-contract`; record the expected missing runtime/configuration failure explicitly as a prerequisite failure, not a product test pass.
- [ ] Install the selected toolchain, implement the minimal connection, register the local MCP endpoint and configure the model in TrueForge. Start Qwen3-1.7B Q4_K_M with thinking disabled, one inference slot and 4,096 total context tokens. Configure model-aware templates. Benchmark the 3B candidate only if needed and after checking its exact licence.
- [ ] Run the same test against actual TrueForge plus actual local inference, not just a mock endpoint. Verify tool arguments, tool-result continuation, streaming, cancellation and visibility of tool calls in the TrueForge session. Run Windows memory checks with `nvidia-smi` and record peak usage/latency. Failure to produce dependable tool calls blocks higher-layer implementation until corrected.
- [ ] Review and commit the working feasibility slice; push its verified commit after inspecting the configured remote and target branch.

**Exit:** An actual local model executes a real MCP tool through TrueForge. No editor UI polish is required yet. GPU fit and latency remain unverified until the Windows run passes.

## Task 2: Extension Lifecycle, Panel, Streaming and Cancel

**Files:** `src/extension.ts`, `src/contracts.ts`, `src/trueforge/{client,eventReducer,runController}.ts`, `src/ui/agentPanel.ts`, `media/{panel.ts,panel.css}`, `.vscode/{launch.json,tasks.json}`, `tests/unit/eventReducer.test.ts`, `tests/extension/panel.test.ts`.

**Interfaces:** `RunId = string`; `RunState = 'idle' | 'running' | 'awaiting-review' | 'cancelling' | 'cancelled' | 'done' | 'failed'`; `startRun(input: RunRequest): Promise<RunId>`; `cancelRun(runId: RunId): Promise<void>`; `RunRequest { instruction: string; selection?: SelectionRef; mentions: MentionRef[] }`. SDK wire events are translated in one adapter to a discriminated application event union; views never guess wire payloads.

- [ ] Add tests `mergesDeltasByMessageId`, `ignoresLateEventsForCancelledRun`, `doesNotMixSessions`, `cancelButtonRespondsWhileAwaitingModel`, and `rendersFailureWithoutStackTraceOrSecret`.
- [ ] Run `npm run test:unit -- eventReducer` and `npm run test:extension -- panel`; confirm assertions fail for missing behaviour.
- [ ] Implement the thin SDK adapter, event reducer, asynchronous panel and Cancel command. Call TrueForge cancellation; do not just close the UI stream. Distinguish model failure, tool failure and cancelled state.
- [ ] Rerun the tests; open F5 Extension Development Host and verify a genuine streamed reply. Target visible cancellation acknowledgement within 500 ms; treat underlying process termination as a separate assertion.
- [ ] Review, commit and push the verified milestone.

**Exit:** Sidebar and inline command registration work; the editor stays responsive during generation and errors. This does not yet claim safe editing.

## Task 3: Workspace MCP Reads, Paths and Context Retrieval

**Files:** `src/mcp/{server,workspaceTools}.ts`, `src/workspace/{paths,snapshots}.ts`, `src/context/{mentions,index,retrieve,budget}.ts`, `src/ui/contextView.ts`, `tests/unit/{paths,mentions,retrieve,budget}.test.ts`, `tests/integration/workspace-mcp.test.ts`.

**Interfaces:** `Snippet { uri: string; startLine: number; endLine: number; text: string; tokenEstimate: number; reason: string }`; `ContextRequest { instruction: string; mentions: MentionRef[]; inputBudget: number }`; `retrieveContext(request: ContextRequest): Promise<{ snippets: Snippet[]; usedTokens: number; omittedCount: number }>`; `readSnapshot(uri: string): Promise<DocumentSnapshot>`; `DocumentSnapshot { uri: string; version: string; text: string; eol: '\n' | '\r\n' }`. `MentionRef` and `SelectionRef` are defined once in `src/contracts.ts` with URI and optional symbol/range identifiers.

- [ ] Add tests for real @file and @symbol resolution, unsaved buffers, lexical/symbol retrieval, deduplication, generated/secret exclusions, strict input-budget enforcement, drive letters/Unicode/spaces/CRLF and path/junction escape rejection. A task describing CLI configuration must retrieve code/tests/docs using search, without task-specific path constants.
- [ ] Run `npm run test:unit -- paths mentions retrieve budget` and `npm run test:integration -- workspace-mcp`; confirm failing assertions.
- [ ] Implement incremental filename/symbol indexing and bounded workspace text search, starting with lexical ranking. Reserve output and schema/instruction space; do not use a misleading snippet-only context budget. Present token counts as estimates unless an exact matching tokenizer is available. Unknown symbol indexes fall back to text search.
- [ ] Register core MCP tools for selective preloading and keep occasional tools deferred. Verify discovery appears in TrueForge's session. Cap every tool response; do not depend on sandbox-only offloading when sandbox is disabled.
- [ ] Rerun tests and a live retrieval request. Verify filenames, line ranges and concise selection reasons are visible. Review, commit and push.

**Exit:** Both explicit mentions and automatic retrieval work within a documented budget, including a repository larger than that budget.

## Task 4: Staged Patches, Per-Hunk Review and Undo

**Files:** `src/edits/{overlay,proposals,reviewRegistry,apply,undo}.ts`, `src/ui/diffReview.ts`, `tests/unit/{proposals,reviewRegistry,apply}.test.ts`, `tests/extension/diffReview.test.ts`.

**Interfaces:** `stagePatch(runId: RunId, changes: ProposedChange[]): Promise<Proposal>`; `Proposal { id: string; runId: RunId; hunks: ProposedHunk[]; baseVersions: Record<string,string> }`; each immutable hunk has an ID, URI and before/after text. `recordReview(proposalId: string, decisions: Record<string,'accept'|'reject'>): ReviewReceipt`; `applyReviewedProposal(proposalId: string, receipt: ReviewReceipt): Promise<ApplyResult>`. The receipt is private bridge state bound to the proposal/run/document versions, never a model-supplied approval flag.

- [ ] Add tests `stagingNeverChangesWorkspace`, `appliesOnlyAcceptedHunks`, `rejectsStaleDocumentVersion`, `rejectsForgedOrReplayedReceipt`, `preservesPreexistingDirtyBuffer`, `preservesCRLF`, `cancelBeforeApplyWritesNothing`, and `undoRestoresAcceptedChangeWithoutRemovingEarlierUserEdit`.
- [ ] Run unit and extension diff-review tests and confirm expected failures.
- [ ] Implement in-memory/extension-storage proposals and read overlays. Render a native VS Code diff with explicit hunk controls. Gate `request_apply(proposalId)` by name in TrueForge. At the approval event, collect all per-hunk decisions and save the receipt; only then allow the tool. The tool applies exactly the accepted subset and returns accepted/rejected IDs. Never reinterpret an allow decision as permission to apply every hunk.
- [ ] Apply using VS Code workspace edits with tested undo grouping. Default to reviewed editor changes without hidden saves; the user explicitly saves before running commands on the working project. Recheck all base versions immediately before application; reject conflicts as a group rather than promising unsupported multi-file disk transactions.
- [ ] Rerun tests and manually demonstrate mixed accept/reject, undo, edit-conflict handling and cancellation. Review, commit and push.

**Exit:** Review is driven by TrueForge approval and cannot be bypassed by a model or late event. All proposed changes remain off the user's source until approval.

## Task 5: Complete Inline Editing and Fixed Task A

**Files:** `src/ui/inlineEdit.ts`, `tests/extension/inlineEdit.test.ts`, `tests/live/task-a.test.ts`, extension commands/keybindings in `package.json`.

**Interfaces:** `requestInlineEdit(selection: SelectionRef, instruction: string): Promise<RunId>` consumes Tasks 2–4; it creates a TrueForge turn with selection provenance and produces ordinary reviewed proposals, not a separate model path.

- [ ] Add tests for empty selection, cancelled input, region-relative edits, nonexistent symbols, outside-selection changes requiring visible review, and editor diff presentation rather than chat-only code.
- [ ] Run `npm run test:extension -- inlineEdit` and confirm failures.
- [ ] Implement the selection command, keybinding and plain-language input using the same run/proposal interfaces. Keep agent-discovered scope changes visible.
- [ ] Run `npm run test:live -- task-a` against a fresh pinned Flask fixture, then manually repeat the exact PDF prompt. Accept/save the diff and run the supplied behaviour check using PowerShell-equivalent environment syntax. Add assertions for unset/empty, `0`, `false`, `no`, `off`, `OFF`, `n`, `N`, mixed case, an ordinary truthy value and a docstring covering every false value and unset/empty behaviour.
- [ ] Review, commit and push after both deterministic UI tests and a genuine model run pass.

**Exit:** Task A works end to end with per-hunk controls and demonstrated undo.

## Task 6: Controlled Terminal Commands and Autonomous Task B

**Files:** `src/mcp/commandTool.ts`, `src/workspace/commandCopy.ts`, `tests/unit/commandPolicy.test.ts`, `tests/integration/commandTool.test.ts`, `tests/live/task-b.test.ts`, updated agent instructions.

**Interfaces:** `CommandRequest { runId: RunId; executable: string; args: string[]; timeoutMs: number }`; `runApprovedCommand(request: CommandRequest): Promise<CommandResult>`; `CommandResult { exitCode: number | null; stdout: string; stderr: string; generatedProposalId?: string; cancelled: boolean }`. Do not expose a default unrestricted shell string.

- [ ] Add tests for approval requirements, executable/argument policy, paths with spaces, bounded output, exit-code preservation, timeout, process-tree termination, source edits becoming proposals, and test/cache outputs not dirtying the real fixture.
- [ ] Run command unit/integration tests and confirm failures.
- [ ] Implement explicit approval, workspace trust and structured subprocess spawning. Run supported test commands against a managed temporary copy containing the proposed overlay, using the correct Python interpreter. An editable install can still import the original checkout: set per-process PYTHONPATH to the overlay's src and assert `flask.__file__` resolves inside the overlay before treating its tests as evidence. After acceptance/save, rerun with imports resolving to the approved original fixture. Collect source differences as proposals; filter generated caches/artifacts by explicit policy. Default autonomous scope is bounded project checks, not arbitrary shell execution. Temporary-copy execution isolates ordinary file outputs but is not an OS security sandbox; do not claim it safely executes hostile code or blocks arbitrary absolute-path writes. Unsupported/high-risk commands are denied or require separately designed isolation, not silently executed.
- [ ] Implement child-tree cancellation on Windows and POSIX for processes started by this tool, without killing unrelated user/model processes. Invalidate the run before awaiting process exit.
- [ ] Run the PDF's Task B verbatim with no file mentions. Verify autonomous discovery of at least three files, help registration, sensitive-key masking, a test and documentation. Run `pytest tests/test_cli.py -q` and the command against a demo app outside the fixture. Save genuine session/tool-call evidence; do not substitute scripted answers. Test default configuration values that are not natively JSON serializable (including timedelta); document the chosen serialization. Verify masking before serialization, substring/case behaviour, nonstring secret values and parseable JSON.
- [ ] Review, commit and push after real task behaviour and command-policy tests pass.

**Exit:** Multi-file changes and verification work through TrueForge tools, and supported commands cannot silently mutate the user's source through ordinary side effects.

## Task 7: Context Engineering and Model Portability Proof

**Files:** `agents/codeauditor.json`, `src/trueforge/client.ts`, `tests/integration/model-switch.test.ts`, `docs/benchmarks.md`.

**Interfaces:** Existing TrueForge configuration references resolve primary/fallback agent IDs. Provider identity is configuration, never a switch statement in extension model-calling code. Use Task 3's retrieval interface and SDK-generated agent types.

- [ ] Add tests for changing the configured TrueForge model without recompiling the extension, preserving staged-edit safety across models, and reporting incompatible endpoint/tool-call configuration clearly.
- [ ] Run model-switch tests and confirm missing behaviour fails.
- [ ] Verify selective preloading/deferred discovery genuinely reduces schema payload for an occasional tool; document the trade-off in extra model turns. If compaction is enabled, set its threshold below the configured input budget and verify essential state is preserved. Do not add subagents merely to claim a feature on a memory-constrained device.
- [ ] Repeat Task A with a second genuinely tool-capable model through TrueForge. Measure actual prompts/tool-call success and resource use. Validate at least one different provider configuration when credentials/capability are available; otherwise explicitly mark that external-provider check unrun.
- [ ] Review, commit and push the proven configuration and evidence, excluding secrets and sensitive logs.

**Exit:** Model switching requires configuration changes only and the harness feature is visible and explained.

## Task 8: Failure Recovery, Independent Fallback and Task C

**Files:** `src/trueforge/failover.ts`, `tests/unit/failover.test.ts`, `tests/integration/failure-matrix.test.ts`, `tests/live/task-c.test.ts`.

**Interfaces:** `recoverRun(failedRunId: RunId, error: RunFailure): Promise<RunId | null>`; `RunFailure { kind: 'connection'|'authentication'|'rate-limit'|'timeout'|'protocol'|'tool'|'unknown'; retryable: boolean; safeMessage: string }`. Recovery consumes a bounded task/context snapshot and starts a new TrueForge run; it never makes model calls or replays applied commands itself.

- [ ] Add tests for unreachable endpoint, invalid credentials, stalled stream, malformed tool arguments, truncated output, missing model, both endpoints failing, duplicate events, and cancellation during retry/fallback.
- [ ] Assert no workspace changes on disk or in unsaved editor buffers, no live primary run capable of applying late edits, no replay of approved mutations and no fallback automatically applying proposals. Test existing user modifications are preserved exactly. Do not rely on an invalid key to trigger failure if the chosen local server ignores authentication; an unreachable endpoint provides a reliable real failure case.
- [ ] Implement finite configurable timeouts, bounded backoff for transient failures, prompt fallback for nonrecoverable endpoint/auth errors, visible status and redacted failure messages. Do not blindly retry command/tool mutations.
- [ ] Configure the second model through an independent endpoint/process, using CPU execution when required to avoid GPU contention. After the primary is stopped/frozen, transfer only the approved task state and start the backup TrueForge session automatically.
- [ ] Run the failure matrix with controlled test endpoints, then genuine Task C from a clean Flask fixture and actual broken primary configuration. Verify `git status --porcelain=v1 --untracked-files=all` remains empty while fallback's proposed diff is unaccepted. Repeat with both models unavailable to confirm a clear terminal error.
- [ ] Review, commit and push.

**Exit:** Both graceful failure and automatic fallback are evidenced; cancellation does not hang behind a running bridge-owned command.

## Task 9: Reproducible Windows Setup, F5 and VSIX Installation

**Files:** `scripts/{prepareFixture,package}.mjs`, `docs/{windows-setup.md,testing.md}`, `README.md`, packaging scripts and `.vscode` configuration.

**Interfaces:** The following npm commands are planned deliverables, not commands that exist today: `doctor`, `setup:local`, `model:start`, `model:fallback`, `harness:start`, `harness:configure`, `fixtures:prepare`, `compile`, `watch`, `test:unit`, `test:integration`, `test:extension`, `test:live`, `package:vsix`.

- [ ] Test runtime directory resolution, safe repeat setup, preservation of user config, nonsecret example files, reserved-port collisions, missing executables and clear actionable diagnostics.
- [ ] Implement helpers using supported Windows paths under `%LOCALAPPDATA%\CodeAuditor`, separate from the project and Flask fixture: model/binary assets, configs, Python venv, logs and demo app. Verify hashes where published and record model provenance/licence. Never put secrets in command-line logs.
- [ ] `fixtures:prepare` clones Flask into managed fixture directories and verifies full HEAD `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. Never reset or delete an arbitrary user checkout. Refuse to overwrite modified managed fixtures; create a separately named clean instance instead. Create distinct A/B/C run fixtures so prior tasks cannot contaminate C.
- [ ] Prepare Python 3.12 x64 in a venv outside Flask using pinned uv. Flask 3.1.3 defines a tests dependency group, not a test extra: run `uv sync --locked --no-default-groups --group tests --python 3.12` from the managed Flask root with process-scoped UV_PROJECT_ENVIRONMENT pointing to the external venv. Use the checked-in uv.lock; do not invent `.[test]` or requirements/tests.txt. Record Python patch/uv versions and verify `flask.__file__` points to the selected fixture. Baseline `tests/test_cli.py` must pass before agent changes; Git status including untracked files must remain clean.
- [ ] Verify from a clean project clone: install dependencies with `npm ci`, build, start services, run F5 and repeat a real inline task. Then build `artifacts/codeauditor.vsix`, install it into a separate VS Code test profile and repeat without a development host. Test missing assets, locked files, reload, reconnect, shutdown and MCP-port release. Packaging excludes model files, credentials, fixtures and unnecessary dev artifacts.
- [ ] Review, commit and push the tested setup documentation and helpers. Windows execution status must be reported honestly if no Windows execution capability is available to the builder.

**Exit:** A user can reproduce installation, launch and testing with documented commands and no hidden developer-only files.

## Task 10: Full Regression, Evidence and Submission

**Files:** `tests/live/repeatability.test.ts`, `docs/{writeup.md,scorecard.md,benchmarks.md}`, `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`.

- [ ] Run type checking, unit tests, integration tests, VS Code tests and genuine fixed tasks, keeping passed/failed/skipped/unrun outcomes separate. Attempt at least three fresh A/B/C cycles with the selected model; report success rates and failures rather than hiding unsuccessful rehearsals.
- [ ] Record peak RAM/VRAM, first-token and task times, tool-call errors, test results, cancellation response and fallback time. If uninterrupted instruction-to-diff sequences do not fit the four-minute recording, optimise or seek organiser clarification; do not assume prohibited editing is allowed.
- [ ] Rehearse A, B and C in order, including proof of rejection, undo and cancellation, the TrueForge Task B session and clean-status failure evidence. Never fake a model run to make the video fit.
- [ ] Complete the one-to-three-page write-up with the exact eight headings from the spec, all nine scorecard rows and accurate final video timestamps. Declare models/costs, tools used, starting point and known limitations.
- [ ] Review licence/attribution, secret scanning, clean-clone setup and packaged extension. Conduct a separate review of proposal application, command execution and cancellation before calling the build complete.
- [ ] Commit and push the final source and evidence documentation. The user supplies team details and publishes/submits public video/PDF/repository links through the portal; no external publication is implied by local tests.

**Exit:** All required behaviours have evidence, public deliverables are prepared, and remaining limitations are explicit. Do not promise selection or a score.

## Windows User Runbook After the Build

These are the commands and files the implementation must deliver. They are not available in the empty repository yet.

1. Install VS Code, Git, Node 22 LTS >=22.14, Python 3.12 x64 and a suitable NVIDIA driver. The setup helper verifies/installs the pinned uv used for fixture dependencies. A full CUDA development toolkit should not be required when a verified compatible prebuilt llama.cpp CUDA binary is used. If PowerShell blocks npm.ps1/npx.ps1 shims, invoke npm.cmd/npx.cmd rather than changing the machine's execution policy.
2. Clone the project and inspect versions in PowerShell:

```powershell
git clone https://github.com/AyushPaul26/codeauditor.git
cd codeauditor
node --version
npm --version
git --version
py -3.12 --version
nvidia-smi
npm ci
npm run doctor
npm run setup:local
npm run compile
```

3. Use separate terminals for foreground processes; helpers must print readiness and actionable errors:

```powershell
# Terminal 1: primary local model
npm run model:start
# Terminal 2: independent fallback model, when testing fallback
npm run model:fallback
# Terminal 3: pinned TrueForge local runtime
npm run harness:start
# Once the required services are ready, another terminal:
npm run harness:configure
npm run fixtures:prepare
```

The MCP bridge starts with the extension. Harness connector configuration is registered ahead of time, but a full tool-call readiness check runs after F5 activates that bridge. The setup helper reports which steps require running services and supports being rerun safely. For the initial organiser-required manual quickstart, use `npx @truefoundry/trueforge@latest` separately; do not start it on an occupied port alongside the pinned runtime.

4. Open the project in VS Code and press **F5**. The Extension Development Host opens. In that window, open the managed Flask fixture and CodeAuditor's panel. A readiness check must prove a real MCP read, not only an open port.
5. Run automated checks in their documented environments:

```powershell
npm run test:unit
npm run test:integration
npm run test:extension
npm run test:live
```

Mock tests validate failure paths deterministically. Live tests require actual TrueForge/inference services and are reported separately. Extension tests launch an isolated VS Code instance, with startup instructions that account for the running MCP bridge/port.

6. For the manual Task A verification, use the fixture's external venv interpreter. The helper will print its absolute path. Equivalent PowerShell form:

```powershell
$env:FLASK_DEBUG = 'off'
& 'C:\path\to\external-venv\Scripts\python.exe' -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
Remove-Item Env:FLASK_DEBUG
```

Expected: `False`. If FLASK_DEBUG already existed, preserve and restore it rather than deleting the user's value. For Task B use that same interpreter with `-m pytest tests/test_cli.py -q` and `-m flask`; do not accidentally invoke a globally installed Flask.

7. Package and install the standalone extension:

```powershell
npm run package:vsix
code --install-extension .\artifacts\codeauditor.vsix
```

Alternatively use VS Code's **Extensions: Install from VSIX** command. Reload/open VS Code and repeat a real task with the packaged extension. TrueForge and inference still need to be running locally; installing the VSIX does not keep those processes alive automatically.

## Validation Ownership and Approval Boundary

**Builder/cloud:** source, deterministic unit/integration tests, SDK/MCP contract checks, compatible Linux extension-host tests where display tooling permits, packaging, documentation and Git commits/pushes. No claims about the user's GPU from these results.

**Windows laptop:** CUDA/model fit, actual latency, Windows process-tree cancellation, F5/native editor interactions, VSIX installation, genuine local-model A/B/C runs and recording. If remote execution on that laptop is unavailable, the user runs the supplied commands and returns diagnostics with secrets redacted; the builder investigates failures and updates the code.

**Approval requested:** approve this scope and thin-extension architecture before implementation. Recommendation: implement the coupled core sequentially, with independent review of the safety-critical edits/commands/recovery boundaries. Use parallel agents for separable tests/documentation/review, not simultaneous conflicting edits. No separate approval is needed for each already-approved milestone; pause for a material scope change or genuine missing access.

**Deferred:** Antigravity/REA analysis and extra commercial auditing features. After all competition requirements pass, propose a separate small plan for evidence-backed auditing and change-impact previews.
