import { parseUnits } from "viem";
import { stakeInput, type StakeInput, type Identity } from "./contracts.js";

// Only this fully specified original-user imperative may authorize automatic execution.
// Model responses, history, tool results and quoted research never feed this parser.
export function originalStakeIntent(
  text: string,
  identity: Identity,
  deploymentIds: string[],
): StakeInput | null {
  const match = text
    .trim()
    .match(
      /^stake\s+([0-9]+(?:\.[0-9]{1,18})?)\s+statics\s+(?:in|into)\s+position\s+([1-9][0-9]*)\s+with\s+(?:a\s+)?(?:maximum\s+)?(?:network\s+)?fee(?:\s+cap)?(?:\s+of)?\s+([0-9]+(?:\.[0-9]{1,18})?)\s+eth\s+per\s+transaction(?:\s+on\s+deployment\s+([a-zA-Z0-9_-]+))?[.!]?$/i,
    );
  if (!match) return null;
  const deploymentId =
    match[4] ?? (deploymentIds.length === 1 ? deploymentIds[0] : undefined);
  if (!deploymentId || !deploymentIds.includes(deploymentId)) return null;
  const parsed = stakeInput.safeParse({
    kind: "statics.stake-existing",
    version: 1,
    deploymentId,
    wallet: identity.wallet,
    positionId: match[2],
    amount: String(parseUnits(match[1], 18)),
    maxFeePerTransaction: String(parseUnits(match[3], 18)),
  });
  return parsed.success ? parsed.data : null;
}
export function mayExecuteChatStake(
  original: StakeInput | null,
  proposed: StakeInput,
): boolean {
  return Boolean(
    original &&
    original.kind === proposed.kind &&
    original.version === proposed.version &&
    original.deploymentId === proposed.deploymentId &&
    original.wallet === proposed.wallet &&
    original.positionId === proposed.positionId &&
    original.amount === proposed.amount &&
    original.maxFeePerTransaction === proposed.maxFeePerTransaction,
  );
}
