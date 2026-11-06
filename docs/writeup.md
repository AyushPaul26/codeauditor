# Team

Team name, members, affiliations and handles: **to be supplied by the submitter**. Repository: [AyushPaul26/codeauditor](https://github.com/AyushPaul26/codeauditor). Final public video/PDF links and timestamps remain pending. This draft must be formatted into the required one-to-three-page PDF after genuine evaluation.

# Starting point

CodeAuditor Local starts from a new TypeScript VS Code extension in the supplied repository. It does not retain another coding agent's model/tool loop. The implementation uses the official TrueForge and MCP SDKs; dependencies and licenses are recorded with the source. The Flask evaluation fixture is the unmodified 3.1.3 baseline at `22d924701a6ae2e4cd01e9a15bbaf3946094af65`, prepared separately for A/B/C. No task-specific Flask solution is bundled into the agent.

# Architecture on TrueForge

The VS Code extension submits sessions/turns to TrueForge and renders its events. TrueForge owns model calls and the autonomous tool loop. A bearer-authenticated workspace MCP bridge binds to loopback and exposes bounded reads/search/retrieval, staged patches, reviewed apply and approved verification commands. `request_apply` and `run_command` pause through TrueForge's literal-name approval policy. Per-hunk decisions and document versions are checked by the extension's private review state; model-supplied arguments cannot serve as approval. Changes remain proposals until accepted, conflicts are rejected and undo preserves earlier user edits. The command policy uses isolated copies for supported checks so ordinary cache/generated-file side effects do not silently dirty source.

# How context is selected

Explicit @file/@symbol references and bounded lexical/symbol retrieval select relevant snippets, including current editor buffers. The UI reports files, line ranges, reasons and estimated token usage. Output and instruction/schema space are reserved from the total 4,096-token target. The estimator is byte-based rather than the exact Qwen tokenizer; schema, history and tool-result fit requires live validation. Core read/search/retrieval/staging schemas preload selectively; apply/command discovery is deferred. TrueForge compaction triggers at an estimated 2,048 input tokens. Its token savings, extra calls and preservation of essential task state remain to be measured on the selected model.

# Model setup

The primary candidate is Qwen3-1.7B Q4_K_M via a verified llama.cpp CUDA distribution, nonthinking Jinja tool template, one slot and at most 1,024 output tokens. Exact inference binary/model revision and hashes must be recorded before the laptop evaluation; none are invented or committed as weights. An optional second independently served Qwen3 model on CPU provides fallback without GPU contention. TrueForge runtime 0.184.2 and SDK 0.184.1 are pinned. Switching providers changes the TrueForge agent configuration without recompiling the extension. Actual GPU fit, a second-model task and external-provider compatibility remain unverified. Local inference has no per-token service fee; hardware/electricity costs are unmeasured and no hosted-model inference cost is claimed.

# Scorecard

| Criterion           | Max | Evidence / final video                                        |
| ------------------- | --: | ------------------------------------------------------------- |
| A1 Inline editing   |  10 | Real Task A pending; timestamp pending                        |
| A2 Agent mode       |  10 | Real autonomous three-file Task B pending; timestamp pending  |
| A3 Streaming/cancel |  10 | Deterministic transport checks; Windows demo pending          |
| B1 Context assembly |  15 | Retrieval/budget implementation; live trace pending           |
| B2 Diff safety      |  10 | Private per-hunk review/undo checks; native demo pending      |
| B3 Resilience       |  10 | Recovery path; independent-model Task C pending               |
| B4 TrueForge depth  |  10 | Actual runtime/settings registration; real tool trace pending |
| C1 Video            |  10 | A/B/C recording not produced                                  |
| C2 Write-up         |  15 | Draft; final PDF/team/timestamps pending                      |

The detailed ledger is [scorecard.md](scorecard.md). No score or success rate is asserted without the corresponding recorded evaluation.

# Tools used

OpenAI Codex assisted implementation, documentation and tests. Development used VS Code APIs, TypeScript, Node/npm, official `@truefoundry/trueforge-sdk`, pinned `@truefoundry/trueforge`, official MCP SDK, Vitest, esbuild, VS Code extension-test/VSIX tooling, Git, Python 3.12 and uv 0.9.28. llama.cpp and Qwen3 are the selected local-inference candidates. State the final model artifacts, any additional AI tools and their actual use in the submission; no runtime model output is fabricated by test endpoints.

# Known limitations and what you would do with another month

The current evidence separates deterministic/cloud checks from unrun Windows/CUDA and genuine-model checks. Actual local tool-call reliability, full-prompt fit, native hunk UI, packaged installation, process-tree cancellation, repeated A/B/C runs, independent fallback and recording remain necessary before claiming completion. A small model may need extra retrieval/tool turns and can produce malformed arguments. Compaction uses estimates and can lose detail. Commands deliberately support a narrow set of Python/Flask checks; unsupported shell snippets fail clearly. One MCP port serves one active trusted workspace. With another month, priorities are measured tokenizer-aware budgeting, broader Windows regression coverage, stronger retrieval and reproducible model benchmarks, followed by evidence-backed security/change-impact auditing.
