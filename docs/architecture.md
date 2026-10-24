# Statics-first shared agent base

Implements the first five slices of [Statics #91](https://github.com/EqualFiLabs/statics-app/issues/91). Eves remains a later client. The only execution capability is `statics.stake-existing@1`.

## Action contract and ownership

`src/contracts.ts` defines the strict action input. The API, deterministic adapter and Mastra stake tool consume this schema. Inputs are an explicit registered deployment, linked wallet, owned position ID, positive integer STATICS units, and a positive native-fee limit per transaction. There are no caller-provided targets, calldata or gas overrides.

A client intent key identifies a requested execution; a content digest detects conflicting reuse. Identical inputs with a new intent key represent an intentional second action. Prepared plans contain a version, immutable deployment snapshot, review revision, observed block, expiry, exact steps and digest. Execution accepts only the server action ID and current plan digest. Repreparation creates a new digest and new step identities; prior plans remain in the event journal.

`src/statics.ts` builds exact approval (only if allowance is insufficient) and stake calls using the vendored Statics SDK. It checks chain, diamond/token runtime, selector-to-facet addresses and facet hashes, ownership, balances and allowance. Immediately before signing/submitting it checks the current registry revision, simulates, estimates bounded gas and enforces fee limits. An upgrade blocks new submissions until operator review/repreparation. Recovery uses the plan's pinned addresses and checks chain identity, so changing the registry does not redirect historical verification.

## State transitions

- `ready`: prepared proposal; no signature or spend.
- `running`: explicitly activated manual/delegated workflow.
- `awaiting_manual`: exact nonce/transaction and budget reservation persisted, awaiting the user's wallet signature.
- `reconciling`: signed/submitted hash exists; reconcile that attempt before any later step.
- `blocked`: no unresolved submitted attempt; missing authority, budget, inputs, fees or deployment validation prevents progress. Explicit resume/repreparation is available.
- `completed`: every step has a canonical successful receipt plus matching protocol event and resulting state.
- `failed`: a canonical reverted receipt or a different canonical nonce replacement establishes failure.
- `cancelled`: future signing/submission stopped; submitted attempts must first reconcile. Cancellation cannot undo a transaction.

The PostgreSQL aggregate and append-only public event journal survive restarts. A wallet/chain session advisory lock prevents concurrent workers from reserving the same nonce. Optimistic versions reject stale writes. Another unresolved action or external pending nonce blocks new execution. The worker uses sign-only Privy, checks every signed field and recovered sender, encrypts raw bytes with workflow-bound authenticated encryption, persists bytes/hash, then persists a submission marker **before** broadcast. A timeout retains reservations and the exact bytes. Recovery never signs a replacement action to work around uncertainty. It can discover replacements within 64 blocks; older unknown replacements remain unresolved for investigation.

Receipts need one following block and matching canonical block hash (two-block policy). This is a pilot policy, not absolute finality. Deep reorgs after completion require operational reconciliation. Approval requires exact owner/spender/value event and historical allowance. Stake requires the exact contract, payer, position and amount event plus historical staked balance.

## Identity and authority

Every request needs both a server app connection secret and a verified Privy token with the configured audience/expiry and pilot DID. The wallet must be freshly linked to that user. Internal identity includes the Privy app and DID; action status, events and conversations are owner/app scoped. Only embedded Privy wallet IDs may be used for unattended signing. Installing a Privy signer does not create an app grant.

The API process has only a Privy **read-only** application secret. The separate loopback worker owns the full provider secret, authorization key and transaction encryption key. The API cannot load those signing credentials. The worker independently authenticates manual signatures forwarded by the API. Both API and worker require app credentials; CORS, browser app labels and origins are not authority.

Global wallet/chain limits apply across app grants. Each app grant has its own active state, exact deployment/positions, per-action and daily principal, daily fees, approval authority and expiry. Global pause, grant changes and revocation share row locks with reservations and sign-only authorization. They prevent later steps, not already broadcast transactions. Approval reserves only fees; stake reserves principal and fees separately. Outstanding reservations survive UTC day rollover. Settlement is idempotent, releases reservations on their original day and charges actual principal/receipt fees on the settlement UTC day. Manual actions still observe global pause/budgets and require exact-plan consent and the linked wallet's signature.

## Conversations and research

Mastra is request scoped; the database owns conversation/message identity, history and action links. A message key is idempotent and creates at most one stake intent. Tools call the same API/adapter as direct UI actions. No model output changes grants or submits arbitrary transactions. Automatic chat execution additionally requires a fully specified original-user imperative recognized independently of the model (`src/intent.ts`), matching the exact typed amount, position, deployment, wallet and fee limit. Research-only, quoted, hypothetical, ambiguous or mismatched requests can only create proposals. Supported format: `Stake 100 STATICS in position 42 with maximum network fee 0.001 ETH per transaction`, optionally `on deployment <id>`. Multiple registered deployments require the explicit ID. Research sources are untrusted data. Page fetches require public HTTPS, pin validated IPv4 DNS results, reject local/reserved networks, credentials, alternate ports and encoded bodies, cap redirects/time/bytes and return bounded text. Research runs in the API process, without signing secrets.

The allowlisted pilot is operator funded. Before a paid call, global/user daily usage is atomically charged a conservative full request envelope: eight model steps with at most 500,000 input tokens and 1,500 output tokens each, plus three research calls, at operator-configured upper price bounds. Request inputs/history/tool responses are bounded below that input envelope. Provider retries are disabled. Configure model context limits and pricing so these assumptions hold; unsupported price changes require disabling chat. Message records retain model, charged bound and observed usage; the cap ledger intentionally does not refund unused estimates. Failed/aborted calls remain charged. Crashed messages become interrupted and are never automatically replayed. Authenticated requests share a 120/minute user throttle across apps. Billing, schedules, swaps, browsing automation, Eves migration and production enablement are deferred.
