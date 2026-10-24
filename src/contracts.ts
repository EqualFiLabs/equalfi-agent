import { createHash } from "node:crypto";
import { z } from "zod";
import type { Address, Hex } from "viem";
import type { Deployment } from "./statics.js";

export const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((v) => BigInt(v) < 2n ** 256n);
export const positive = uint.refine((v) => BigInt(v) > 0n);
export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v.toLowerCase() as Address);
export const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((v) => v.toLowerCase() as Hex);
export const stakeInput = z
  .object({
    kind: z.literal("statics.stake-existing"),
    version: z.literal(1),
    deploymentId: z.string().min(1).max(100),
    wallet: address,
    positionId: positive,
    amount: positive,
    maxFeePerTransaction: positive,
  })
  .strict();
export type StakeInput = z.infer<typeof stakeInput>;
export type Identity = {
  userId: string;
  appId: string;
  wallet: Address;
  privyWalletId?: string;
};
export type Mode = "proposal" | "manual" | "delegated";
export type Status =
  | "preparing"
  | "ready"
  | "running"
  | "reconciling"
  | "completed"
  | "needs_input"
  | "awaiting_manual"
  | "blocked"
  | "cancelled"
  | "failed";
export type Transaction = {
  chainId: number;
  to: Address;
  data: Hex;
  value: string;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
};
export type Step = {
  id: string;
  kind: "approval" | "stake";
  transaction: Transaction;
  principal: string;
  maxFee: string;
  expectedAllowance?: string;
};
export type Plan = {
  deployment: Deployment;
  schemaVersion: 1;
  actionVersion: 1;
  adapterVersion: string;
  deploymentId: string;
  deploymentRevision: string;
  chainId: number;
  input: StakeInput;
  preparedAt: number;
  expiresAt: number;
  observedBlock: string;
  steps: Step[];
  digest: string;
};
export type Attempt = {
  stepId: string;
  status:
    | "reserved"
    | "signed"
    | "submitted"
    | "confirmed"
    | "reverted"
    | "unresolved";
  nonce: number;
  hash?: Hex;
  originalHash?: Hex;
  replacementHashes?: Hex[];
  encryptedRaw?: string;
  blockNumber?: string;
  actualFee?: string;
  result?: Record<string, string>;
  manualToken?: string;
  createdAt: number;
  transaction?: Transaction;
  authorization?: { globalVersion: number; grantVersion?: number };
};
export type Action = {
  id: string;
  identity: Identity;
  intentKey: string;
  inputDigest: string;
  mode: Mode;
  status: Status;
  plan: Plan;
  attempts: Attempt[];
  cancelRequested: boolean;
  reason?: string;
  version: number;
  createdAt: number;
};
export const grantInput = z
  .object({
    wallet: address,
    deploymentId: z.string().min(1),
    chainId: z.number().int().positive(),
    positions: z.array(positive).min(1).max(100),
    exactApprovals: z.boolean(),
    maxPrincipalPerAction: positive,
    dailyPrincipal: positive,
    dailyFees: positive,
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type GrantInput = z.infer<typeof grantInput>;
export type Grant = GrantInput & { version: number; active: boolean };
export const globalInput = z
  .object({
    wallet: address,
    chainId: z.number().int().positive(),
    paused: z.boolean(),
    dailyPrincipal: positive,
    dailyFees: positive,
  })
  .strict();
export type GlobalPolicy = z.infer<typeof globalInput>;

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function assert(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}
export function publicAction(action: Action) {
  return {
    ...action,
    identity: { appId: action.identity.appId, wallet: action.identity.wallet },
    attempts: action.attempts.map(
      ({ encryptedRaw: _raw, manualToken: _token, ...attempt }) => attempt,
    ),
  };
}
