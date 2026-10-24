import { randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import {
  assert,
  digest,
  publicAction,
  type Action,
  type Grant,
  type GlobalPolicy,
  type Identity,
  type Plan,
  type Mode,
  type Step,
} from "./contracts.js";

export class Store {
  readonly pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 12,
      connectionTimeoutMillis: 5000,
    });
    this.pool.on("error", () => {});
  }
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async walletLock<T>(
    wallet: string,
    chainId: number,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T | undefined> {
    const client = await this.pool.connect();
    let connected = true;
    const onError = () => {
      connected = false;
    };
    client.on("error", onError);
    try {
      const r = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
        [`${wallet}:${chainId}`],
      );
      if (!r.rows[0].acquired) return undefined;
      const result = await fn(client);
      assert(connected, "execution_connection_lost");
      return result;
    } finally {
      if (connected)
        await client
          .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
            `${wallet}:${chainId}`,
          ])
          .catch(() => {
            connected = false;
          });
      client.removeListener("error", onError);
      client.release(!connected);
    }
  }
  async get(
    id: string,
    identity?: Pick<Identity, "userId" | "appId">,
    client?: PoolClient,
  ): Promise<Action> {
    const result = await (client ?? this.pool).query(
      "SELECT body FROM agent_actions WHERE id=$1",
      [id],
    );
    const action = result.rows[0]?.body as Action | undefined;
    assert(
      action &&
        (!identity ||
          (action.identity.userId === identity.userId &&
            action.identity.appId === identity.appId)),
      "action_not_found",
    );
    return action;
  }
  async create(
    identity: Identity,
    key: string,
    mode: Mode,
    plan: Plan,
  ): Promise<Action> {
    const inputDigest = digest({ input: plan.input, mode });
    return this.transaction(async (c) => {
      const action: Action = {
        id: randomUUID(),
        identity,
        intentKey: key,
        inputDigest,
        mode,
        status: "ready",
        plan,
        attempts: [],
        cancelRequested: false,
        version: 1,
        createdAt: Date.now(),
      };
      const result = await c.query(
        "INSERT INTO agent_actions(id,user_id,app_id,wallet,intent_key,input_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,app_id,intent_key) DO NOTHING RETURNING id",
        [
          action.id,
          identity.userId,
          identity.appId,
          identity.wallet,
          key,
          inputDigest,
          action,
        ],
      );
      if (!result.rowCount) {
        const existing = await c.query(
          "SELECT body FROM agent_actions WHERE user_id=$1 AND app_id=$2 AND intent_key=$3",
          [identity.userId, identity.appId, key],
        );
        const previous = existing.rows[0].body as Action;
        assert(previous.inputDigest === inputDigest, "intent_key_conflict");
        return previous;
      }
      await this.event(c, action);
      return action;
    });
  }
  async save(c: PoolClient, action: Action) {
    const previous = action.version;
    action.version++;
    const r = await c.query(
      "UPDATE agent_actions SET body=$1,updated_at=now() WHERE id=$2 AND (body->>'version')::integer=$3",
      [action, action.id, previous],
    );
    assert(r.rowCount === 1, "stale_action_version");
    await this.event(c, action);
  }
  async event(c: PoolClient, action: Action) {
    await c.query(
      "INSERT INTO agent_events(action_id,user_id,app_id,body) VALUES($1,$2,$3,$4)",
      [
        action.id,
        action.identity.userId,
        action.identity.appId,
        publicAction(action),
      ],
    );
  }
  async list(identity: Pick<Identity, "userId" | "appId">) {
    const r = await this.pool.query(
      "SELECT body FROM agent_actions WHERE user_id=$1 AND app_id=$2 ORDER BY updated_at DESC LIMIT 50",
      [identity.userId, identity.appId],
    );
    return r.rows.map((r) => publicAction(r.body));
  }
  async events(identity: Pick<Identity, "userId" | "appId">, cursor: number) {
    const r = await this.pool.query(
      "SELECT sequence::text,body FROM agent_events WHERE user_id=$1 AND app_id=$2 AND sequence>$3 ORDER BY sequence LIMIT 100",
      [identity.userId, identity.appId, cursor],
    );
    return r.rows;
  }
  async policy(
    c: PoolClient,
    identity: Identity,
    chainId: number,
    scope: string,
    lock = false,
  ) {
    const r = await c.query(
      `SELECT body,version FROM agent_policies WHERE user_id=$1 AND wallet=$2 AND chain_id=$3 AND scope=$4${lock ? " FOR UPDATE" : ""}`,
      [identity.userId, identity.wallet, chainId, scope],
    );
    return r.rows[0];
  }
  async setPolicy(
    identity: Identity,
    chainId: number,
    scope: string,
    body: unknown,
  ) {
    return this.transaction(async (c) => {
      const r = await c.query(
        "INSERT INTO agent_policies(user_id,wallet,chain_id,scope,version,body) VALUES($1,$2,$3,$4,1,$5) ON CONFLICT(user_id,wallet,chain_id,scope) DO UPDATE SET version=agent_policies.version+1,body=excluded.body RETURNING version",
        [identity.userId, identity.wallet, chainId, scope, body],
      );
      return r.rows[0].version as number;
    });
  }
  async authorize(c: PoolClient, action: Action, step: Step, reserve: boolean) {
    // Lock global policy first everywhere; budget updates and revocation share these locks.
    const globalRow = await this.policy(
      c,
      action.identity,
      action.plan.chainId,
      "*",
      true,
    );
    const appRow = await this.policy(
      c,
      action.identity,
      action.plan.chainId,
      action.identity.appId,
      true,
    );
    const global = globalRow?.body as GlobalPolicy | undefined,
      grant = appRow?.body as Grant | undefined;
    assert(global && !global.paused, "execution_paused_or_unconfigured");
    if (action.mode === "delegated") {
      assert(grant?.active && grant.expiresAt > Date.now(), "grant_inactive");
      assert(
        grant.deploymentId === action.plan.deploymentId &&
          grant.positions.includes(action.plan.input.positionId),
        "grant_scope_mismatch",
      );
      assert(
        BigInt(action.plan.input.amount) <= BigInt(grant.maxPrincipalPerAction),
        "per_action_limit",
      );
      assert(
        step.kind !== "approval" || grant.exactApprovals,
        "approval_not_granted",
      );
    }
    // Manual authorization is exact-plan consent; it still observes shared global limits.
    const limits = [
      { scope: "*", policy: global },
      ...(action.mode === "delegated"
        ? [{ scope: action.identity.appId, policy: grant! }]
        : []),
    ];
    for (const { scope, policy } of limits)
      for (const [asset, amount, cap] of [
        ["STATICS", step.principal, policy.dailyPrincipal],
        ["native-fees", step.maxFee, policy.dailyFees],
      ]) {
        const aggregate = await c.query(
          "SELECT COALESCE(sum(reserved),0)+COALESCE(sum(spent) FILTER (WHERE day=(now() AT TIME ZONE 'UTC')::date),0) AS total FROM agent_budgets WHERE user_id=$1 AND wallet=$2 AND chain_id=$3 AND scope=$4 AND asset=$5",
          [
            action.identity.userId,
            action.identity.wallet,
            action.plan.chainId,
            scope,
            asset,
          ],
        );
        assert(
          BigInt(aggregate.rows[0].total) <= BigInt(cap),
          "reduced_budget_exceeded",
        );
        if (!reserve) continue;
        const old = await c.query(
          "SELECT 1 FROM agent_reservations WHERE action_id=$1 AND step_id=$2 AND scope=$3 AND asset=$4",
          [action.id, step.id, scope, asset],
        );
        if (old.rowCount) continue;
        assert(
          BigInt(aggregate.rows[0].total) + BigInt(amount) <= BigInt(cap),
          "aggregate_budget_exceeded",
        );
        await c.query(
          "INSERT INTO agent_budgets(user_id,wallet,chain_id,scope,day,asset) VALUES($1,$2,$3,$4,(now() AT TIME ZONE 'UTC')::date,$5) ON CONFLICT DO NOTHING",
          [
            action.identity.userId,
            action.identity.wallet,
            action.plan.chainId,
            scope,
            asset,
          ],
        );
        const r = await c.query(
          "UPDATE agent_budgets SET reserved=reserved+$6::numeric WHERE user_id=$1 AND wallet=$2 AND chain_id=$3 AND scope=$4 AND day=(now() AT TIME ZONE 'UTC')::date AND asset=$5 AND spent+reserved+$6::numeric <= $7::numeric RETURNING day::text",
          [
            action.identity.userId,
            action.identity.wallet,
            action.plan.chainId,
            scope,
            asset,
            amount,
            cap,
          ],
        );
        assert(r.rowCount === 1, "aggregate_budget_exceeded");
        await c.query(
          "INSERT INTO agent_reservations(action_id,step_id,scope,asset,day,amount) VALUES($1,$2,$3,$4,$5,$6)",
          [action.id, step.id, scope, asset, r.rows[0].day, amount],
        );
      }
    return {
      globalVersion: globalRow.version as number,
      grantVersion: appRow?.version as number | undefined,
    };
  }
  async settle(
    c: PoolClient,
    action: Action,
    step: Step,
    principal: string,
    fee: string,
  ) {
    const r = await c.query(
      "UPDATE agent_reservations SET settled=true WHERE action_id=$1 AND step_id=$2 AND settled=false RETURNING *",
      [action.id, step.id],
    );
    for (const row of r.rows)
      await c.query(
        "UPDATE agent_budgets SET reserved=reserved-$7::numeric,spent=spent+$8::numeric WHERE user_id=$1 AND wallet=$2 AND chain_id=$3 AND scope=$4 AND day=$5 AND asset=$6",
        [
          action.identity.userId,
          action.identity.wallet,
          action.plan.chainId,
          row.scope,
          row.day,
          row.asset,
          row.amount,
          row.asset === "STATICS" ? principal : fee,
        ],
      );
  }
}
