import { vi } from "vitest";
import { keccak256, type PublicClient } from "viem";
import {
  StaticsAdapter,
  requiredSelectors,
  type Deployment,
} from "../src/statics.js";
import { stakeInput } from "../src/contracts.js";
export const wallet = "0x1111111111111111111111111111111111111111" as const;
export const diamond = "0x2222222222222222222222222222222222222222" as const;
export const token = "0x3333333333333333333333333333333333333333" as const;
export const deployment: Deployment = {
  id: "fixture",
  revision: "1",
  chainId: 31337,
  rpcEnvironment: "TEST_RPC",
  diamond,
  token,
  diamondHash: keccak256("0x01"),
  tokenHash: keccak256("0x01"),
  protocolCommit: "a".repeat(40),
  sdkCommit: "b".repeat(40),
  facets: requiredSelectors.map((selector) => ({
    selector,
    address: diamond,
    runtimeHash: keccak256("0x01"),
  })),
};
export const input = stakeInput.parse({
  kind: "statics.stake-existing",
  version: 1,
  deploymentId: "fixture",
  wallet,
  positionId: "42",
  amount: "100",
  maxFeePerTransaction: "1000000",
});
export function fixture(allowance = 0n) {
  const client = {
    getChainId: vi.fn(async () => 31337),
    getCode: vi.fn(async () => "0x01"),
    getBlockNumber: vi.fn(async () => 10n),
    getBalance: vi.fn(async () => 10n ** 18n),
    estimateFeesPerGas: vi.fn(async () => ({
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    })),
    call: vi.fn(async () => ({})),
    estimateGas: vi.fn(async () => 100n),
    readContract: vi.fn(
      async (args: { functionName: string }): Promise<unknown> => {
        switch (args.functionName) {
          case "facetAddress":
            return diamond;
          case "ownerOf":
            return wallet;
          case "balanceOf":
            return 1000n;
          case "allowance":
            return allowance;
          case "stakePosition":
            return { stakedBalance: 200n };
          default:
            throw new Error("unexpected_read");
        }
      },
    ),
  };
  return {
    client,
    adapter: new StaticsAdapter(
      [deployment],
      new Map([["fixture", client as unknown as PublicClient]]),
    ),
  };
}
