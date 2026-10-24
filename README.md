# EqualFi shared agent service

Statics-first implementation of [statics-app#91](https://github.com/EqualFiLabs/statics-app/issues/91).
The first registered action stakes an exact STATICS amount into an explicitly identified owned position.
Eves is an implementation reference and a later client, not a dependency.

## Development

Use Node 22.22 or newer. Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`.
PostgreSQL tests require `TEST_DATABASE_URL` pointing to a **disposable dedicated database**;
they truncate the agent tables. Ordinary unit tests do not require network or credentials.

The reviewed Statics SDK is vendored from the Statics app. Its upstream provenance is retained in
`vendor/statics-sdk`; update it explicitly, never from model-provided metadata.

## Delivery slices

1. Canonical action contracts and deterministic Statics staking adapter.
2. PostgreSQL workflow ownership, budget reservations, signed-transaction persistence and recovery.
3. Verified Privy identity, app-scoped grants and private signing boundary.
4. Pinned client SDK and Statics proposal/manual/delegated integration.
5. App-scoped conversations, bounded research, metering and end-to-end rehearsal.

Execution starts disabled. A passing mocked test is not evidence of Privy signing, fork execution,
production deployment, source-to-runtime provenance, or independent audit assurance.

See [architecture](docs/architecture.md) for action/state/authority contracts and
[operations](docs/operations.md) for deployment, pause/drain, backup and enablement gates.
Use separate API and worker environments. Production execution remains disabled.
