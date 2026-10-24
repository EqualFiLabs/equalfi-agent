import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
  type TransactionSerialized,
} from "viem";
import type { PoolClient } from "pg";
import {
  assert,
  type Action,
  type Attempt,
  type Identity,
  type Step,
  type Transaction,
} from "./contracts.js";
import { Store } from "./store.js";
import { StaticsAdapter } from "./statics.js";
import { TransactionVault } from "./crypto.js";

export interface Signer {
  sign(
    identity: Identity,
    transaction: Transaction,
    nonce: number,
  ): Promise<Hex>;
}
export async function atomic<T>(c: PoolClient, fn: () => Promise<T>) {
  await c.query("BEGIN");
  try {
    const result = await fn();
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
}
export async function validateSignature(
  raw: Hex,
  identity: Identity,
  tx: Transaction,
  nonce: number,
) {
  const parsed = parseTransaction(raw);
  assert(parsed.type === "eip1559", "unsupported_signed_transaction_type");
  assert(
    (
      await recoverTransactionAddress({
        serializedTransaction: raw as TransactionSerialized,
      })
    ).toLowerCase() === identity.wallet,
    "signature_wallet_mismatch",
  );
  assert(
    parsed.chainId === tx.chainId &&
      parsed.nonce === nonce &&
      parsed.to?.toLowerCase() === tx.to &&
      (parsed.data ?? "0x") === tx.data &&
      (parsed.value ?? 0n) === BigInt(tx.value) &&
      parsed.gas === BigInt(tx.gas) &&
      parsed.maxFeePerGas === BigInt(tx.maxFeePerGas) &&
      parsed.maxPriorityFeePerGas === BigInt(tx.maxPriorityFeePerGas) &&
      !parsed.accessList?.length,
    "signed_transaction_mismatch",
  );
  return keccak256(raw);
}
export class Executor {
  constructor(
    readonly store: Store,
    readonly adapter: StaticsAdapter,
    readonly vault: TransactionVault,
    readonly signer: Signer,
    readonly enabled: () => boolean,
  ) {}
  async run(id: string) {
    const initial = await this.store.get(id);
    return this.store.walletLock(
      initial.identity.wallet,
      initial.plan.chainId,
      async (c) => {
        let action = await this.store.get(id, undefined, c);
        if (
          ["completed", "failed", "cancelled", "needs_input"].includes(
            action.status,
          ) ||
          action.mode === "proposal"
        )
          return action;
        for (const step of action.plan.steps) {
          let attempt = action.attempts.find((a) => a.stepId === step.id);
          if (attempt?.status === "confirmed") continue;
          if (attempt?.hash) {
            const settled = await this.reconcile(c, action, step, attempt);
            if (!settled) return action;
            if (action.status === "failed") return action;
            continue;
          }
          if (action.cancelRequested) {
            action.status = "cancelled";
            await atomic(c, async () => {
              if (attempt) await this.store.settle(c, action, step, "0", "0");
              await this.store.save(c, action);
            });
            return action;
          }
          try {
            assert(this.enabled(), "execution_disabled");
            const tx = await this.adapter.validate(action.plan, step);
            if (!attempt) {
              const other = await c.query(
                "SELECT 1 FROM agent_actions WHERE wallet=$1 AND id<>$2 AND (body->'plan'->>'chainId')::integer=$3 AND EXISTS (SELECT 1 FROM jsonb_array_elements(body->'attempts') AS a WHERE a->>'status' IN ('reserved','signed','submitted','unresolved')) LIMIT 1",
                [action.identity.wallet, action.id, action.plan.chainId],
              );
              assert(!other.rowCount, "wallet_has_unresolved_action");
              const client = this.adapter.client(action.plan.deploymentId);
              const pending = await client.getTransactionCount({
                address: action.identity.wallet,
                blockTag: "pending",
              });
              const latest = await client.getTransactionCount({
                address: action.identity.wallet,
                blockTag: "latest",
              });
              assert(
                pending === latest,
                "wallet_has_external_pending_transaction",
              );
              attempt = {
                stepId: step.id,
                status: "reserved",
                nonce: pending,
                transaction: tx,
                createdAt: Date.now(),
              };
              action.attempts.push(attempt);
              const savedAttempt = attempt;
              await atomic(c, async () => {
                savedAttempt.authorization = await this.store.authorize(
                  c,
                  action,
                  step,
                  true,
                );
                action.status =
                  action.mode === "manual" ? "awaiting_manual" : "running";
                delete action.reason;
                await this.store.save(c, action);
              });
            }
            if (action.mode === "manual") return action;
            assert(attempt.transaction, "transaction_missing");
            // Authorization locks remain held through sign-only. Nothing is broadcast by this API.
            const activeAttempt = attempt;
            await atomic(c, async () => {
              activeAttempt.authorization = await this.store.authorize(
                c,
                action,
                step,
                false,
              );
              assert(this.enabled(), "execution_disabled");
              const raw = await this.signer.sign(
                action.identity,
                activeAttempt.transaction!,
                activeAttempt.nonce,
              );
              activeAttempt.hash = await validateSignature(
                raw,
                action.identity,
                activeAttempt.transaction!,
                activeAttempt.nonce,
              );
              activeAttempt.encryptedRaw = this.vault.seal(
                raw,
                `${action.id}:${step.id}`,
              );
              activeAttempt.status = "signed";
              await this.store.save(c, action);
            });
            await this.broadcast(c, action, step, attempt);
            return action;
          } catch (error) {
            // Reload after rolled-back writes; never overwrite persisted submission evidence.
            action = await this.store.get(id, undefined, c);
            action.status = action.attempts.some(
              (a) => a.hash && !["confirmed", "reverted"].includes(a.status),
            )
              ? "reconciling"
              : "blocked";
            action.reason =
              error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message)
                ? error.message
                : "execution_blocked";
            await atomic(c, () => this.store.save(c, action));
            return action;
          }
        }
        action.status = "completed";
        delete action.reason;
        await atomic(c, () => this.store.save(c, action));
        return action;
      },
    );
  }
  async broadcast(c: PoolClient, action: Action, step: Step, attempt: Attempt) {
    assert(attempt.encryptedRaw && attempt.hash, "signed_evidence_missing");
    await atomic(c, async () => {
      // Recheck live deployment, plan bounds, authority, pause and cancellation before a new broadcast.
      const fresh = await this.store.get(action.id, undefined, c);
      assert(!fresh.cancelRequested && this.enabled(), "execution_paused");
      await this.adapter.validate(action.plan, step);
      await this.store.authorize(c, action, step, false);
      attempt.status = "submitted";
      action.status = "reconciling";
      await this.store.save(c, action);
    });
    // The exact hash and encrypted bytes are committed before any network submission.
    await c.query("SELECT 1");
    const raw = this.vault.open(
      attempt.encryptedRaw,
      `${action.id}:${step.id}`,
    ) as Hex;
    try {
      const result = await this.adapter
        .client(action.plan.deploymentId)
        .sendRawTransaction({ serializedTransaction: raw });
      assert(result === attempt.hash, "broadcast_hash_mismatch");
    } catch {
      attempt.status = "unresolved";
      action.reason = "submission_unresolved";
      await atomic(c, () => this.store.save(c, action));
    }
  }
  async reconcile(c: PoolClient, action: Action, step: Step, attempt: Attempt) {
    const client = this.adapter.client(action.plan.deploymentId);
    if (attempt.status === "signed" && action.cancelRequested) {
      // The submission marker is committed before broadcasting. A signed-only attempt has never left this service.
      action.status = "cancelled";
      await atomic(c, async () => {
        await this.store.settle(c, action, step, "0", "0");
        await this.store.save(c, action);
      });
      return false;
    }
    let receipt;
    try {
      receipt = await client.getTransactionReceipt({ hash: attempt.hash! });
    } catch {
      const consumed = await client.getTransactionCount({
        address: action.identity.wallet,
        blockTag: "latest",
      });
      if (consumed > attempt.nonce) {
        const tip = await client.getBlockNumber();
        const lower = tip > 64n ? tip - 64n : 0n;
        // Bounded automatic recovery; older replacements remain unresolved for explicit investigation.
        for (let number = tip > 1n ? tip - 1n : 0n; number >= lower; number--) {
          const block = await client.getBlock({
            blockNumber: number,
            includeTransactions: true,
          });
          const replacement = block.transactions.find(
            (tx) =>
              typeof tx !== "string" &&
              tx.from.toLowerCase() === action.identity.wallet &&
              tx.nonce === attempt.nonce,
          );
          if (replacement && typeof replacement !== "string") {
            const replacementReceipt = await client.getTransactionReceipt({
              hash: replacement.hash,
            });
            if (replacementReceipt.blockHash !== block.hash) break;
            attempt.originalHash ??= attempt.hash;
            attempt.replacementHashes ??= [];
            if (!attempt.replacementHashes.includes(replacement.hash))
              attempt.replacementHashes.push(replacement.hash);
            if (
              replacement.to?.toLowerCase() !== step.transaction.to ||
              replacement.input !== step.transaction.data ||
              replacement.value !== BigInt(step.transaction.value)
            ) {
              attempt.status = "reverted";
              action.status = "failed";
              action.reason = "nonce_replaced_by_different_transaction";
              await atomic(c, async () => {
                await this.store.settle(c, action, step, "0", "0");
                await this.store.save(c, action);
              });
              return false;
            }
            attempt.hash = replacement.hash;
            receipt = replacementReceipt;
            await atomic(c, () => this.store.save(c, action));
            break;
          }
          if (number === 0n) break;
        }
      }
      if (!receipt) {
        // Never classify a receipt timeout or RPC invisibility as definite failure.
        attempt.status = "unresolved";
        action.status = "reconciling";
        // Re-broadcast only a previously submitted transaction with unchanged bytes.
        if (attempt.encryptedRaw && !action.cancelRequested && this.enabled()) {
          try {
            await this.broadcast(c, action, step, attempt);
          } catch {
            action.reason = "reconciliation_pending";
          }
        }
        await atomic(c, () => this.store.save(c, action));
        return false;
      }
    }
    const block = await client.getBlockNumber();
    if (block < receipt.blockNumber + 1n) {
      action.status = "reconciling";
      return false;
    }
    const canonical = await client.getBlock({
      blockNumber: receipt.blockNumber,
    });
    if (canonical.hash !== receipt.blockHash) {
      action.status = "reconciling";
      return false;
    }
    const fee = String(receipt.gasUsed * receipt.effectiveGasPrice);
    attempt.blockNumber = String(receipt.blockNumber);
    attempt.actualFee = fee;
    if (receipt.status === "reverted") {
      attempt.status = "reverted";
      action.status = "failed";
      action.reason = "transaction_reverted";
      await atomic(c, async () => {
        await this.store.settle(c, action, step, "0", fee);
        await this.store.save(c, action);
      });
      return true;
    }
    try {
      attempt.result = await this.adapter.verify(action.plan, step, receipt);
    } catch {
      attempt.status = "unresolved";
      action.status = "reconciling";
      action.reason = "outcome_unverified";
      await atomic(c, () => this.store.save(c, action));
      return false;
    }
    attempt.status = "confirmed";
    delete action.reason;
    await atomic(c, async () => {
      await this.store.settle(c, action, step, step.principal, fee);
      await this.store.save(c, action);
    });
    return true;
  }
  async acceptManual(id: string, identity: Identity, raw: Hex) {
    const action = await this.store.get(id, identity);
    assert(action.mode === "manual", "manual_mode_required");
    return this.store.walletLock(
      identity.wallet,
      action.plan.chainId,
      async (c) => {
        const fresh = await this.store.get(id, identity, c);
        assert(
          !fresh.cancelRequested && fresh.status === "awaiting_manual",
          "manual_attempt_unavailable",
        );
        const attempt = fresh.attempts.find((a) => a.status === "reserved");
        assert(attempt?.transaction, "manual_attempt_missing");
        const step = fresh.plan.steps.find((s) => s.id === attempt.stepId)!;
        const hash = await validateSignature(
          raw,
          identity,
          attempt.transaction,
          attempt.nonce,
        );
        await atomic(c, async () => {
          assert(this.enabled(), "execution_disabled");
          await this.store.authorize(c, fresh, step, false);
          attempt.hash = hash;
          attempt.encryptedRaw = this.vault.seal(raw, `${id}:${step.id}`);
          attempt.status = "signed";
          await this.store.save(c, fresh);
        });
        await this.broadcast(c, fresh, step, attempt);
        return fresh;
      },
    );
  }
}
