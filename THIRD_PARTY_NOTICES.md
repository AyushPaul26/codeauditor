# Third-party notices

CodeAuditor is a from-scratch extension. No Antigravity, Cline, Continue, Roo Code or opencode source was copied.

Runtime dependencies, installed from npm with exact versions recorded in package-lock.json:

- TrueForge TypeScript SDK, @truefoundry/trueforge-sdk — TrueFoundry, MIT.
- Model Context Protocol TypeScript SDK, @modelcontextprotocol/sdk — Anthropic/MCP contributors, MIT.
- Zod — Colin McDonnell and contributors, MIT.

Development/runtime tooling includes TrueForge local harness (MIT), TypeScript (Apache-2.0), esbuild (MIT), Vitest (MIT), Playwright (Apache-2.0), VS Code extension packaging/test tooling (MIT), and their transitive dependencies. Original package notices/licences remain authoritative; npm installs preserve them in their package directories. The extension bundles runtime dependency code; runtime licence texts are included in THIRD_PARTY_LICENSES.txt during packaging.

llama.cpp binaries, GGUF models and Flask test fixtures are external assets, not bundled in the extension. Verify the exact selected model/binary licence and attribution before redistributing or commercial use. Qwen3's official repository states Apache-2.0; that is not a blanket statement about every Qwen model. No model weight is included here.
