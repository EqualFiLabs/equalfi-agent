// Local fixtures only: this script never sends to a production/testnet RPC.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  http,
  erc20Abi,
  encodeFunctionData,
  parseEventLogs,
  parseEther,
  keccak256,
  parseAbi,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  buildCreateAndStakeCall,
  staticsAbi,
} from "@statics-protocol/sdk/phase-one";
import { Store } from "../dist/src/store.js";
import {
  StaticsAdapter,
  requiredSelectors,
  delegateTarget,
} from "../dist/src/statics.js";
import { Executor } from "../dist/src/executor.js";
import { TransactionVault } from "../dist/src/crypto.js";

const rpc = process.env.REHEARSAL_RPC ?? "http://127.0.0.1:18591";
const database = process.env.REHEARSAL_DATABASE_URL;
if (
  new URL(rpc).hostname !== "127.0.0.1" ||
  !database ||
  new URL(database).hostname !== "127.0.0.1" ||
  !new URL(database).pathname.startsWith("/agent_rehearsal")
)
  throw new Error("isolated_local_rehearsal_required");
const client = createPublicClient({ transport: http(rpc), cacheTime: 0 });
if ((await client.getChainId()) !== 31337)
  throw new Error("local_chain_31337_required");
const forkInfo = await client.request({ method: "anvil_nodeInfo", params: [] });
const forkBlock = String(forkInfo.forkConfig?.forkBlockNumber ?? "unknown");
const startBlock = String(await client.getBlockNumber());
const published = await (
  await fetch("https://staticsprotocol.com/api/deployments")
).json();
const manifest = Object.values(
  published.manifests.phaseOne ?? published.manifests["phase-one"] ?? {},
).find((m) => m.chainId === 4663);
if (!manifest) throw new Error("phase_one_manifest_missing");
const diamond = manifest.contracts.diamond.address.toLowerCase(),
  token = manifest.contracts.statics.address.toLowerCase();
const loupe = parseAbi([
  "function facetAddress(bytes4 selector) view returns (address)",
]);
const facets = [];
for (const selector of requiredSelectors) {
  const address = (
    await client.readContract({
      address: diamond,
      abi: loupe,
      functionName: "facetAddress",
      args: [selector],
    })
  ).toLowerCase();
  facets.push({
    selector,
    address,
    runtimeHash: keccak256((await client.getCode({ address })) ?? "0x"),
  });
}
const deployment = {
  id: "local-statics-rehearsal",
  revision: published.revision,
  chainId: 31337,
  rpcEnvironment: "REHEARSAL_RPC",
  diamond,
  token,
  diamondHash: keccak256(await client.getCode({ address: diamond })),
  tokenHash: keccak256(await client.getCode({ address: token })),
  protocolCommit: manifest.protocolCommit,
  sdkCommit: manifest.sdkCommit,
  facets,
  dependencies: [],
};
let dependency = delegateTarget(await client.getCode({ address: token }));
while (dependency && deployment.dependencies.length < 20) {
  const code = await client.getCode({ address: dependency });
  deployment.dependencies.push({
    address: dependency,
    runtimeHash: keccak256(code),
  });
  dependency = delegateTarget(code);
}
// Fresh disposable local fixture avoids collisions with past unresolved rehearsals.
const account = privateKeyToAccount(generatePrivateKey());
await client.request({
  method: "anvil_setBalance",
  params: [account.address, "0x56bc75e2d63100000"],
});
const wallet = createWalletClient({ account, transport: http(rpc) });
// The public Anvil address may have an EIP-7702 delegation on the upstream chain.
// Clear only this local fixture's code so creation behaves as an EOA fixture.
await client.request({
  method: "anvil_setCode",
  params: [account.address, "0x"],
});
const fixtureAmount = parseEther("1000");
// Non-custodial holder observed on the fork. Never borrow protocol escrow.
const fixtureSource = "0x445aD4bC7A8C19d61b73f63d2dC2AA40fFa2188F";
if (await client.getCode({ address: fixtureSource }))
  throw new Error("fixture_source_must_be_eoa");
if (
  (await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [fixtureSource],
  })) < fixtureAmount
)
  throw new Error("fork_fixture_source_insufficient");
await client.request({
  method: "anvil_setBalance",
  params: [fixtureSource, "0x56bc75e2d63100000"],
});
await client.request({
  method: "anvil_impersonateAccount",
  params: [fixtureSource],
});
const seed = await client.request({
  method: "eth_sendTransaction",
  params: [
    {
      from: fixtureSource,
      to: token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [account.address, fixtureAmount],
      }),
    },
  ],
});
await client.waitForTransactionReceipt({ hash: seed });
await client.request({
  method: "anvil_stopImpersonatingAccount",
  params: [fixtureSource],
});
const fee = await client.readContract({
  address: diamond,
  abi: staticsAbi,
  functionName: "positionCreationFee",
});
const approval = await wallet.sendTransaction({
  chain: null,
  to: token,
  data: encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [diamond, parseEther("1")],
  }),
  value: 0n,
});
await client.waitForTransactionReceipt({ hash: approval });
const created = await wallet.sendTransaction({
  chain: null,
  to: diamond,
  data: buildCreateAndStakeCall(parseEther("1"), account.address, []),
  value: fee,
});
const creation = await client.waitForTransactionReceipt({ hash: created });
const event = parseEventLogs({
  abi: staticsAbi,
  eventName: "StakingPositionCreated",
  logs: creation.logs,
}).find(
  (e) =>
    e.address.toLowerCase() === diamond &&
    e.args.owner.toLowerCase() === account.address.toLowerCase(),
);
if (!event) throw new Error("fixture_position_creation_failed");
const store = new Store(database);
await store.pool.query(
  await readFile(
    new URL("../migrations/001_base.sql", import.meta.url),
    "utf8",
  ),
);
const identity = {
  userId: `local-fixture/${randomUUID()}`,
  appId: "statics",
  wallet: account.address.toLowerCase(),
};
const input = {
  kind: "statics.stake-existing",
  version: 1,
  deploymentId: deployment.id,
  wallet: identity.wallet,
  positionId: String(event.args.positionId),
  amount: String(parseEther("100")),
  maxFeePerTransaction: String(parseEther("0.01")),
};
const adapter = new StaticsAdapter(
  [deployment],
  new Map([[deployment.id, client]]),
);
await store.setPolicy(identity, 31337, "*", {
  wallet: identity.wallet,
  chainId: 31337,
  paused: false,
  dailyPrincipal: String(parseEther("1000")),
  dailyFees: String(parseEther("0.1")),
});
await store.setPolicy(identity, 31337, "statics", {
  wallet: identity.wallet,
  chainId: 31337,
  deploymentId: deployment.id,
  positions: [input.positionId],
  exactApprovals: true,
  maxPrincipalPerAction: input.amount,
  dailyPrincipal: String(parseEther("1000")),
  dailyFees: String(parseEther("0.1")),
  expiresAt: Date.now() + 300000,
  active: true,
});
const action = await store.create(
  identity,
  randomUUID(),
  "delegated",
  await adapter.prepare(input),
);
const signer = {
  sign: async (_identity, tx, nonce) =>
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
};
let executor = new Executor(
  store,
  adapter,
  new TransactionVault(Buffer.alloc(32, 7)),
  signer,
  () => true,
);
for (let iteration = 0; iteration < 8; iteration++) {
  await executor.run(action.id);
  await client.request({ method: "evm_mine", params: [] });
  // Recreate the worker after submission. Durable evidence, not process memory, carries progress.
  executor = new Executor(
    store,
    adapter,
    new TransactionVault(Buffer.alloc(32, 7)),
    signer,
    () => true,
  );
  if ((await store.get(action.id)).status === "completed") break;
}
const result = await store.get(action.id);
const evidence = {
  environment: "local Robinhood fork, chain 31337",
  forkBlock,
  startBlock,
  publishedRevision: published.revision,
  protocolCommit: manifest.protocolCommit,
  sdkCommit: manifest.sdkCommit,
  fixtureSource,
  fixture:
    "STATICS seeded from a non-custodial EOA on this disposable fork; position created locally",
  signer: "ephemeral local fixture account; NOT Privy",
  actionId: result.id,
  status: result.status,
  reason: result.reason,
  positionId: input.positionId,
  amount: input.amount,
  attempts: result.attempts.map(({ encryptedRaw, ...a }) => a),
  deployment,
  receipts: await Promise.all(
    result.attempts
      .filter((a) => a.hash)
      .map((a) => client.getTransactionReceipt({ hash: a.hash })),
  ),
};
await mkdir(new URL("../.local/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../.local/fork-evidence.json", import.meta.url),
  JSON.stringify(
    evidence,
    (_key, value) => (typeof value === "bigint" ? String(value) : value),
    2,
  ),
);
await store.pool.end();
console.log(
  JSON.stringify(
    {
      status: result.status,
      reason: result.reason,
      forkBlock,
      actionId: result.id,
      steps: result.attempts.map((a) => ({
        step: a.stepId,
        status: a.status,
        hash: a.hash,
        result: a.result,
      })),
    },
    null,
    2,
  ),
);
if (result.status !== "completed") process.exitCode = 1;
