# Pilot operation and release gates

## Installation and separation

Use Node 22.22+, PostgreSQL 17+, `npm ci`, `npm run build`. Run `DATABASE_URL=... npm run migrate` once before either process. Migrations are idempotent create operations; back up before upgrades. Use a dedicated least-privilege database role, TLS for remote database connections, and access-controlled process/network environments. Never put credentials in a deployment file or checked-in environment.

Supply **different** environment files to `npm start` (API, loopback 4310) and `npm run worker` (worker, loopback 4311). `.env.api.example` and `.env.worker.example` describe the split. Use a reverse proxy/private authenticated network between the app BFF and API. The worker control endpoint must remain private. Neither process implements public CORS. Browser clients use the Statics same-origin BFF, whose connection key exists only server side.

The SDK archive comes from `npm run sdk:pack`. Copy the resulting `.tgz` into the app vendor directory, record its SHA256/source revision, and install that exact file. The SDK has no signing or server dependencies. App environment: `NEXT_PUBLIC_AGENT_ENABLED=false` by default, `AGENT_SERVICE_URL`, `AGENT_APP_CONNECTION_KEY`. Public Privy configuration remains the existing Statics wallet configuration.

## Deployment provenance

`DEPLOYMENTS_FILE` is a reviewed JSON array conforming to the strict schema in `src/statics.ts`. Each entry includes id/revision/chainId, private RPC **environment variable name**, diamond/token addresses and runtime hashes, protocol/SDK commits and selector/address/runtime hashes for relevant facets. Required selectors are `stake(uint256,uint256)`, `stakePosition(uint256)`, `ownerOf(uint256)`, and `syncMorphoForModule(uint256,address)` (pin the zero address plus empty-code hash when this transitive route is absent). Known minimal-proxy/EIP-7702 delegates must appear in `dependencies` with pinned runtime hashes; each dependency runtime is also checked. Add every relevant facet/runtime dependency to the review inventory. Compare source-build artifacts to deployed runtime and confirm selector routing, token implementation/proxy behavior and current manifest identity. A commit label or a runtime hash observed from RPC alone does not establish source provenance. No production registry is supplied by this implementation. Fail closed until reviewed configuration exists; never automatically learn trusted hashes from live RPC.

## Enablement checklist

Execution requires BOTH `EXECUTION_ENABLED=true` and `PRIVY_SIGNING_REHEARSED=true` in the worker. Keep them false until all gates pass:

1. Reviewed deployment provenance and adapter/facet compatibility; pinned SDK archive matches source.
2. Dedicated read-only API credential and worker-only signing credentials; provider policy restricts sign-only transactions to the registered chain, token/diamond, allowed selectors and zero native value. Confirm additional-signer policy binding. Application budgets remain the authority for decoded positions/amounts; provider policy is defense in depth.
3. Real Privy sign-only rehearsal with a pilot embedded wallet: verify recovered sender and every signed field; interrupted-response behavior; signer installation/removal, app revocation and global pause. Browser manual flow must return signed bytes rather than broadcast independently. Wallets without `eth_signTransaction` support remain unsupported for manual execution.
4. Fork/browser end-to-end proof: prepare -> approve if needed -> stake -> verified outcome, process restart, refresh/reconnect, pending UX, cancellation and no duplicate broadcast. Local signer evidence is separate from provider evidence.
5. Operator-funded pilot users, verified provider prices/context bounds, user/global usage caps, actual Mastra inference and source-linked research. Exa and model keys require independent runtime verification.
6. Migrations and restore rehearsal, recoverable worker restart, monitoring and rollback run-through. Required app/service CI gates and independent local review must pass at the delivered revision.

The implementation deliberately leaves provider and production gates disabled when credentials/evidence are absent. Do not set the rehearsal flag merely because mocked or local-fork tests pass.

## Pause, drain, rollback and recovery

- Global user pause or app revoke prevents subsequent signing/submission. Removing Privy signer access is an additional wallet-level stop; application revocation should happen first.
- Operator emergency stop: set worker `EXECUTION_ENABLED=false`, gracefully restart it. Existing submitted hashes continue reconciling; signing and broadcasts stop. Keep the encryption key and database available. Disabling the web feature flag hides the UI and blocks its BFF; it does not cancel server workflows.
- Keep the worker running to drain submitted actions. Inspect unresolved attempts, encrypted evidence, hashes, canonical receipts, wallet nonces, reservations and journal. Never delete attempts or release reservations to unblock a wallet without canonical evidence. Replacement search is bounded to 64 blocks.
- Roll back app routing only after in-flight shared actions drain or remain visibly recoverable. Do not re-enable an independent staking broadcaster against a wallet with unresolved shared actions.
- Retain previous service/app artifacts, deployment registry, database backup and encryption key securely. Restore database and the SAME encryption key together. Reconcile existing hashes before enabling new work; restoring an old snapshot can omit later transactions, so compare wallet nonces, chain receipts and append-only backup/journal before resuming.
- SIGTERM closes intake and lets the active worker tick finish. Supervisors must allow the provider/RPC timeout envelope. Abrupt termination is recoverable from committed attempt evidence.

## Monitoring and retention

Alert on worker/API unavailable, database errors, `workflow_recovery_required`, `worker_database_unavailable`, blocked actions, unresolved submission/outcome age, disabled execution, budget exhaustion and provider failures. The API never returns raw upstream exception text or signed bytes. Poll scoped activity/events for user status; keep operational metrics private. Reconciliation should be monitored against block progression, not solely wall-clock receipt timeouts.

Back up PostgreSQL with `pg_dump -Fc`, restore to an isolated database using `pg_restore --no-owner`, and compare action/event/reservation counts and exact pending hashes. Rehearse with execution disabled. Never run truncating integration tests against a pilot database. Retain signed evidence while pending; restrict encrypted columns/database access. Delete old rate-limit rows operationally (`minute < current UTC minute - 1440`); never prune pending action or budget evidence. Usage is charged by UTC request day and pending transaction reserves span days.
