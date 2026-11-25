# Providers for Kin agents

A Kin agent runs on a T3 provider (Claude, Codex, an ACP agent). Kin decides what each session is once, for every provider, and each provider only applies that decision to its own protocol. Read this before you add a provider or a capability.

## The shared layer

Everything Kin decides about a session lives in [`lead/turn/`](../../apps/server/src/kin/lead/turn):

- [`content.ts`](../../apps/server/src/kin/lead/turn/content.ts) turns every attachment into text plus images before any provider sees it: a PDF becomes its text layer and page images under one page budget, a spreadsheet or Word file its extracted text, and audio a line saying there is no transcript. A provider only ever gets text and the images T3 lists as supported.
- [`session.ts`](../../apps/server/src/kin/lead/turn/session.ts) plans each session: its seat (owner, confined, delegated, dream), Kin's instructions plus one line on what this seat has, whether tools beyond Kin's core wait for a search, the signing shell, and the per-call refusal. A confined session (a chat others read) gets Kin's tools only. Once a refusal applies, no built-in runs on any provider; Kin's own tools still answer, behind their own gates.
- [`packages/contracts/src/kinProviders.ts`](../../packages/contracts/src/kinProviders.ts) is the providers table: driver, label, effort option, whether it sits behind the host's switch or is dev-only, the built-ins it lacks, and the rules Kin can't hold it to (`limits`). The allowlist, the refusal text, the effort picker, the switch copy, the agent page and the agent's own session line all read it.

A new capability goes in the shared layer only. If it needs a provider to do something new, add a field to the plan and have every descriptor apply it, so the conformance suite fails until each one does.

## What a provider supplies

One descriptor in [`lead/turn/providers/`](../../apps/server/src/kin/lead/turn/providers), registered in `providers.ts`:

- `driver`, T3's driver kind.
- `capabilities`: its names for each built-in Kin knows (shell, files, web, images, sub-agents). One it lacks is left out, and its row in the providers table must list it under `lacks`.
- `install(base)`: wraps the T3 seam its adapter opens sessions through and applies `KinSessions.plan` to each session it opens. Claude wraps `ClaudeAgentSdkQueryRunner`, Codex `CodexAppServerClientFactory`, and ACP the `AcpSessionShaper` reference. Protocol plumbing stays here, and nothing else does.

Then add a fake to `conformance.test.ts`: a recording stand-in for the provider process that reports what the session got in Kin's words (`conformance.testkit.ts`). The suite runs the same cases on every provider: the owner's chat, a refused turn, a teammate's chat, a delegated task, and a thread that isn't Kin's. A provider with any `limits` must be `devOnly`, so it never reaches a real owner.

## Adding one

1. Write the descriptor and its fake, and add a row to the providers table.
2. Run `vp test run apps/server/src/kin/lead/turn/` until the suite passes, or declare what the provider can't do as `lacks` or `limits`.
3. Run `.agents/skills/verify-kin/scripts/provider-conformance.sh <instance> <model>` on a verify-kin instance started with the provider's credentials: the same fixed turns live, as a table.
4. Run the Kin eval on the provider's cheapest model (`evals/mcp-tool-use`). Its runner reads the same instructions and descriptors.

T3's own adapters stay as they are. When a seam is missing, add the smallest hook T3 could keep, as `AcpSessionShaper` is for ACP.

## What stays provider-specific

- Dreams run on Claude only ([`DreamIsolation.ts`](../../apps/server/src/kin/dreaming/DreamIsolation.ts)). Codex can't confine a checkout's reads.
- Codex lacks a background shell and page fetch. ACP agents bring their own tools, config and environment, so Kin reaches only what they ask for and what T3 serves them.
- A delegated task on Codex runs T3's MCP tools without a per-call ask, so after a refusal only its shell and edits are checked. On Claude, its T3 tools are checked too.
