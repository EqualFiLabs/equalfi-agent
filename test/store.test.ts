import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex, PublicClient, TransactionReceipt } from "viem";
import { Store } from "../src/store.js";
import { Executor, atomic, type Signer } from "../src/executor.js";
import { TransactionVault } from "../src/crypto.js";
import { Api } from "../src/api.js";
import { input, fixture, deployment } from "./fixtures.js";
import { StaticsAdapter } from "../src/statics.js";
import type {
  Identity,
  GrantInput,
  GlobalPolicy,
  Action,
} from "../src/contracts.js";

const database = process.env.TEST_DATABASE_URL;
describe.skipIf(!database)("PostgreSQL workflow and authority", () => {
  const store = new Store(database!);
  const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
  const identity: Identity = {
    userId: "test-app/did:privy:test",
    appId: "statics",
    wallet: account.address.toLowerCase() as Hex,
    privyWalletId: "fixture-wallet",
  };
  const global: GlobalPolicy = {
    wallet: identity.wallet,
    chainId: 31337,
    paused: false,
    dailyPrincipal: "150",
    dailyFees: "10000000",
  };
  const grant: GrantInput = {
    wallet: identity.wallet,
    chainId: 31337,
    deploymentId: "fixture",
    positions: ["42"],
    exactApprovals: true,
    maxPrincipalPerAction: "100",
    dailyPrincipal: "150",
    dailyFees: "10000000",
    expiresAt: Date.now() + 600_000,
  };
  beforeAll(async () => {
    await store.pool.query(readFileSync("migrations/001_base.sql", "utf8"));
  });
  beforeEach(async () => {
    await store.pool.query(
      "TRUNCATE agent_events,agent_reservations,agent_actions,agent_policies,agent_budgets,agent_messages,agent_conversations,agent_usage,agent_rate_limits RESTART IDENTITY CASCADE",
    );
    await store.setPolicy(identity, 31337, "*", global);
    await store.setPolicy(identity, 31337, "statics", {
      ...grant,
      active: true,
    });
  });
  afterAll(async () => {
    await store.pool.end();
  });
  async function action(
    key: string,
    mode: "delegated" | "manual" = "delegated",
  ) {
    const { adapter } = fixture(100n);
    return store.create(identity, key, mode, await adapter.prepare(input));
  }
  it("keeps request keys independent of content hashes", async () => {
    const first = await action("one"),
      again = await action("one"),
      second = await action("two");
    expect(first.id).toBe(again.id);
    expect(second.id).not.toBe(first.id);
    const { adapter } = fixture(100n);
    await expect(
      store.create(identity, "one", "manual", await adapter.prepare(input)),
    ).rejects.toThrow("intent_key_conflict");
  });
  it("atomically caps simultaneous reservations and does not count approvals as principal", async () => {
    const a = await action("a"),
      b = await action("b");
    const results = await Promise.allSettled(
      [a, b].map((a) =>
        store.transaction((c) => store.authorize(c, a, a.plan.steps[0], true)),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const budget = await store.pool.query(
      "SELECT sum(reserved)::text AS value FROM agent_budgets WHERE scope='*' AND asset='STATICS'",
    );
    expect(budget.rows[0].value).toBe("100");
  });
  it("rechecks reduced limits and revocation with a reservation already present", async () => {
    const a = await action("reduce");
    await store.transaction((c) =>
      store.authorize(c, a, a.plan.steps[0], true),
    );
    await store.setPolicy(identity, 31337, "*", {
      ...global,
      dailyPrincipal: "50",
    });
    await expect(
      store.transaction((c) => store.authorize(c, a, a.plan.steps[0], false)),
    ).rejects.toThrow("reduced_budget");
    await store.setPolicy(identity, 31337, "statics", { active: false });
    await expect(
      store.transaction((c) => store.authorize(c, a, a.plan.steps[0], false)),
    ).rejects.toThrow("grant_inactive");
  });
  it("settles once and charges the receipt fee without double counting principal", async () => {
    const a = await action("settle"),
      step = a.plan.steps[0];
    await store.transaction((c) => store.authorize(c, a, step, true));
    await store.transaction(async (c) => {
      await store.settle(c, a, step, "100", "240");
      await store.settle(c, a, step, "100", "240");
    });
    const rows = (
      await store.pool.query(
        "SELECT asset,spent::text,reserved::text FROM agent_budgets WHERE scope='*' ORDER BY asset",
      )
    ).rows;
    expect(rows).toEqual([
      { asset: "STATICS", spent: "100", reserved: "0" },
      { asset: "native-fees", spent: "240", reserved: "0" },
    ]);
  });
  it("fences concurrent wallet workers with a session lock", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const entered = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const first = store.walletLock(identity.wallet, 31337, async () => {
      acquired();
      await hold;
    });
    await entered;
    expect(
      await store.walletLock(identity.wallet, 31337, async () => true),
    ).toBeUndefined();
    release();
    await first;
  });
  it("rejects stale action versions and scopes status/events to owner and app", async () => {
    const a = await action("version"),
      copy = structuredClone(a);
    await store.transaction((c) => store.save(c, a));
    await expect(store.transaction((c) => store.save(c, copy))).rejects.toThrow(
      "stale_action",
    );
    await expect(
      store.get(a.id, { ...identity, userId: "another" }),
    ).rejects.toThrow("not_found");
    expect(await store.events({ ...identity, appId: "eves" }, 0)).toEqual([]);
    expect(JSON.stringify(await store.events(identity, 0))).not.toContain(
      "encryptedRaw",
    );
  });
  async function execution(allowance = 100n) {
    const f = fixture(allowance),
      original = f.client.readContract.getMockImplementation()!;
    f.client.readContract.mockImplementation(async (args) =>
      args.functionName === "ownerOf" ? identity.wallet : original(args),
    );
    const receipt = vi.fn(async (): Promise<TransactionReceipt> => {
      throw new Error("not_found");
    });
    const client = Object.assign(f.client, {
      getTransactionCount: vi.fn(async () => 0),
      getTransactionReceipt: receipt,
      sendRawTransaction: vi.fn(
        async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
          const { keccak256 } = await import("viem");
          return keccak256(serializedTransaction);
        },
      ),
      getBlock: vi.fn(async () => ({ hash: `0x${"aa".repeat(32)}` })),
    });
    const adapter = new StaticsAdapter(
      [deployment],
      new Map([["fixture", client as unknown as PublicClient]]),
    );
    const signer: Signer = {
      sign: vi.fn(async (_identity, tx, nonce) =>
        account.signTransaction({
          chainId: tx.chainId,
          to: tx.to,
          data: tx.data,
          value: BigInt(tx.value),
          gas: BigInt(tx.gas),
          maxFeePerGas: BigInt(tx.maxFeePerGas),
          maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
          nonce,
        }),
      ),
    };
    const a = await store.create(
      identity,
      "execute",
      "delegated",
      await adapter.prepare({ ...input, wallet: identity.wallet }),
    );
    const executor = new Executor(
      store,
      adapter,
      new TransactionVault(Buffer.alloc(32, 1)),
      signer,
      () => true,
    );
    return { a, executor, client, signer, adapter, receipt };
  }
  it("persists signed evidence before broadcast and restarts without another signature", async () => {
    const { a, executor, client, signer } = await execution();
    client.sendRawTransaction.mockImplementation(async () => {
      const saved = await store.get(a.id);
      expect(saved.attempts[0].encryptedRaw).toBeTruthy();
      expect(saved.attempts[0].hash).toBeTruthy();
      throw new Error("rpc_timeout");
    });
    await executor.run(a.id);
    const saved = await store.get(a.id);
    expect(saved.status).toBe("reconciling");
    expect(saved.attempts[0].status).toBe("unresolved");
    await executor.run(a.id);
    expect(signer.sign).toHaveBeenCalledTimes(1);
    expect(
      new Set(
        client.sendRawTransaction.mock.calls.map(
          (c) => c[0].serializedTransaction,
        ),
      ).size,
    ).toBe(1);
  });
  it("does not sign when durable authorization fails", async () => {
    const { a, executor, signer } = await execution();
    await store.setPolicy(identity, 31337, "*", { ...global, paused: true });
    await executor.run(a.id);
    expect(signer.sign).not.toHaveBeenCalled();
    expect((await store.get(a.id)).status).toBe("blocked");
  });
  it("stops the stake after an approval when its grant is revoked", async () => {
    const { a, executor, signer, adapter, receipt, client } =
      await execution(0n);
    await executor.run(a.id);
    expect(signer.sign).toHaveBeenCalledTimes(1);
    adapter.verify = vi.fn(async () => ({ allowance: "100" }));
    receipt.mockResolvedValue({
      status: "success",
      blockNumber: 9n,
      blockHash: `0x${"aa".repeat(32)}`,
      gasUsed: 100n,
      effectiveGasPrice: 2n,
    } as TransactionReceipt);
    const original = client.readContract.getMockImplementation()!;
    client.readContract.mockImplementation(async (args) =>
      args.functionName === "allowance" ? 100n : original(args),
    );
    await store.setPolicy(identity, 31337, "statics", { active: false });
    await executor.run(a.id);
    expect(signer.sign).toHaveBeenCalledTimes(1);
    expect((await store.get(a.id)).attempts[0].status).toBe("confirmed");
    expect((await store.get(a.id)).status).toBe("blocked");
  });
  it("cancels manual reservations without stranding the wallet or budget", async () => {
    const { a, executor, adapter, signer } = await execution();
    const manual = await store.get(a.id);
    manual.mode = "manual";
    await store.transaction((c) => store.save(c, manual));
    await executor.run(a.id);
    expect((await store.get(a.id)).status).toBe("awaiting_manual");
    const api = new Api(store, adapter, { verify: async () => identity });
    await api.route("POST", `/v1/actions/${a.id}/cancel`, new Headers(), {});
    await executor.run(a.id);
    const cancelled = await store.get(a.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.attempts[0].status).toBe("cancelled");
    expect(signer.sign).not.toHaveBeenCalled();
    const budget = await store.pool.query(
      "SELECT sum(reserved)::text AS reserved FROM agent_budgets",
    );
    expect(budget.rows[0].reserved).toBe("0");
    const second = await store.create(
      identity,
      "after-cancel",
      "delegated",
      await adapter.prepare({ ...input, wallet: identity.wallet }),
    );
    await executor.run(second.id);
    expect((await store.get(second.id)).status).toBe("reconciling");
  });
  it("cancels a proposal without executing it", async () => {
    const { adapter } = await execution();
    const a = await store.create(
      identity,
      "proposal",
      "proposal",
      await adapter.prepare({ ...input, wallet: identity.wallet }),
    );
    const api = new Api(store, adapter, { verify: async () => identity });
    await api.route("POST", `/v1/actions/${a.id}/cancel`, new Headers(), {});
    const executor = new Executor(
      store,
      adapter,
      new TransactionVault(Buffer.alloc(32)),
      { sign: vi.fn() },
      () => true,
    );
    await executor.run(a.id);
    expect((await store.get(a.id)).status).toBe("cancelled");
  });
  it("rejects replacement payloads and preserves idempotent API intent identity", async () => {
    const { adapter } = await execution();
    const api = new Api(store, adapter, { verify: async () => identity });
    const body = {
      intentKey: "api",
      mode: "proposal",
      input: { ...input, wallet: identity.wallet },
    };
    const a = await api.create(identity, body);
    expect((await api.create(identity, body)).id).toBe(a.id);
    await expect(
      api.route("POST", `/v1/actions/${a.id}/execute`, new Headers(), {
        planDigest: a.plan.digest,
        mode: "manual",
        to: identity.wallet,
      }),
    ).rejects.toThrow();
    await expect(
      api.activate(identity, a.id, "stale", "manual"),
    ).rejects.toThrow("revision_conflict");
    const other = new Api(store, adapter, {
      verify: async () => ({ ...identity, appId: "eves" }),
    });
    await expect(
      other.route("GET", `/v1/actions/${a.id}`, new Headers(), {}),
    ).rejects.toThrow("not_found");
  });
  it("keeps consumed nonces unresolved until a canonical replacement is observed", async () => {
    const { a, executor, client, signer } = await execution();
    await executor.run(a.id);
    client.getTransactionCount.mockResolvedValue(1);
    client.getBlock.mockResolvedValue({
      hash: `0x${"aa".repeat(32)}`,
      transactions: [],
    } as never);
    await executor.run(a.id);
    expect((await store.get(a.id)).status).toBe("reconciling");
    expect(signer.sign).toHaveBeenCalledOnce();
  });
  it("establishes a different canonical nonce replacement without charging staking principal", async () => {
    const { a, executor, client, receipt } = await execution();
    await executor.run(a.id);
    const hash = `0x${"bb".repeat(32)}` as Hex;
    client.getTransactionCount.mockResolvedValue(1);
    client.getBlock.mockResolvedValue({
      hash: `0x${"aa".repeat(32)}`,
      transactions: [
        {
          from: identity.wallet,
          nonce: 0,
          to: identity.wallet,
          input: "0x",
          value: 0n,
          hash,
        },
      ],
    } as never);
    receipt.mockImplementation(async (args?: unknown) => {
      if ((args as { hash: Hex })?.hash !== hash) throw new Error("missing");
      return { blockHash: `0x${"aa".repeat(32)}` } as TransactionReceipt;
    });
    await executor.run(a.id);
    expect((await store.get(a.id)).reason).toBe(
      "nonce_replaced_by_different_transaction",
    );
    const budgets = await store.pool.query(
      "SELECT sum(reserved+spent)::text AS total FROM agent_budgets WHERE asset='STATICS'",
    );
    expect(budgets.rows[0].total).toBe("0");
  });
  it("shares request throttling across apps for one identity", async () => {
    for (let i = 0; i < 120; i++) await store.rateLimit(identity);
    await expect(
      store.rateLimit({ ...identity, appId: "eves" }),
    ).rejects.toThrow("request_rate_limit");
  });
});
