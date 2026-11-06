# Implementation ledger

Plan: docs/superpowers/plans/2026-11-07-codeauditor-implementation.md
User approved implementation in chat. Existing repository was genuinely empty.

## Decisions and dependencies

- Root owns the shared contracts, extension integration and final verification. Independent modules may be implemented in parallel with explicit file ownership, then reviewed together. This follows the session's parallel-delegation requirement while preventing conflicting edits.
- The cloud machine runs Linux with Node 24.22.1. Node 22.14+ remains the documented target. Windows/CUDA checks are separate acceptance gates; no cloud result certifies the laptop.
- The approved plan's Windows feasibility gate cannot run in this cloud machine. Implement and validate the useful independent core here and supply a real live-model gate; never claim the gate passed without execution.
- npm cache must be set to /workspace/.cache/npm in cloud commands because the default home cache is not writable. Do not put this cloud-specific override in the shipped Windows configuration.

## Progress

- Development preview implemented. Native/model acceptance gates below remain open.
- TrueForge 0.184.2 / SDK 0.184.1 exercised through actual local settings/session APIs.
- Implemented MCP, retrieval, private per-hunk reviews, version guards, undo, bounded command copies, streaming and guarded fallback.
- Latest deterministic suite: 180 passed. Browser UI: 5 passed. Actual TrueForge/MCP protocol with scripted provider: 4 passed (not model-intelligence evidence).
- Pinned Flask baseline: 58 passed twice with uv 0.9.28/Python 3.12.14; source clean including untracked files.
- Typecheck, build, strict UI audit and VSIX packaging passed. DESIGN.md lint: zero errors, advisory token warnings.
- Review regressions fixed: partial approval batches, stale-document preflight, cancellation before commit, staged-newfile omission, deferred call_tool approval routing, runtime URL override, duplicate initial starts.
- Native VS Code test download denied by cloud network policy. Runner is included; native extension checks unrun here.
- Genuine-model smoke reached TrueForge but failed because no model endpoint/binary/GGUF exists. No Task A/B/C or GPU success is claimed.

## Rulings

- Coupled host lifecycle lives in src/extension.ts; domain modules remain separate. Cost: split the host when another workflow needs it.
- Multi-file existing-text changes use the editor's all-or-nothing operation. Resource creation/deletion requires a separate single-file proposal; approved new files install exclusively. Cost: split mixed proposals, rather than claim unsupported atomic file/text operations.
- read_file defaults to current editor text for exact oldText context; includeStaged opts into overlay inspection. Commands include overlays/new files. Overlapping staged edits need consolidation and a new review. Cost: explicit restaging for dependent edits.
- Commands are bounded trusted-Python checks, not arbitrary shell or an OS security sandbox. Cost: additional languages/commands need a reviewed policy extension.
- Model binaries/weights remain external, with provenance and verified digest selection. Cost: laptop assets must be supplied before live acceptance.
- Fallback only before tool activity; do not blindly replay possible effects. Cost: failures after tool execution need explicit recovery.

## Remaining acceptance

1. Select verified Windows inference artifacts and record exact release/revision/hash.
2. Measure GPU fit, context/schema fit, real tool calls, latency and reliability.
3. Run native F5/VSIX tests and Windows process-tree cancellation.
4. Rehearse exact A/B/C with genuine models and repeat on fresh fixtures.
5. Complete team details, real video timestamps, final PDF and public portal submission. Drafts mark missing evidence honestly.
