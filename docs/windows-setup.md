# Windows 11 local setup

The supported target is Windows 11 x64 with an RTX 3050 4 GB and 24 GB RAM. The cloud build can verify code and the local TrueForge API; GPU fit, Windows process cancellation, F5 interactions and VSIX installation require a run on the laptop. No local inference result or performance measurement is implied by a passing mock test.

## Install and build

Install VS Code, Git, Node.js 22 LTS **22.14 or newer**, Python **3.12 x64** with the Windows Python launcher, and a current compatible NVIDIA driver. A prebuilt llama.cpp CUDA distribution normally avoids installing the CUDA development toolkit; follow that distribution's driver/runtime requirements.

In PowerShell:

```powershell
git clone https://github.com/AyushPaul26/codeauditor.git
cd codeauditor
node --version
npm.cmd --version
git --version
py -3.12 --version
nvidia-smi
npm.cmd ci
npm.cmd run setup:local
npm.cmd run compile
npm.cmd run doctor
```

`npm.cmd` avoids PowerShell's `npm.ps1` execution-policy restriction without changing the machine policy. `doctor` returns a nonzero status while required assets/services are missing and lists the repair step. A missing optional fallback is reported separately.

`setup:local` creates the private runtime and installs **uv 0.9.28** using Python's pip into that runtime, preserving TLS verification. It executes the installed binary by its exact path, independently of another `uv` on PATH. Repeat setup preserves existing configuration and the MCP token. Invalid existing JSON is reported and left untouched.

## Private runtime and asset selection

The default directory is `%LOCALAPPDATA%\CodeAuditor`. On Linux it is `$XDG_DATA_HOME/codeauditor`, or `~/.local/share/codeauditor`. An absolute `CODEAUDITOR_DATA_DIR` overrides it; set the same value in every terminal and the VS Code process. For a restricted cloud workspace, use a writable directory outside the source checkout, such as `/workspace/.cache/codeauditor-runtime`.

`runtime.json` contains a random MCP bearer token. Keep it private; do not copy it into this repository, screenshots, issue reports or command-line arguments. Unix files are created with private modes; Windows inherits your local user-profile ACLs. The helper does not edit global environment variables or system ACLs.

The project does **not** download or execute an unverified inference binary or invent a GGUF checksum. Select these assets yourself:

1. Obtain an x64 CUDA llama.cpp release from [ggml-org/llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases). Keep the complete extracted distribution, including required DLLs. Choose a release whose `llama-server --help` supports `--jinja`, `--reasoning-budget`, `--chat-template-kwargs` and `--no-webui`.
2. Obtain a **Qwen3-1.7B Q4_K_M GGUF** from the [official Qwen GGUF repository](https://huggingface.co/Qwen/Qwen3-1.7B-GGUF). Review the exact revision's Apache-2.0 license/model card and published SHA-256/LFS object hash. Pin the artifact revision, not a mutable `main` reference.
3. Verify the binary distribution against the publisher's release digest when available, then record the extracted `llama-server.exe` hash. For a distribution without a publisher-authenticated digest, use a reviewed build from an exact upstream commit and record that provenance. A hash calculated from an unexplained download only checks later corruption; it does not establish trust.
4. Record release/revision, source URL, license and trusted expected hashes in your local benchmark notes. Place the binary distribution under `bin` and the GGUF under `models`, or use other verified absolute paths.

PowerShell can compare an expected digest with the selected local file:

```powershell
Get-FileHash -Algorithm SHA256 'C:\path\to\llama-server.exe'
Get-FileHash -Algorithm SHA256 'C:\path\to\Qwen3-1.7B-Q4_K_M.gguf'
notepad "$env:LOCALAPPDATA\CodeAuditor\runtime.json"
```

Edit only the model fields and optional fallback in the generated file. [models.example.json](../config/models.example.json) explains the structure; its hash/token placeholders are intentionally invalid. Preserve the generated token. Required primary fields are `llamaServerPath`, `llamaServerSha256`, `modelPath`, `modelSha256`, `modelId` (`qwen3-1.7b`), and `port` (`8080`). Both hashes are checked on every model launch.

For automatic fallback, add a `fallback` model object with its own verified GGUF, a distinct alias, and port `8081`. A tool-capable Qwen3-0.6B GGUF is a candidate for CPU fallback; its success rate remains to be measured. The fallback helper uses **zero GPU layers**, an independent process and independent endpoint. A second alias on the failed primary endpoint does not demonstrate resilience or a second model.

## Start the services

Use separate PowerShell terminals in the project checkout:

```powershell
# Terminal 1
npm.cmd run model:start

# Terminal 2, when fallback is configured
npm.cmd run model:fallback

# Terminal 3
npm.cmd run harness:start

# Terminal 4, after TrueForge prints readiness
npm.cmd run harness:configure
npm.cmd run doctor
```

Model launch uses loopback, one inference slot, 4,096 total context tokens, Qwen's embedded Jinja tool template, `enable_thinking: false`, reasoning budget zero and temperature 0.2. Primary GPU-layer offload is requested; actual VRAM allocation and speed must be measured. Unsupported flags are a binary compatibility failure; select a compatible pinned release rather than removing tool-template settings without testing.

The harness helper runs the **installed, lockfile-pinned TrueForge 0.184.2** CLI with the current Node executable. It binds `127.0.0.1:8790`, uses SQLite inside the private runtime and retains TrueForge's outbound URL guard with an explicit `127.0.0.1`/`localhost` allowlist. Runtime data/cache/config environment overrides apply only to that child process. No Redis, Postgres or sandbox is required for these workspace tools.

`harness:configure` uses the actual SDK **0.184.1** settings APIs to register:

- `codeauditor-workspace`, a Streamable HTTP connector at `http://127.0.0.1:8792/mcp`, authenticated with the private bearer token;
- a custom OpenAI-compatible provider at `http://127.0.0.1:8080/v1`, with upstream model ID `qwen3-1.7b` and registry model name `local-model`;
- the registry agent **`codeauditor-primary`**, plus `codeauditor-fallback` when configured.

`harness.agentId` and `fallbackAgentId` store these **registry names** because session creation accepts `{agent: {name}}`; the agent-management API uses immutable IDs internally. Reconfiguration finds and updates the named agent. It also restores the committed local model configuration, so preserve deliberate manual provider changes before rerunning it.

The committed [agent definition](../agents/codeauditor.json) selectively preloads read/search/retrieval/staging schemas. `request_apply` and `run_command` require human approval by literal tool name. TrueForge compaction triggers at an estimated 2,048 input tokens; oversized response offloading is disabled because there is no sandbox. These estimates require live evaluation with the actual model tokenizer and schema/history payload.

The MCP bridge starts when the extension activates in a **trusted** workspace. Registration can succeed before the bridge starts; health endpoints alone do not prove tool readiness. Request a real file read and inspect the tool result in TrueForge after opening the extension. One active workspace can own a given MCP port. Port collisions fail explicitly; change `mcp.port` in runtime.json and reconfigure the connector, or close the other host.

If organisers require the manual `npx @truefoundry/trueforge@latest` quickstart, run that separately and close it before using this pinned harness on the same port.

## Prepare clean Flask fixtures

```powershell
npm.cmd run fixtures:prepare
```

This creates separate `fixtures\flask-a`, `flask-b` and `flask-c` checkouts at tag **3.1.3**, full commit **`22d924701a6ae2e4cd01e9a15bbaf3946094af65`**. It never resets/deletes a user checkout. Existing directories require a managed marker, matching HEAD and an empty status including untracked files. Modified fixtures are preserved; create a fresh named run:

```powershell
npm.cmd run fixtures:prepare -- --name a-2
```

For each fixture the helper runs pinned uv from the fixture root with process-scoped `UV_PROJECT_ENVIRONMENT` pointing to `venvs\flask-a` (or the chosen name):

```text
uv sync --locked --no-default-groups --group tests --python 3.12
```

Flask uses a **tests dependency group**, not a `.[test]` extra. The fixture's checked-in `uv.lock` is retained. The helper verifies the imported `flask.__file__`, runs baseline `tests/test_cli.py`, checks clean Git status again and writes version/baseline evidence outside the checkout. Python bytecode and pytest's cache are suppressed. The venv, uv cache, logs and standalone demo app live outside Flask. Do not add the demo app to Task C's clean fixture.

The helper prints the exact external interpreter and fixture paths. Use that interpreter for verification. The extension selects the matching managed venv for managed fixtures; use its Python-path setting for other projects.

Flask's public CLI tests intentionally include a dummy `tests/test_apps/.env`. The generic workspace secret filter still excludes live `.env` files. To reproduce those tests in an isolated command copy, preparation writes `fixture-data\flask-a.json` (or the chosen fixture name) outside the checkout. It records the canonical public Flask repository, pinned commit and only tracked `tests/**/.env` or `.env.*` Git blobs from that immutable commit. It verifies the origin, managed marker, HEAD and clean status; Git replacement objects are disabled. It never reads current `.env` contents or prints their values. The extension uses this verified public test data only inside the temporary command copy for the matching managed fixture, never as agent context. User secrets and live environment files remain excluded.

## F5, review and packaged installation

Open the CodeAuditor source in VS Code and press **F5**. In the Extension Development Host, open a managed Flask fixture and trust it. Open **CodeAuditor: Open Agent**, check the connection, and ask for one actual file read. Keep inference and TrueForge terminals running.

For Task A, select `get_debug_flag` in `src/flask/helpers.py`, press **Ctrl+Alt+E**, and enter the PDF instruction. Review individual hunks, accept/reject visibly, and save accepted changes before checking disk-based behavior. Demonstrate undo, a rejected hunk and cancellation separately. [testing.md](testing.md) gives the fixed-task checks.

Package and install:

```powershell
npm.cmd run package:vsix
code --install-extension .\artifacts\codeauditor.vsix
```

Alternatively use **Extensions: Install from VSIX**. Close the Development Host to release its MCP port, reload normal VS Code, open the fixture and repeat a real task. For an isolated profile use VS Code's `--user-data-dir` and `--extensions-dir` flags with new directories under the private runtime. Installing the VSIX does not start or keep TrueForge/inference alive.

Stop foreground model/harness processes with **Ctrl+C** in their terminals. Close the extension host to release MCP. After reload, activate the panel to reconnect. A locked port, missing model, checksum mismatch or unavailable endpoint should produce a diagnostic; do not run a second service over an occupied port.

## Model/provider switching

Change the agent's model/provider in TrueForge's UI or supported SDK configuration while retaining its workspace connector and approval rules. The extension submits sessions/turns to TrueForge; it has no direct model-provider branch. A hosted organiser model can be selected the same way, with credentials stored privately in TrueForge. External-provider compatibility is unverified until run with an authorised account. Never put provider credentials in the agent definition.

For a different local architecture, choose its documented tool template and nonthinking settings, then validate real tool arguments, tool-result continuation, streaming and cancellation. The supplied start helper is specifically configured for Qwen3. Keep a second live model/provider result separate from mock portability checks.
