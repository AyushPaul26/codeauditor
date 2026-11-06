# CodeAuditor interaction contract

Business source: docs/superpowers/specs/2026-11-07-codeauditor-design.md and the supplied competition PDF.

| Capability   | Canonical owner                 | Source of truth                   | Allowed variants                                              | Verification                                            |
| ------------ | ------------------------------- | --------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| Form         | media/panel.js                  | Approved spec and DESIGN.md       | Sidebar instruction; VS Code owns inline input                | tests/unit/ui-html.test.ts; tests/browser/panel.spec.ts |
| Scrollbar    | media/panel.css                 | DESIGN.md theme mapping           | Host theme and forced-colors                                  | tests/browser/panel.spec.ts                             |
| Status/error | AgentPanel state                | Approved spec and SDK event types | Persistent error, polite status                               | UI and streaming tests                                  |
| Review       | ProposalStore + diffReview      | Approved spec                     | All hunks decided; immutable proposals; harness approval      | edits tests and real-harness protocol                   |
| Cancel       | Application + TrueForgeClient   | Approved spec                     | Invalidate locally, cancel remotely; deny late precommit work | TrueForge and command tests                             |
| Commands     | CommandRunner + host permission | Approved spec                     | Explicit approval, trusted project, temporary copy            | command tests                                           |

No billing, accounts, deletion workflow or regulated personal-data collection exists. Chat/drafts remain in VS Code webview state; no external analytics. Only the configured local TrueForge and MCP endpoints receive request/code data. User source is changed only after review; applying edits and saving files are distinct actions. New tasks cannot silently discard active review. Review decisions are never inferred from model text.
