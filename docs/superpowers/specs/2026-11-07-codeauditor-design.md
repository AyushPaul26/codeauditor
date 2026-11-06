# CodeAuditor: proposed implementation roadmap

Planning assessment based on the supplied Techfest 2026–27 TrueFoundry Forge-a-thon PDF. This is a proposal, not a claim that the application has been built or benchmarked. The PDF is the source for competition requirements; linked upstream documentation supplies integration evidence. Reconfirm organiser updates through the competition portal.

## Goal and constraints

Build a Windows 11 VS Code coding agent that runs its agent loop in TrueForge local mode and uses local inference on an RTX 3050 with 4 GB VRAM and 24 GB system RAM. Keep the name CodeAuditor, but implement the full coding-agent workflow: discover code, plan, propose multi-file changes, review, apply, test and undo. A scanner-only product would miss the brief.

Use the existing AyushPaul26/codeauditor repository for generated project code and subsequent authorised pushes. It was empty during onboarding. No existing implementation is assumed. No production source code is created by this planning document.

The model must remain replaceable in TrueForge. Local inference is the default, but an organiser-selected provider must work without extension changes. Neither flawless model output nor selection can be guaranteed. Reliability must come from retrieval, small tool contracts, patch validation, explicit approval, tests and visible limitations.

## Starting-point alternatives

1. **Recommended: thin extension using official VS Code APIs and appropriately licensed libraries.** Build only the editor integration, workspace MCP tools, retrieval and staged-edit experience; delegate the loop to TrueForge. This minimises the amount of inherited architecture that must be removed.
2. **Declared open-source editor fork.** Evaluate Cline, Continue, Roo Code or opencode for reusable editor UI. Inspect the selected repository's actual licence and exact commit. Remove its agent loop and provider calls completely. Record fork URL, starting SHA, retained attribution and the team's delta.
3. **Antigravity executable reverse engineering.** Not the recommended competition path. An executable does not establish source availability or reuse rights. The exact REA repository, its licence, the executable's applicable terms and permitted scope must be reviewed before deciding whether analysis is useful. Do not make the submission dependent on undocumented executable internals or extracted proprietary code.

The PDF expressly encourages licensed editor-side reuse. It makes retaining an upstream agent loop or violating a licence an eligibility failure.

## Local model strategy

Initial candidate: **Qwen3-1.7B, GGUF Q4_K_M, thinking disabled**, served by a CUDA-enabled llama.cpp server on Windows. The official Qwen3 repository states Apache 2.0 and describes tool use. An existing inference runtime is sufficient; training and building model-serving infrastructure are not useful competition work.

Benchmark **Qwen2.5-Coder-3B-Instruct Q4_K_M** as a coding challenger. Do not assume it has the same licence as other Qwen sizes: verify the exact artifact's model-specific terms before distribution or commercial use. Its model card was not accessible in this research environment.

Planning weight estimates are approximately 1.0–1.3 GB for the 1.7B candidate and 1.8–2.1 GB for the 3B candidate. These are not total VRAM requirements or measured download sizes. CUDA, display use, KV cache and compute buffers consume additional memory.

- Begin with 4,096 total context tokens, one inference slot and one active generation. Reserve about 1,000–1,500 tokens for output; divide the remaining budget among instructions, short tool schemas, request, retrieved snippets and history.
- Increase to 8K only after measuring memory, latency and task success. An advertised 32K or larger model window does not imply that window is practical on 4 GB VRAM.
- Use CPU/GPU layer offload if necessary. The 24 GB RAM helps, but CPU speed is still unknown and offload may increase latency.
- Keep retrieval on CPU. Start without a separate embedding model, vector database or concurrent LLM subagents.
- Verify streamed OpenAI-style tool calls, argument parsing and tool-result continuation through TrueForge. A server exposing `/v1` does not establish dependable agent behaviour.
- Use a model-appropriate chat template and supported nonthinking settings; do not assume one template works for every model.
- For maximum resilience scoring, configure a second distinct model through TrueForge, served by an independent CPU endpoint if necessary. Two endpoints in the same failed process do not provide meaningful process-failure recovery.

No GPU benchmarking has been performed on the user's laptop. Select the production default from repeated pinned-task results, not parameter count alone.

## Proposed architecture

VS Code extension -> TrueForge TypeScript SDK/HTTP API -> TrueForge sessions and agent loop -> configured model endpoint.

TrueForge -> local workspace MCP server -> read/search/context/proposal/terminal capabilities.

TrueForge streamed events -> extension chat, tool activity, context explanations and approval interface.

The extension never calls a model provider directly. Retry/fallback orchestration may start a backup TrueForge session after the primary run is terminal; it must not implement a replacement model/tool loop. Pin a tested TrueForge version for the reproducible submission, while documenting the organiser's `npx @truefoundry/trueforge@latest` quickstart.

Expose a small MCP surface: read file ranges, search workspace, resolve symbols, retrieve task context, stage patches, request application of reviewed hunks, and run controlled commands. Read/search must include unsaved editor content and staged changes where relevant. Keep tool results bounded and include file/line provenance.

Use explicit TrueForge approval rules for mutation tools rather than trusting tool annotation defaults. Stage a proposal without changing the user's source files, then require a harness-driven approval before application. Bind decisions to immutable hunk IDs and document versions. Do not let changing proposal text reuse an old approval.

For meaningful harness context engineering, initially use **selective tool preloading and deferred loading**: preload core read/search tools and defer occasional specialised tools. Show this discovery in the session and explain the context saving. Benchmark the extra model round trips; keep the small model's task simple. Enable and tune compaction if needed. Do not rely on skills or large-result sandbox offloading without checking their sandbox prerequisites.

## Mandatory feature and score coverage

| Criterion                     | Points | Implementation and required evidence                                                                                                                                  |
| ----------------------------- | -----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 Inline editing             |     10 | Select code, keybinding, natural-language instruction, editor-rendered diff, per-hunk accept and reject; no copy/paste workflow.                                      |
| A2 Agent mode                 |     10 | One request drives TrueForge read/search/write-proposal/terminal tools; discovers and changes at least three files without the user naming them.                      |
| A3 Streaming and cancellation |     10 | Render TrueForge deltas without blocking the extension host; immediate UI cancellation, cancellation propagation and a consistent workspace.                          |
| B1 Context assembly           |     15 | `@file`, `@symbol`, automatic retrieval, explicit token budget, documented strategy and visible selected files with reasons during Task B.                            |
| B2 Diff safety                |     10 | Visible hunk review before mutation, reject controls and demonstrated undo of an applied change.                                                                      |
| B3 Resilience                 |     10 | Automatic fallback to a second configured model without user action; the workspace remains unchanged. Retry/backoff plus clear error is the lower seven-point anchor. |
| B4 TrueForge depth            |     10 | Sessions/turns/events plus MCP editor tools, harness-driven approvals and a meaningful context-engineering feature or skill visible in the session.                   |
| C1 Video                      |     10 | A, B and C in order, outcomes legible, verification shown, TrueForge Task B session shown.                                                                            |
| C2 Write-up                   |     15 | Architecture decisions, context/model trade-offs, accurate timestamp scorecard and honest limitations.                                                                |

Total: 100. This targets the published anchors; it is not a promised score. Capability omissions can reduce points, while eligibility failures can invalidate a submission regardless of points.

## Retrieval approach

1. Index workspace filenames and symbols incrementally, respecting ignore rules and excluding secrets, binary files, dependencies and generated output.
2. Resolve explicit file/symbol mentions through VS Code APIs and language services where available.
3. Search names and code text using VS Code workspace search or ripgrep; use lightweight lexical ranking such as BM25.
4. Expand top matches to the relevant function/class, immediate callers, adjacent tests and documentation. Bound every expansion.
5. Deduplicate and select snippets within the actual model token budget, reserving space for tool calls and output. Truncate at structural boundaries and visibly report omitted material.
6. Display filenames, line ranges, token estimates and concise selection reasons. Do not present a retrieval heuristic as proof that the code is correct.
7. Let the TrueForge agent choose further search/read calls. Do not hard-code Flask paths or prerecorded tool decisions.

Embeddings and semantic reranking are later options only if baseline retrieval demonstrably misses relevant code.

## Safe editing and cancellation

Maintain proposed content in an overlay. Group hunks by task and file, with base document hashes/versions. Validate paths stay inside the workspace, including symlink resolution; reject stale edits and require rebase/review if the user edits a file meanwhile.

On approval, apply the accepted hunks through VS Code workspace edits with appropriate undo grouping. Rejected hunks must remain rejected when the agent continues. Cancellation discards unapproved proposals and cannot revert already accepted edits without the user asking. Preserve all pre-existing work.

Terminal commands are also a mutation path. Approval alone must not permit an unreviewed formatter, shell script or test to edit source. Run modification-capable operations against a controlled temporary copy and capture source differences as proposals, or implement a validated restricted execution policy. A temporary copy is not a security sandbox; untrusted commands need actual isolation or tightly restricted execution. Do not claim arbitrary shell isolation merely because the working directory changed.

Cancel both the TrueForge run and any bridge-owned command process tree. Invalidate the run ID so late tool responses cannot apply changes. TrueForge's documented cancellation waits for running MCP calls, so a responsive Cancel button alone does not prove commands stopped. Test cancellation during model generation, tool execution and review.

Fallback uses bounded retries for appropriate transient failures and switches promptly on nonrecoverable authentication/configuration errors. Freeze primary proposals and ensure the primary run cannot commit before starting fallback. Never blindly replay mutation commands. Fallback may produce a new proposed diff, but Task C must not auto-apply it.

## Proposed repository files

These are files to create after the approach is agreed, not files the user must write first. The exact layout can remain simple and avoid premature monorepo tooling.

```text
codeauditor/
  package.json                    extension manifest, scripts, commands, keybindings
  package-lock.json               reproducible dependency resolution
  tsconfig.json
  src/extension.ts                activation and lifecycle
  src/trueforge/client.ts          sessions, streaming, approvals, cancel, failover
  src/mcp/server.ts               local workspace MCP transport
  src/mcp/tools/                  reads, search, proposals, controlled commands
  src/context/                    symbols, ranking, budgets, provenance
  src/edits/                      overlay, hunks, version checks, application, undo
  src/ui/                         chat panel, context display, review controls
  agents/codeauditor.json          actual tested TrueForge agent definition
  config/models.example.json      nonsecret model setup example
  scripts/                        Windows setup/start/check helpers
  tests/unit/                     retrieval and patch-state tests
  tests/integration/              MCP and TrueForge contract tests
  tests/e2e/                      VS Code and fixed-task regression tests
  docs/writeup.md                 exact eight required headings
  docs/scorecard.md               evidence and video timestamps
  README.md
  LICENSE
  THIRD_PARTY_NOTICES.md           if third-party code requires attribution
  .gitignore
```

Examples and agent-definition schemas must be validated against the pinned TrueForge version; filenames above do not imply an invented supported import format.

Inputs needed: supplied PDF (already available), Windows version (Windows 11 confirmed), current public project repository (already known), CPU and NVIDIA driver details for performance tuning, exact REA URL if that optional analysis remains desired, and any real licensed starting code/designs that already exist. Never request API keys in chat or commit them. For final submission, collect team details and public artifact links.

## Implementation sequence

1. **Feasibility and eligibility spike:** on Windows, start TrueForge local mode and the local inference server; register the model and a minimal workspace MCP server; create a session, stream a turn, execute a real read tool and cancel it. Measure memory and tool-call success. Resolve this before building a polished interface.
2. **Small vertical slice:** implement Task A end to end: selection/keybinding, TrueForge turn, proposal, per-hunk review, application, rejection and undo. Add stale-edit and dirty-buffer checks immediately.
3. **Repository intelligence:** implement mentions, lexical/symbol retrieval, token budgeting, visible provenance and context explanations. Add selective tool loading and show it in a real session.
4. **Autonomous multi-file work:** make Task B pass with only the supplied request. Discover code/tests/docs dynamically. Test proposals on the temporary copy, show results, and rerun required checks after acceptance.
5. **Failure hardening:** add finite timeouts, retry/backoff, independent backup configuration, no-write failure behaviour, cancel-race tests and command-process termination. Exercise both endpoints failing too.
6. **Submission rehearsal:** run all fixed tasks repeatedly on the exact fixture, verify switching models, package the extension and reproduce setup from a clean project clone. Record evidence and complete the eight-heading write-up.
7. **Only after coverage is stable:** add one or two differentiators with measurable value. Do not sacrifice a scored requirement for a broad feature list.

As of 7 November 2026, the PDF gives a Round 1 deadline of 20 November at 23:59 IST. Treat this as roughly a two-week build-and-validation window, with submission buffer; effort estimates depend on team availability. Prefer a reliable thin implementation over a full editor fork under that schedule.

## Fixed-task acceptance tests

Fixture: pallets/flask, tag `3.1.3`, commit `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. The tag's peeled commit was verified against GitHub. Use the PDF's instructions verbatim during recording.

- **A:** open `src/flask/helpers.py`, select `get_debug_flag`; request case-insensitive `off` and `n` as false and documentation of every false value; review and accept. Show the PDF's `FLASK_DEBUG=off` Python command printing `False`. On Windows PowerShell, set the equivalent process environment variable, run Python, then remove/restore that variable; explain the equivalent syntax.
- **B:** without filenames or mentions, request `flask config` outputting the loaded application's configuration as JSON, masking values for keys containing SECRET, PASSWORD, TOKEN or KEY with `***`. It must appear in `flask --help`, have a test and documentation alongside built-in commands, and change at least three files. Show hunk approval, passing `pytest tests/test_cli.py -q`, the new command's masked JSON and the TrueForge session/tool calls. Check non-JSON-native configuration values and masking edge cases rather than relying on one easy sample.
- **C:** return to a clean pinned fixture, configure an unreachable endpoint or invalid key and repeat A. Show a responsive editor, a clear failure or automatic fallback, and unchanged `git status`. With fallback enabled, leave its diff unaccepted. Do not let A/B changes or an already-modified function invalidate this check.
- Additionally demonstrate a rejected hunk, successful undo and cancellation with no half-applied changes. These behaviours need their own visible evidence.

Use deterministic tools/tests for safety and regression checks; also perform genuine live model runs. Do not replace the agent with task-specific scripts or claim a fake provider proves model reasoning. Record repeated-run completion, tool-call validity, peak VRAM/RAM, first-token time, total task time and failure causes.

## Business differentiators after the required core

1. **Evidence-backed audit and repair:** use established local analyzers appropriate to the language, then let the agent trace findings to source and propose minimal patches with relevant regression tests. Show scanner evidence and validation status; avoid presenting a small model's speculation as a confirmed vulnerability.
2. **Change-impact preview:** connect a patch to affected symbols, callers and tests, clearly marking incomplete dependency coverage. Helps reviewers judge the cost and risk of accepting it.
3. **Local privacy controls:** offline mode, explicit outbound connection visibility, secret exclusions and clear data retention controls. Validate any claim that code stays local against all extension/tool network paths.
4. **Reviewable repair history:** local export of requested change, retrieved context provenance, accepted/rejected hunks, model identity, test results and undo history, with sensitive data redaction.
5. **Measurement:** report actual model latency, resource use, test outcomes and review time; measure time saved in user trials rather than inventing ROI or confidence percentages.

Prioritise the first two if time remains. Accounts, billing, cloud dashboards and team services are later commercial work, outside this Round 1 scope.

## Submission and other PDF requirements

Hard gates: TrueForge loop; MCP editor capabilities; local-mode harness; no direct provider calls; no retained upstream loop; model portability; actual agent definition in repository; compatible open-source licensing and attribution; declared model/setup/costs; no committed secrets; public artifact links by the deadline.

Submit three public links through the competition portal:

1. **Video, at most four minutes:** editor visible; A, B, C in order; verification after each; show Task B's TrueForge session. The PDF permits removing waiting time but also says not to cut between instruction and diff. Safest interpretation is to keep each instruction-to-diff sequence continuous; ask the portal Doubt section if timing makes this unclear.
2. **PDF, one to three pages, eight headings in exactly this order:** Team; Starting point; Architecture on TrueForge; How context is selected; Model setup; Scorecard; Tools used; Known limitations and what you would do with another month. Include team affiliations/handles, exact fork point or from scratch, MCP/harness choices, retrieval budget, models/location/cost/switching, all nine criterion rows with accurate video timestamps, AI tools used, and honest limitations.
3. **Public GitHub repository:** reproducible clean-clone setup, local TrueForge startup and agent-definition loading, example model configuration, licence and fork attribution where applicable, no secrets.

Before writing extension code, the PDF asks participants to read the TrueForge README, star the repository and run its local quickstart on their laptop. Starring is a participant account action, not something performed by this planning assessment.

Not scored: tab completion/FIM, model training/fine-tuning or custom hosting infrastructure, additional hosted backend/database/service, accounts/authentication and Marketplace publication. TrueForge sandbox use is optional. A supported existing local model runtime is expressly allowed.

Eligibility and logistics: register at techfest.org and retain the Team ID; participants must be 18+ at registration with photo ID; at most five members, mixed affiliations allowed; only one registration/team per participant. Do not use employer/private code or another team's submission. Declare reused code and AI assistants. Public submissions need a compatible open-source licence and grant the organisers the usage rights stated in the PDF.

Dates in the supplied PDF: registration closes 15 November 2026; submission 20 November, 23:59 IST; results 30 November; finals 16–18 December at IIT Bombay. Before the shortlist is final, prepare for a ten-minute code walkthrough and live A with an organiser-selected model. Top 15 advance; ties break on technical depth, then capability coverage, then earlier submission. Round 2 adds unseen work and a reviewed TrueForge pull request; finalists receive model credits. Shortlisted on-campus participants receive participation certificates. Winners' prize form is due 31 December; prize processing and PPI consideration are separate from technical requirements.

The social-media award is optional and independent of technical scoring. If participating, follow the PDF's publication window (15 October–18 December), one post per LinkedIn/X/YouTube platform, demo content, required `#TrueForge`, `#Forgeathon` and team hashtag, and submit links through the organiser's form. No artificial engagement. Questions about competition rules belong in the portal Doubt section; TrueForge usage questions go to its community Discord.

## Sources and verification limits

- Supplied `codeauditor.pdf`: competition features, scoring and submission rules.
- [TrueForge README](https://github.com/truefoundry/trueforge), inspected at `c29131547d50e344adaeaf115bcacd32838d5a8e`: local mode, SDK/API, MCP, supported context features; Node.js requirement shown as >=22.14.
- [TrueForge SDK guide](https://trueforge.dev/api/use-agent): streamed events, approvals and session cancellation.
- [TrueForge model setup](https://trueforge.dev/models): custom OpenAI-compatible providers.
- [Deferred tool loading](https://trueforge.dev/key-features/deferred-tool-loading): selective preloading and discovery.
- [Official Qwen3 repository](https://github.com/QwenLM/Qwen3): model family, thinking controls and Apache 2.0 statement.
- [Official Qwen2.5-Coder README](https://github.com/QwenLM/Qwen2.5-Coder/blob/d5ead97fea36bca3744e1a4c49e882f6fa2f406a/README.md): size variants and GGUF availability.
- [llama.cpp function calling](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md) and [server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md): templates, serving and resource settings.

No extension implementation, executable reverse engineering, model download, Windows installation, GPU test or application run was performed for this assessment. Exact model artifacts and licences must be checked before installation/distribution. The recommendation remains provisional until the integration and hardware spike passes.
