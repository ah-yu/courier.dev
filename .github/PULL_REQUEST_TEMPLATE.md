## What changed

<!-- One or two sentences; link the issue if there is one. -->

## Verification

- [ ] `bun run verify` — 8/8 gates green
- [ ] `bun run verify obsidian` (L3) — or `L3 not run: <why>`
- [ ] `bun run test:coverage` at the boundary (when the change is at a release boundary)

## Contract impact

<!-- Author record for the release review; the human approval is the protected `release`
     environment, not this pull request. Fill this when a contract-sensitive path changed;
     delete it otherwise. Paths: packages/shared/src/contract.ts, packages/shared/contract/,
     packages/shared/src/wire/, packages/server/src/, scripts/contract/,
     packages/engine/src/websocket.ts. See AGENTS.md -> "Contract review". -->

- [ ] `bun run contract` read: every `!` / `~` / `+` is intended
- [ ] `CONTRACT_GENERATION` / `MIN_CLIENT_CONTRACT` are correct; the floor moved only for breaking
- [ ] `decision.reason` names the change and **which side must upgrade**
- [ ] The surface diff was reviewed, not just the code diff
- [ ] A semantic change with no surface diff has an L1 test and an owning-document update
- [ ] Server routes/handlers: registry, L1 test and response schema updated
- [ ] WebSocket/binary changes: both sides and the frame/round-trip test updated

## Release note

<!-- When the generation moves: which side upgrades, and what a user sees. -->
