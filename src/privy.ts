import { timingSafeEqual } from "node:crypto";
import { PrivyClient } from "@privy-io/node";
import { numberToHex, type Hex } from "viem";
import {
  assert,
  address,
  type Identity,
  type Transaction,
} from "./contracts.js";
import type { Signer } from "./executor.js";

export class Authentication {
  constructor(
    readonly privy: PrivyClient,
    readonly privyAppId: string,
    readonly apps: Record<string, string>,
    readonly pilots: Set<string>,
  ) {
    assert(
      Object.values(apps).every((s) => s.length >= 32),
      "weak_app_connection_secret",
    );
  }
  async signerInstalled(
    identity: Identity,
    signerId: string,
    policyId: string,
  ) {
    if (!identity.privyWalletId) return false;
    const wallet = await this.privy.wallets().get(identity.privyWalletId);
    return (
      wallet.address.toLowerCase() === identity.wallet &&
      wallet.additional_signers.some(
        (s) =>
          s.signer_id === signerId && s.override_policy_ids?.includes(policyId),
      )
    );
  }
  async verify(headers: Headers, wallet?: string): Promise<Identity> {
    const appId = headers.get("x-agent-app") ?? "",
      secret = headers.get("x-agent-app-key") ?? "",
      expected = this.apps[appId];
    assert(
      expected &&
        Buffer.byteLength(secret) === Buffer.byteLength(expected) &&
        timingSafeEqual(Buffer.from(secret), Buffer.from(expected)),
      "app_authentication_failed",
    );
    const token = headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
    assert(token, "user_authentication_required");
    const claims = await this.privy.utils().auth().verifyAccessToken(token);
    assert(
      claims.app_id === this.privyAppId &&
        claims.expiration * 1000 > Date.now(),
      "token_audience_or_expiry",
    );
    assert(this.pilots.has(claims.user_id), "pilot_access_required");
    const user = await this.privy.users()._get(claims.user_id);
    const userId = `${this.privyAppId}/${claims.user_id}`;
    if (!wallet)
      return {
        userId,
        appId,
        wallet: "0x0000000000000000000000000000000000000000",
      };
    const target = address.parse(wallet);
    const linked = user.linked_accounts.find(
      (a) =>
        a.type === "wallet" &&
        "chain_type" in a &&
        a.chain_type === "ethereum" &&
        "address" in a &&
        a.address.toLowerCase() === target,
    );
    assert(linked, "wallet_not_linked");
    return {
      userId,
      appId,
      wallet: target,
      privyWalletId:
        "id" in linked && typeof linked.id === "string" ? linked.id : undefined,
    };
  }
}
export class PrivySigner implements Signer {
  constructor(
    readonly privy: PrivyClient,
    readonly appId: string,
    private authorizationKey: string,
    readonly signerId: string,
    readonly policyId: string,
  ) {
    assert(
      authorizationKey && signerId && policyId,
      "signer_configuration_missing",
    );
  }
  async sign(identity: Identity, tx: Transaction, nonce: number): Promise<Hex> {
    assert(identity.privyWalletId, "embedded_wallet_required");
    const user = await this.privy
      .users()
      ._get(identity.userId.slice(this.appId.length + 1));
    assert(
      user.linked_accounts.some(
        (a) =>
          a.type === "wallet" &&
          "id" in a &&
          a.id === identity.privyWalletId &&
          "address" in a &&
          a.address.toLowerCase() === identity.wallet,
      ),
      "wallet_binding_changed",
    );
    const wallet = await this.privy.wallets().get(identity.privyWalletId);
    assert(
      wallet.address.toLowerCase() === identity.wallet,
      "provider_wallet_mismatch",
    );
    assert(
      wallet.additional_signers.some(
        (s) =>
          s.signer_id === this.signerId &&
          s.override_policy_ids?.includes(this.policyId),
      ),
      "signer_policy_not_installed",
    );
    const result = await this.privy
      .wallets()
      .ethereum()
      .signTransaction(identity.privyWalletId, {
        params: {
          transaction: {
            type: 2,
            chain_id: tx.chainId,
            to: tx.to,
            data: tx.data as `0x${string}`,
            value: numberToHex(BigInt(tx.value)),
            gas_limit: numberToHex(BigInt(tx.gas)),
            max_fee_per_gas: numberToHex(BigInt(tx.maxFeePerGas)),
            max_priority_fee_per_gas: numberToHex(
              BigInt(tx.maxPriorityFeePerGas),
            ),
            nonce,
          },
        },
        authorization_context: {
          authorization_private_keys: [this.authorizationKey],
        },
        request_expiry: Date.now() + 30_000,
      });
    assert(
      result.encoding === "rlp" &&
        /^0x[0-9a-f]+$/i.test(result.signed_transaction),
      "provider_signature_invalid",
    );
    return result.signed_transaction as Hex;
  }
}
