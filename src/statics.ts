import { readFileSync } from "node:fs";
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  toFunctionSelector,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { buildStakeCall, staticsAbi } from "@statics-protocol/sdk/phase-one";
import {
  assert,
  digest,
  stakeInput,
  type Plan,
  type Step,
  type StakeInput,
  type Transaction,
} from "./contracts.js";
import { z } from "zod";
import { address, hash } from "./contracts.js";

const loupeAbi = parseAbi([
  "function facetAddress(bytes4 selector) view returns (address)",
]);
const deploymentSchema = z
  .object({
    id: z.string().min(1),
    revision: z.string().min(1),
    chainId: z.number().int().positive(),
    rpcEnvironment: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    diamond: address,
    token: address,
    diamondHash: hash,
    tokenHash: hash,
    protocolCommit: z.string().regex(/^[a-f0-9]{40}$/),
    sdkCommit: z.string().regex(/^[a-f0-9]{40}$/),
    facets: z
      .array(
        z.object({
          selector: z.string().regex(/^0x[0-9a-f]{8}$/),
          address,
          runtimeHash: hash,
        }),
      )
      .min(3),
  })
  .strict();
export type Deployment = z.infer<typeof deploymentSchema>;
export const requiredSelectors = [
  "stake(uint256,uint256)",
  "stakePosition(uint256)",
  "ownerOf(uint256)",
].map(toFunctionSelector);
export class StaticsAdapter {
  constructor(
    readonly deployments: Deployment[],
    readonly clients: Map<string, PublicClient>,
  ) {}
  static fromFile(path: string) {
    const deployments = z
      .array(deploymentSchema)
      .min(1)
      .parse(JSON.parse(readFileSync(path, "utf8")));
    assert(
      new Set(deployments.map((d) => d.id)).size === deployments.length,
      "duplicate_deployment",
    );
    return new StaticsAdapter(
      deployments,
      new Map(
        deployments.map((d) => {
          const rpc = process.env[d.rpcEnvironment];
          assert(rpc, "private_rpc_missing");
          return [
            d.id,
            createPublicClient({
              cacheTime: 0,
              transport: http(rpc, { timeout: 15_000, retryCount: 1 }),
            }) as PublicClient,
          ];
        }),
      ),
    );
  }
  deployment(id: string) {
    const deployment = this.deployments.find((d) => d.id === id);
    assert(deployment, "unsupported_deployment");
    return deployment;
  }
  client(id: string): PublicClient {
    const client = this.clients.get(id);
    assert(client, "rpc_unavailable");
    return client;
  }
  async verifyDeployment(id: string, blockNumber?: bigint) {
    const d = this.deployment(id),
      client = this.client(id);
    assert((await client.getChainId()) === d.chainId, "chain_mismatch");
    for (const selector of requiredSelectors)
      assert(
        d.facets.some((f) => f.selector === selector),
        "missing_selector_provenance",
      );
    for (const [target, expected] of [
      [d.diamond, d.diamondHash],
      [d.token, d.tokenHash],
    ] as const) {
      const code = await client.getCode({ address: target, blockNumber });
      assert(code && keccak256(code) === expected, "contract_runtime_changed");
    }
    for (const f of d.facets) {
      const actual = await client.readContract({
        address: d.diamond,
        abi: loupeAbi,
        functionName: "facetAddress",
        args: [f.selector as Hex],
        blockNumber,
      });
      assert(actual.toLowerCase() === f.address, "facet_selector_changed");
      const code = await client.getCode({ address: f.address, blockNumber });
      assert(
        code && keccak256(code) === f.runtimeHash,
        "facet_runtime_changed",
      );
    }
  }
  async state(input: StakeInput, blockNumber?: bigint) {
    const d = this.deployment(input.deploymentId),
      client = this.client(d.id);
    const [owner, balance, allowance, native, position] = await Promise.all([
      client.readContract({
        address: d.diamond,
        abi: staticsAbi,
        functionName: "ownerOf",
        args: [BigInt(input.positionId)],
        blockNumber,
      }),
      client.readContract({
        address: d.token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [input.wallet],
        blockNumber,
      }),
      client.readContract({
        address: d.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [input.wallet, d.diamond],
        blockNumber,
      }),
      client.getBalance({ address: input.wallet, blockNumber }),
      client.readContract({
        address: d.diamond,
        abi: staticsAbi,
        functionName: "stakePosition",
        args: [BigInt(input.positionId)],
        blockNumber,
      }),
    ]);
    assert(owner.toLowerCase() === input.wallet, "position_not_owned");
    return { balance, allowance, native, stake: position.stakedBalance };
  }
  async prepare(raw: unknown): Promise<Plan> {
    const input = stakeInput.parse(raw),
      d = this.deployment(input.deploymentId),
      client = this.client(d.id);
    const block = await client.getBlockNumber();
    await this.verifyDeployment(d.id, block);
    const state = await this.state(input, block);
    assert(state.balance >= BigInt(input.amount), "insufficient_statics");
    const fees = await client.estimateFeesPerGas();
    assert(
      fees.maxFeePerGas !== undefined &&
        fees.maxPriorityFeePerGas !== undefined,
      "eip1559_fees_unavailable",
    );
    const tx = (to: Address, data: Hex): Transaction => ({
      chainId: d.chainId,
      to,
      data,
      value: "0",
      gas: "0",
      maxFeePerGas: String(fees.maxFeePerGas),
      maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas),
    });
    const steps: Step[] = [];
    if (state.allowance < BigInt(input.amount))
      steps.push({
        id: "approval",
        kind: "approval",
        principal: "0",
        maxFee: input.maxFeePerTransaction,
        transaction: tx(
          d.token,
          encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [d.diamond, BigInt(input.amount)],
          }),
        ),
      });
    steps.push({
      id: "stake",
      kind: "stake",
      principal: input.amount,
      maxFee: input.maxFeePerTransaction,
      transaction: tx(
        d.diamond,
        buildStakeCall(BigInt(input.positionId), BigInt(input.amount)),
      ),
    });
    // Stake gas cannot be simulated before approval. It is estimated and bounded immediately before signing.
    assert(
      state.native >= BigInt(input.maxFeePerTransaction) * BigInt(steps.length),
      "insufficient_fee_balance",
    );
    const base = {
      deployment: d,
      schemaVersion: 1 as const,
      actionVersion: 1 as const,
      adapterVersion: "statics/1",
      deploymentId: d.id,
      deploymentRevision: digest(d),
      chainId: d.chainId,
      input,
      preparedAt: Date.now(),
      expiresAt: Date.now() + 300_000,
      observedBlock: String(block),
      steps,
    };
    return { ...base, digest: digest(base) };
  }
  async readAccount(
    deploymentId: string,
    wallet: Address,
    positionId?: string,
    cursor = "0",
  ) {
    const d = this.deployment(deploymentId),
      client = this.client(d.id),
      blockNumber = await client.getBlockNumber();
    await this.verifyDeployment(d.id, blockNumber);
    const [balance, native, positions] = await Promise.all([
      client.readContract({
        address: d.token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet],
        blockNumber,
      }),
      client.getBalance({ address: wallet, blockNumber }),
      client.readContract({
        address: d.diamond,
        abi: staticsAbi,
        functionName: "positionsOfOwner",
        args: [wallet, BigInt(cursor), 25n],
        blockNumber,
      }),
    ]);
    let position: unknown = null;
    if (positionId) {
      const state = await this.state(
        {
          ...stakeInput.parse({
            kind: "statics.stake-existing",
            version: 1,
            deploymentId,
            wallet,
            positionId,
            amount: "1",
            maxFeePerTransaction: "1",
          }),
        },
        blockNumber,
      );
      const assets = await client.readContract({
        address: d.diamond,
        abi: staticsAbi,
        functionName: "positionRewardAssets",
        args: [BigInt(positionId)],
        blockNumber,
      });
      assert(assets.length <= 100, "reward_asset_read_limit");
      const rewards = assets.length
        ? await client.readContract({
            address: d.diamond,
            abi: staticsAbi,
            functionName: "pendingRewards",
            args: [BigInt(positionId), assets],
            account: wallet,
            blockNumber,
          })
        : [];
      position = {
        id: positionId,
        stake: String(state.stake),
        allowance: String(state.allowance),
        selectedAssets: assets,
        pendingRewards: rewards.map(String),
      };
    }
    return {
      deploymentId,
      chainId: d.chainId,
      blockNumber: String(blockNumber),
      wallet,
      balance: String(balance),
      native: String(native),
      ownedPositions: positions[0].map(String),
      nextCursor: String(positions[1]),
      position,
    };
  }
  async validate(plan: Plan, step: Step): Promise<Transaction> {
    assert(
      plan.adapterVersion === "statics/1" && plan.actionVersion === 1,
      "unsupported_adapter",
    );
    const { digest: expected, ...base } = plan;
    assert(digest(base) === expected, "plan_digest_mismatch");
    assert(plan.expiresAt > Date.now(), "plan_expired");
    const d = plan.deployment,
      client = this.client(d.id);
    assert(
      plan.deploymentRevision === digest(this.deployment(plan.deploymentId)),
      "deployment_revision_changed",
    );
    await this.verifyDeployment(d.id);
    const state = await this.state(plan.input);
    assert(state.balance >= BigInt(plan.input.amount), "insufficient_statics");
    const expectedData =
      step.kind === "approval"
        ? encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [d.diamond, BigInt(plan.input.amount)],
          })
        : buildStakeCall(
            BigInt(plan.input.positionId),
            BigInt(plan.input.amount),
          );
    assert(
      step.transaction.to ===
        (step.kind === "approval" ? d.token : d.diamond) &&
        step.transaction.data === expectedData &&
        step.transaction.value === "0" &&
        step.transaction.chainId === d.chainId,
      "untrusted_transaction",
    );
    if (step.kind === "stake")
      assert(state.allowance >= BigInt(plan.input.amount), "approval_required");
    await client.call({
      account: plan.input.wallet,
      to: step.transaction.to,
      data: step.transaction.data,
      value: 0n,
    });
    const gas =
      ((await client.estimateGas({
        account: plan.input.wallet,
        to: step.transaction.to,
        data: step.transaction.data,
        value: 0n,
      })) *
        120n) /
      100n;
    const fee = gas * BigInt(step.transaction.maxFeePerGas);
    assert(
      fee <= BigInt(step.maxFee) && state.native >= fee,
      "fee_limit_exceeded",
    );
    return { ...step.transaction, gas: String(gas) };
  }
  async verify(
    plan: Plan,
    step: Step,
    receipt: TransactionReceipt,
  ): Promise<Record<string, string>> {
    assert(receipt.status === "success", "transaction_reverted");
    const d = plan.deployment,
      client = this.client(d.id);
    assert(
      (await client.getChainId()) === plan.chainId,
      "recovery_chain_mismatch",
    );
    if (step.kind === "approval") {
      const logs = parseEventLogs({
        abi: erc20Abi,
        eventName: "Approval",
        logs: receipt.logs,
      });
      assert(
        logs.some(
          (e) =>
            e.address.toLowerCase() === d.token &&
            e.args.owner.toLowerCase() === plan.input.wallet &&
            e.args.spender.toLowerCase() === d.diamond &&
            e.args.value === BigInt(plan.input.amount),
        ),
        "approval_event_missing",
      );
      const allowance = await client.readContract({
        address: d.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [plan.input.wallet, d.diamond],
        blockNumber: receipt.blockNumber,
      });
      assert(allowance >= BigInt(plan.input.amount), "approval_state_missing");
      return { allowance: String(allowance) };
    }
    const event = parseEventLogs({
      abi: staticsAbi,
      eventName: "Staked",
      logs: receipt.logs,
    }).find(
      (e) =>
        e.address.toLowerCase() === d.diamond &&
        e.args.positionId === BigInt(plan.input.positionId) &&
        e.args.payer.toLowerCase() === plan.input.wallet &&
        e.args.amount === BigInt(plan.input.amount),
    );
    assert(event, "stake_event_missing");
    const position = await client.readContract({
      address: d.diamond,
      abi: staticsAbi,
      functionName: "stakePosition",
      args: [BigInt(plan.input.positionId)],
      blockNumber: receipt.blockNumber,
    });
    assert(
      position.stakedBalance >= event.args.totalPositionStake,
      "stake_state_missing",
    );
    return {
      positionId: plan.input.positionId,
      amount: plan.input.amount,
      totalPositionStake: String(event.args.totalPositionStake),
    };
  }
}
