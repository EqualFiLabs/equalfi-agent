import { describe, it, expect, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  Authentication,
  PrivySigner,
  RemoteAuthentication,
} from "../src/privy.js";
import { TransactionVault } from "../src/crypto.js";
import { validateSignature } from "../src/executor.js";
import { publicIpv4, researchUrl, fetchPage } from "../src/research.js";
import { AgentClient } from "../packages/client/src/index.js";
import { input, wallet } from "./fixtures.js";
import type { PrivyClient } from "@privy-io/node";
import { AgentChat } from "../src/chat.js";
vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn(async () => ["127.0.0.1"]),
}));
function authentication() {
  const claims = {
    app_id: "privy-app",
    user_id: "did:privy:one",
    expiration: Math.floor(Date.now() / 1000) + 600,
  };
  const privy = {
    utils: () => ({
      auth: () => ({ verifyAccessToken: vi.fn(async () => claims) }),
    }),
    users: () => ({
      _get: vi.fn(async () => ({
        linked_accounts: [
          {
            type: "wallet",
            chain_type: "ethereum",
            wallet_client_type: "privy",
            address: wallet,
            id: "linked",
          },
        ],
      })),
    }),
  };
  const auth = new Authentication(
    privy as unknown as PrivyClient,
    "privy-app",
    { statics: "s".repeat(32) },
    new Set([claims.user_id]),
  );
  const headers = new Headers({
    "x-agent-app": "statics",
    "x-agent-app-key": "s".repeat(32),
    authorization: "Bearer verified-by-stub",
  });
  return { auth, headers, claims };
}
describe("authority boundary", () => {
  it("requires both authenticated app connection and verified linked wallet", async () => {
    const { auth, headers } = authentication();
    expect((await auth.verify(headers, wallet)).privyWalletId).toBe("linked");
    headers.set("x-agent-app", "eves");
    await expect(auth.verify(headers, wallet)).rejects.toThrow(
      "app_authentication_failed",
    );
    headers.set("x-agent-app", "statics");
    await expect(
      auth.verify(headers, "0x2222222222222222222222222222222222222222"),
    ).rejects.toThrow("wallet_not_linked");
  });
  it("rejects expired tokens, wrong audience and users outside the pilot", async () => {
    const { auth, headers, claims } = authentication();
    claims.expiration = 0;
    await expect(auth.verify(headers, wallet)).rejects.toThrow("expiry");
    claims.expiration = Date.now();
    claims.app_id = "other";
    await expect(auth.verify(headers, wallet)).rejects.toThrow("audience");
    claims.app_id = "privy-app";
    claims.user_id = "someone-else";
    await expect(auth.verify(headers, wallet)).rejects.toThrow("pilot_access");
  });
  it("encrypts signed bytes with workflow-bound authenticated encryption", () => {
    const vault = new TransactionVault(Buffer.alloc(32, 1)),
      sealed = vault.seal("0xdeadbeef", "action:stake");
    expect(sealed).not.toContain("deadbeef");
    expect(vault.open(sealed, "action:stake")).toBe("0xdeadbeef");
    expect(() => vault.open(sealed, "other:stake")).toThrow();
  });
  it("accepts only the exact signed transaction and linked signer", async () => {
    const account = privateKeyToAccount(`0x${"02".repeat(32)}`);
    const tx = {
      chainId: 31337,
      to: wallet,
      data: "0x" as const,
      value: "0",
      gas: "21000",
      maxFeePerGas: "2",
      maxPriorityFeePerGas: "1",
    };
    const raw = await account.signTransaction({
      chainId: 31337,
      to: wallet,
      value: 0n,
      gas: 21000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      nonce: 3,
    });
    const identity = {
      userId: "test",
      appId: "statics",
      wallet: account.address.toLowerCase() as typeof wallet,
    };
    expect(await validateSignature(raw, identity, tx, 3)).toMatch(/^0x/);
    await expect(
      validateSignature(raw, identity, { ...tx, value: "1" }, 3),
    ).rejects.toThrow("transaction_mismatch");
    await expect(
      validateSignature(raw, { ...identity, wallet }, tx, 3),
    ).rejects.toThrow("wallet_mismatch");
  });
  it("does not call Privy signing when the required signer policy is absent", async () => {
    const signTransaction = vi.fn();
    const privy = {
      users: () => ({
        _get: async () => ({
          linked_accounts: [
            {
              type: "wallet",
              wallet_client_type: "privy",
              id: "linked",
              address: wallet,
            },
          ],
        }),
      }),
      wallets: () => ({
        get: async () => ({ address: wallet, additional_signers: [] }),
        ethereum: () => ({ signTransaction }),
      }),
    };
    const signer = new PrivySigner(
      privy as unknown as PrivyClient,
      "app",
      "key",
      "signer",
      "policy",
    );
    await expect(
      signer.sign(
        {
          userId: "app/did:test",
          appId: "statics",
          wallet,
          privyWalletId: "linked",
        },
        {
          chainId: 31337,
          to: wallet,
          data: "0x",
          value: "0",
          gas: "21000",
          maxFeePerGas: "2",
          maxPriorityFeePerGas: "1",
        },
        0,
      ),
    ).rejects.toThrow("policy_not_installed");
    expect(signTransaction).not.toHaveBeenCalled();
  });
});
describe("private identity transport", () => {
  it("forwards only authentication to the private worker and binds its response", async () => {
    const identity = { userId: "app/did:one", appId: "statics", wallet };
    const fetcher = vi.fn(async () =>
      Response.json({
        identity,
        signer: { signerId: "signer", policyId: "policy", installed: true },
      }),
    );
    const auth = new RemoteAuthentication(
      new URL("http://127.0.0.1:4311"),
      fetcher as typeof fetch,
    );
    const headers = new Headers({
      authorization: "Bearer verified",
      "x-agent-app": "statics",
      "x-agent-app-key": "connection",
      "x-ignored-secret": "must-not-forward",
    });
    const verified = await auth.verify(headers, wallet);
    expect(await auth.signerInstalled(verified, "signer", "policy")).toBe(true);
    expect(await auth.signerInstalled(verified, "other", "policy")).toBe(false);
    const request = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(request[0].pathname).toBe("/internal/identity");
    expect((request[1].headers as Headers).get("x-ignored-secret")).toBeNull();
    await expect(
      auth.verify(
        new Headers({ ...Object.fromEntries(headers), "x-agent-app": "eves" }),
        wallet,
      ),
    ).rejects.toThrow("identity_mismatch");
  });
  it("fails closed when identity worker is unavailable or remote", async () => {
    expect(
      () => new RemoteAuthentication(new URL("https://public.example")),
    ).toThrow("private_worker");
    const auth = new RemoteAuthentication(
      new URL("http://127.0.0.1:4311"),
      vi.fn(async () => new Response(null, { status: 401 })) as typeof fetch,
    );
    await expect(auth.verify(new Headers(), wallet)).rejects.toThrow(
      "authentication_failed",
    );
  });
});
describe("research isolation", () => {
  it("rejects private, metadata, loopback and reserved networks", () => {
    for (const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "100.100.100.200",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.2.3",
      "192.168.1.1",
      "224.0.0.1",
      "::1",
    ])
      expect(publicIpv4(ip)).toBe(false);
    expect(publicIpv4("8.8.8.8")).toBe(true);
  });
  it("blocks alternate schemes, credentials, ports and DNS resolving to private addresses", async () => {
    for (const url of [
      "file:///etc/passwd",
      "http://example.com",
      "https://user:pass@example.com",
      "https://example.com:4311",
    ])
      expect(() => researchUrl(url)).toThrow();
    await expect(fetchPage("https://public-looking.example")).rejects.toThrow(
      "private_network",
    );
  });
  it("requires a conservative provider-price envelope before enabling paid tools", () => {
    expect(
      () =>
        new AgentChat({} as never, {
          model: "openai/example",
          userDaily: 1,
          globalDaily: 10,
          requestMaximum: 0.01,
          searchKey: "",
          inputUsdPerMillion: 10,
          outputUsdPerMillion: 10,
          researchUsdPerRequest: 0.01,
        }),
    ).toThrow("provider_envelope");
  });
});
describe("thin SDK", () => {
  it("refreshes authentication and sends an opaque reference rather than executable replacements", async () => {
    const getAccessToken = vi.fn(async () => "fresh"),
      fetcher = vi.fn(async () => Response.json({ id: "action" }));
    const client = new AgentClient({
      baseUrl: "/api/agent",
      wallet,
      chainId: 31337,
      getAccessToken,
      fetch: fetcher as typeof fetch,
    });
    await client.execute(
      { id: "opaque-id", plan: { digest: "revision" } } as never,
      "delegated",
    );
    expect(getAccessToken).toHaveBeenCalledOnce();
    const request = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(request[1].body as string)).toEqual({
      planDigest: "revision",
      mode: "delegated",
    });
  });
});
