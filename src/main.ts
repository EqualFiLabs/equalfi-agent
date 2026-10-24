import { PrivyClient } from "@privy-io/node";
import { Store } from "./store.js";
import { StaticsAdapter } from "./statics.js";
import { Authentication, PrivySigner, RemoteAuthentication } from "./privy.js";
import { Executor } from "./executor.js";
import { TransactionVault } from "./crypto.js";
import { Api } from "./api.js";
import { AgentChat } from "./chat.js";
import { assert, publicAction } from "./contracts.js";

const role = process.argv[2] === "worker" ? "worker" : "api";
const required = (name: string) => {
  const value = process.env[name];
  assert(value, `missing_${name.toLowerCase()}`);
  return value;
};
if (role === "api")
  assert(
    !process.env.PRIVY_AUTHORIZATION_KEY &&
      !process.env.TRANSACTION_ENCRYPTION_KEY &&
      !process.env.PRIVY_APP_SECRET &&
      !process.env.PRIVY_READ_ONLY_APP_SECRET,
    "signing_credentials_in_api_environment",
  );
const store = new Store(required("DATABASE_URL"));
const adapter = StaticsAdapter.fromFile(required("DEPLOYMENTS_FILE"));
const workerUrl = new URL(
  process.env.WORKER_CONTROL_URL ?? "http://127.0.0.1:4311",
);
const privy =
  role === "worker"
    ? new PrivyClient({
        appId: required("PRIVY_APP_ID"),
        appSecret: required("PRIVY_APP_SECRET"),
        maxRetries: 0,
        timeout: 15_000,
      })
    : undefined;
const auth = privy
  ? new Authentication(
      privy,
      required("PRIVY_APP_ID"),
      JSON.parse(required("APP_CONNECTIONS_JSON")),
      new Set(JSON.parse(process.env.PILOT_USERS_JSON ?? "[]")),
    )
  : new RemoteAuthentication(workerUrl);
const signerSettings =
  process.env.PRIVY_SIGNER_ID && process.env.PRIVY_POLICY_ID
    ? {
        signerId: process.env.PRIVY_SIGNER_ID,
        policyId: process.env.PRIVY_POLICY_ID,
      }
    : undefined;
const api = new Api(store, adapter, auth, undefined, signerSettings);
let workerRunning = false,
  stopping = false;
if (role === "worker") {
  const signer = new PrivySigner(
    privy!,
    required("PRIVY_APP_ID"),
    required("PRIVY_AUTHORIZATION_KEY"),
    required("PRIVY_SIGNER_ID"),
    required("PRIVY_POLICY_ID"),
  );
  const executor = new Executor(
    store,
    adapter,
    new TransactionVault(
      Buffer.from(required("TRANSACTION_ENCRYPTION_KEY"), "base64"),
    ),
    signer,
    () =>
      process.env.EXECUTION_ENABLED === "true" &&
      process.env.PRIVY_SIGNING_REHEARSED === "true",
  );
  api.manualSignature = async (id, identity, raw) => {
    const action = await executor.acceptManual(id, identity, raw);
    assert(action, "wallet_busy");
    return publicAction(action);
  };
  const tick = async () => {
    if (workerRunning || stopping) return;
    workerRunning = true;
    try {
      const r = await store.pool.query(
        "SELECT id FROM agent_actions WHERE body->>'status' IN ('running','reconciling') ORDER BY updated_at LIMIT 50",
      );
      for (const row of r.rows) {
        if (stopping) break;
        await executor
          .run(row.id)
          .catch(() => console.error("workflow_recovery_required", row.id));
      }
      // Never replay a crashed model request. Preserve linked actions and expose an interrupted result.
      await store.pool.query(
        "UPDATE agent_messages SET status='interrupted' WHERE status='running' AND (body->>'createdAt')::bigint < $1",
        [Date.now() - 300_000],
      );
    } catch {
      console.error("worker_database_unavailable");
    } finally {
      workerRunning = false;
    }
  };
  setInterval(() => void tick(), 2000).unref();
  void tick();
} else {
  api.manualSignature = async (id, _identity, raw, headers) => {
    const result = await fetch(
      new URL(`/v1/actions/${id}/signature`, workerUrl),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: headers.get("authorization")!,
          "x-agent-app": headers.get("x-agent-app")!,
          "x-agent-app-key": headers.get("x-agent-app-key")!,
          "x-agent-wallet": headers.get("x-agent-wallet")!,
        },
        body: JSON.stringify({ raw }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const body = await result.json();
    assert(result.ok, "manual_worker_request_failed");
    return body;
  };
  if (process.env.AGENT_MODEL) {
    const chat = new AgentChat(api, {
      model: process.env.AGENT_MODEL,
      userDaily: Number(process.env.MODEL_DAILY_USER_USD),
      globalDaily: Number(process.env.MODEL_DAILY_GLOBAL_USD),
      requestMaximum: Number(process.env.MODEL_MAX_REQUEST_USD),
      searchKey: process.env.EXA_API_KEY ?? "",
      inputUsdPerMillion: Number(process.env.MODEL_INPUT_USD_PER_MILLION),
      outputUsdPerMillion: Number(process.env.MODEL_OUTPUT_USD_PER_MILLION),
      researchUsdPerRequest: Number(process.env.RESEARCH_MAX_CALL_USD),
    });
    Object.assign(api, { chat });
  }
}
const server = api.server();
server.listen(
  Number(process.env.PORT ?? (role === "worker" ? 4311 : 4310)),
  "127.0.0.1",
  () => console.info(`agent_${role}_ready`),
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    stopping = true;
    server.close(() => {
      const interval = setInterval(() => {
        if (!workerRunning) {
          clearInterval(interval);
          void store.pool.end().then(() => process.exit(0));
        }
      }, 100);
    });
  });
