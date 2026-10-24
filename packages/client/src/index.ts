export type Mode = "proposal" | "manual" | "delegated";
export type StakeInput = {
  kind: "statics.stake-existing";
  version: 1;
  deploymentId: string;
  wallet: string;
  positionId: string;
  amount: string;
  maxFeePerTransaction: string;
};
export type Transaction = {
  chainId: number;
  to: string;
  data: string;
  value: string;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
};
export type Workflow = {
  id: string;
  identity: { appId: string; wallet: string };
  mode: Mode;
  status: string;
  reason?: string;
  version: number;
  cancelRequested: boolean;
  plan: {
    digest: string;
    deploymentId: string;
    chainId: number;
    input: StakeInput;
    expiresAt: number;
    steps: {
      id: string;
      kind: "approval" | "stake";
      transaction: Transaction;
      principal: string;
      maxFee: string;
    }[];
  };
  attempts: {
    stepId: string;
    status: string;
    nonce: number;
    transaction?: Transaction;
    hash?: string;
    blockNumber?: string;
    result?: Record<string, string>;
  }[];
};
export type Policy = {
  wallet: string;
  chainId: number;
  paused: boolean;
  dailyPrincipal: string;
  dailyFees: string;
};
export type Grant = {
  wallet: string;
  chainId: number;
  deploymentId: string;
  positions: string[];
  exactApprovals: boolean;
  maxPrincipalPerAction: string;
  dailyPrincipal: string;
  dailyFees: string;
  expiresAt: number;
};
export type Message = {
  id: string;
  status: string;
  body: {
    text: string;
    assistant?: string;
    actionIds: string[];
    sources?: unknown[];
  };
};
export type SignRequest = Transaction & { nonce: number };
export class AgentClient {
  constructor(
    readonly options: {
      baseUrl: string;
      wallet: string;
      chainId: number;
      getAccessToken: () => Promise<string | null>;
      fetch?: typeof fetch;
    },
  ) {}
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const token = await this.options.getAccessToken();
    if (!token) throw new Error("Sign in to use the agent.");
    const response = await (this.options.fetch ?? fetch)(
      `${this.options.baseUrl}${path}`,
      {
        method,
        cache: "no-store",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-agent-wallet": this.options.wallet,
          "x-agent-chain": String(this.options.chainId),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      },
    );
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        typeof data.error === "string" ? data.error : "Agent request failed.",
      );
    return data as T;
  }
  capabilities() {
    return this.request<{
      signer: { signerId: string; policyId: string; installed: boolean } | null;
    }>("GET", "/v1/capabilities");
  }
  prepare(intentKey: string, input: StakeInput, mode: Mode = "proposal") {
    return this.request<Workflow>("POST", "/v1/actions", {
      intentKey,
      input,
      mode,
    });
  }
  execute(action: Workflow, mode: "manual" | "delegated") {
    return this.request<Workflow>("POST", `/v1/actions/${action.id}/execute`, {
      planDigest: action.plan.digest,
      mode,
    });
  }
  status(id: string) {
    return this.request<Workflow>("GET", `/v1/actions/${id}`);
  }
  activity(page = 0) {
    return this.request<Workflow[]>("GET", `/v1/actions?page=${page}`);
  }
  cancel(id: string) {
    return this.request<Workflow>("POST", `/v1/actions/${id}/cancel`, {});
  }
  reprepare(id: string) {
    return this.request<Workflow>("POST", `/v1/actions/${id}/reprepare`, {});
  }
  signature(id: string, raw: string) {
    return this.request<Workflow>("POST", `/v1/actions/${id}/signature`, {
      raw,
    });
  }
  policy() {
    return this.request<{
      global?: { body: Policy };
      grant?: { body: Grant & { active: boolean } };
    }>("GET", "/v1/policy");
  }
  setGlobal(policy: Policy) {
    return this.request("PUT", "/v1/policy/global", policy);
  }
  setGrant(grant: Grant) {
    return this.request("PUT", "/v1/grants", grant);
  }
  revoke() {
    return this.request("POST", "/v1/grants/revoke", {
      chainId: this.options.chainId,
    });
  }
  events(after: number, signal?: AbortSignal) {
    return this.request<{ sequence: string; body: Workflow }[]>(
      "GET",
      `/v1/events?after=${after}`,
      undefined,
      signal,
    );
  }
  conversation() {
    return this.request<{ id: string }>("POST", "/v1/conversations", {});
  }
  messages(id: string) {
    return this.request<Message[]>("GET", `/v1/conversations/${id}`);
  }
  chat(id: string, intentKey: string, text: string) {
    return this.request<Message>("POST", `/v1/conversations/${id}/messages`, {
      intentKey,
      text,
    });
  }
  async signNext(
    action: Workflow,
    sign: (request: SignRequest) => Promise<string>,
  ) {
    const current = await this.status(action.id);
    if (current.status !== "awaiting_manual")
      throw new Error("The action is not ready for a wallet signature.");
    const attempt = current.attempts.find((a) => a.status === "reserved");
    if (!attempt?.transaction)
      throw new Error("No prepared transaction is available.");
    const raw = await sign({ ...attempt.transaction, nonce: attempt.nonce });
    return this.signature(current.id, raw);
  }
}
