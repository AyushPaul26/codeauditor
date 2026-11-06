# CodeAuditor Local

A review-first VS Code coding agent. TrueForge runs the agent loop; a small local model proposes changes; you decide which hunks to apply.

**Status: development preview.** TypeScript, deterministic tests, browser UI checks and real TrueForge/MCP protocol tests run in the cloud. Native Windows VS Code/CUDA and the three fixed tasks with an actual small model still require laptop validation. This is not a claim of a completed competition submission.

## What it does

- Inline edit: select code and press **Ctrl+Alt+E**.
- Agent sidebar: describe a task without naming every file.
- `@file:path` / `@symbol:name`, automatic code/test/docs retrieval and visible selection reasons.
- Per-hunk accept/reject, native editor diff, guarded application and undo.
- Streamed responses, Stop, explicit command approvals and optional independent model fallback.
- Workspace access through authenticated loopback MCP tools, driven by TrueForge.

```text
VS Code extension ──SDK sessions/turns──> local TrueForge ──> local model
        ^                                  |
        └──── authenticated MCP tools ─────┘
```

## Windows quickstart

You need Windows 11, VS Code, Git, Node.js 22 LTS >=22.14, Python 3.12 x64 and a compatible NVIDIA driver. Your RTX 3050 4 GB / 24 GB RAM is the intended target, not a measured performance guarantee.

```powershell
git clone https://github.com/AyushPaul26/codeauditor.git
cd codeauditor
npm ci
npm run setup:local
npm run doctor
```

If PowerShell blocks `npm.ps1`, use `npm.cmd` instead; no machine execution-policy change is needed.

1. Obtain a CUDA-compatible **llama.cpp server** from its [official releases](https://github.com/ggml-org/llama.cpp/releases) and a trusted **Qwen3-1.7B Q4_K_M GGUF**. Check artifact provenance, published checksums and licences. Do not download an Antigravity executable; it is not part of this build.
2. Edit `%LOCALAPPDATA%\CodeAuditor\runtime.json`, created by setup. Supply the absolute `primary.llamaServerPath`, `primary.modelPath`, and their SHA256 values. The paths and token stay outside Git. Hashes pin the selected bytes; merely calculating a hash does not prove the original source was trustworthy. See [Windows setup](docs/windows-setup.md) and [model example](config/models.example.json).
3. Start each process in its own terminal:

```powershell
npm run model:start
```

```powershell
npm run harness:start
```

4. Register the model, tools and agent with the running harness:

```powershell
npm run harness:configure
npm run compile
code .
```

5. Press **F5**. In the Extension Development Host, open a trusted project folder. Select the CodeAuditor activity-bar icon, then **Check connection**. This starts the MCP bridge; a real task verifies the model/tool connection beyond the service health check.
6. Start with a small edit. Review every hunk. **Apply reviewed changes** changes editor buffers; save explicitly before verifying the working project. **Undo last apply** reverses the last application if the affected content has not subsequently changed.

For the initial organiser quickstart, run `npx @truefoundry/trueforge@latest` separately. This project uses pinned TrueForge **0.184.2** for reproducible runs; do not start two harnesses on the same port.

The model and harness do not start automatically when VS Code starts. Restart their terminal processes for a new local session. No cloud deployment, account, hosted database or Marketplace publication is required.

## Prepare the competition test repository

```powershell
npm run fixtures:prepare -- --name a
npm run fixtures:prepare -- --name b
npm run fixtures:prepare -- --name c
```

The helper uses Flask tag `3.1.3`, verifies commit `22d924701a6ae2e4cd01e9a15bbaf3946094af65`, prepares a separate locked Python environment and runs the CLI baseline. Fixtures, environments and demo apps stay outside this repository. Modified fixtures are preserved, not reset.

See [testing](docs/testing.md) for the exact A/B/C verification, PowerShell syntax, import-provenance checks and clean-status checks. All three live tasks must be rehearsed with the actual model before recording.

## Test and package

```powershell
npm run typecheck
npm test
npm run test:extension
npm run package:vsix
code --install-extension .\artifacts\codeauditor.vsix
```

`test:extension` downloads a pinned official VS Code test build and launches an isolated profile. It requires a desktop/display; `CODEAUDITOR_VSCODE_EXECUTABLE` can point to an existing test-compatible VS Code binary. The cloud policy currently blocks the official download domain, so this native test remains unrun here.

Browser-only UI checks:

```powershell
npx playwright install chromium
npm run test:browser
```

Alternatively set `CODEAUDITOR_CHROMIUM_PATH` to an existing Chromium executable. Browser tests simulate the VS Code host bridge; they do not certify native editor behaviour.

Opt-in genuine model/tool smoke (run with model, harness and extension MCP bridge active):

```powershell
$env:CODEAUDITOR_LIVE = '1'
npm run test:live
Remove-Item Env:CODEAUDITOR_LIVE
```

`CODEAUDITOR_HARNESS_SMOKE=1` separately enables real-harness protocol tests with a controlled scripted provider. Those tests prove transport/tool/approval plumbing, not model reasoning or fixed-task success. See [benchmarks and evidence](docs/benchmarks.md).

## Configuration and switching models

The private runtime file is canonical for local ports, provider assets and agent registry names. Optional **CodeAuditor** VS Code settings override the agent/harness URL and Python interpreter on this machine. Configure another provider/model in TrueForge and select its agent name; the extension never calls model providers directly.

For fallback, add an independently served `fallback` model configuration, run `npm run model:fallback` and rerun `npm run harness:configure`. Use CPU inference for the backup if needed to avoid occupying the 4 GB GPU twice. Failover happens before tool activity only; the extension never blindly replays tools or approvals. Two failed endpoints end with a visible error and no unapproved application.

Default inference is one slot, 4,096 total context tokens and thinking disabled. Retrieval uses conservative estimated token reserves; actual prompt fit, tool calling and compaction must be measured with the selected artifact. No speed or accuracy is guaranteed.

## Current limitations and safety boundaries

- Native Windows/CUDA, real-model Task A/B/C, model-switch live judging, four-minute video and final PDF are still pending.
- One active workspace per MCP port. Close the previous extension host before using that port elsewhere.
- Source files are limited to 2 MiB; retrieval has additional scan/context limits. Symbol support is lightweight and not a complete language-server graph.
- Existing-file edits can apply together. File creation/deletion must use a separate single-file proposal because VS Code does not guarantee atomic mixed resource/text transactions. New-file installation is exclusive and cannot overwrite an existing path.
- `read_file` defaults to current editor text for exact patch context. Optional staged views are for inspection; overlapping pending proposals are rejected and need a newly reviewed consolidated proposal.
- Commands are bounded Python pytest/Flask/syntax checks, not unrestricted shell access. They require explicit approval and run against a temporary copy that includes staged text. This is **not an OS security sandbox**; run only trusted project code. Unsupported commands are denied.
- Accepted existing-file edits remain unsaved until you save. Task C checks both disk and unsaved buffers. A commit already authorised and submitted may finish; Stop revokes unapproved/precommit work rather than secretly reverting accepted changes.
- No telemetry is added by this extension. Inference and TrueForge configuration determine their own network behaviour; do not claim an air-gapped deployment without checking all configured services.

## Starting point, licence and submission

**From scratch.** No upstream editor code or proprietary executable was used. TrueForge, MCP SDK and ordinary dependencies are attributed in [third-party notices](THIRD_PARTY_NOTICES.md). CodeAuditor source is MIT; model and binary artifacts retain their own licences and are not bundled.

The [approved implementation plan](docs/superpowers/plans/2026-11-07-codeauditor-implementation.md), [progress ledger](docs/implementation-progress.md), [scorecard](docs/scorecard.md) and [write-up draft](docs/writeup.md) track actual evidence and remaining submission work. AI coding assistance must be declared in the final write-up. Do not commit keys, runtime configuration, model weights or private repositories.
