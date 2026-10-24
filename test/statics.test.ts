import { describe, it, expect, vi } from "vitest";
import {
  keccak256,
  parseAbi,
  encodeAbiParameters,
  encodeEventTopics,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import {
  StaticsAdapter,
  requiredSelectors,
  type Deployment,
} from "../src/statics.js";
import { digest, stakeInput } from "../src/contracts.js";
import { fixture, input, diamond, token, wallet } from "./fixtures.js";
describe("canonical Statics action", () => {
  it("builds a bounded exact approval and pins complete provenance", async () => {
    const { adapter } = fixture();
    const plan = await adapter.prepare(input);
    expect(plan.steps.map((s) => s.kind)).toEqual(["approval", "stake"]);
    expect(
      plan.steps[0].transaction.data.endsWith("64".padStart(64, "0")),
    ).toBe(true);
    const { digest: hash, ...body } = plan;
    expect(hash).toBe(digest(body));
    expect(plan.steps[0].principal).toBe("0");
  });
  it("omits approval when allowance suffices and requires simulation", async () => {
    const { adapter, client } = fixture(100n);
    const plan = await adapter.prepare(input);
    expect(plan.steps).toHaveLength(1);
    await adapter.validate(plan, plan.steps[0]);
    expect(client.call).toHaveBeenCalled();
  });
  it("rejects caller-supplied calldata and malformed amounts", () => {
    expect(() => stakeInput.parse({ ...input, calldata: "0x" })).toThrow();
    for (const amount of ["0", "-1", "1e18", "01"])
      expect(() => stakeInput.parse({ ...input, amount })).toThrow();
  });
  it("fails closed on wrong owner, upgraded facet, or insufficient fees", async () => {
    const { adapter, client } = fixture();
    client.getCode.mockResolvedValue("0x02");
    await expect(adapter.prepare(input)).rejects.toThrow("runtime_changed");
    client.getCode.mockResolvedValue("0x01");
    client.getBalance.mockResolvedValue(0n);
    await expect(adapter.prepare(input)).rejects.toThrow("fee_balance");
    client.getBalance.mockResolvedValue(10n ** 18n);
    const read = client.readContract.getMockImplementation()!;
    client.readContract.mockImplementation(async (args) =>
      args.functionName === "ownerOf" ? token : read(args),
    );
    await expect(adapter.prepare(input)).rejects.toThrow("position_not_owned");
  });
  it("does not report completion from a successful receipt alone", async () => {
    const { adapter } = fixture(100n),
      plan = await adapter.prepare(input);
    await expect(
      adapter.verify(plan, plan.steps[0], {
        status: "success",
        logs: [],
        blockNumber: 11n,
      } as unknown as TransactionReceipt),
    ).rejects.toThrow("stake_event_missing");
  });
  it("verifies the exact contract, position, payer, amount and resulting state", async () => {
    const { adapter } = fixture(100n),
      plan = await adapter.prepare(input);
    const abi = parseAbi([
      "event Staked(uint256 indexed positionId,address indexed payer,uint256 amount,uint256 totalPositionStake)",
    ]);
    const topics = encodeEventTopics({
      abi,
      eventName: "Staked",
      args: { positionId: 42n, payer: wallet },
    });
    const receipt = {
      status: "success",
      blockNumber: 11n,
      logs: [
        {
          address: diamond,
          topics,
          data: encodeAbiParameters(
            [{ type: "uint256" }, { type: "uint256" }],
            [100n, 200n],
          ),
        },
      ],
    } as unknown as TransactionReceipt;
    expect((await adapter.verify(plan, plan.steps[0], receipt)).amount).toBe(
      "100",
    );
  });
});
