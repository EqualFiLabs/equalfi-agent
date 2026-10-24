import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  assert,
  digest,
  globalInput,
  grantInput,
  publicAction,
  stakeInput,
  type Action,
  type Identity,
} from "./contracts.js";
import { Store } from "./store.js";
import { StaticsAdapter } from "./statics.js";
import { Executor, atomic } from "./executor.js";
import type { Authentication } from "./privy.js";
export interface ChatService {
  respond(
    identity: Identity,
    conversationId: string,
    raw: unknown,
  ): Promise<unknown>;
}

const createInput = z
  .object({
    intentKey: z.string().min(1).max(120),
    mode: z.enum(["proposal", "manual", "delegated"]),
    input: stakeInput,
  })
  .strict();
export class Api {
  constructor(
    readonly store: Store,
    readonly adapter: StaticsAdapter,
    readonly auth: Pick<Authentication, "verify"> &
      Partial<Pick<Authentication, "signerInstalled">>,
    readonly chat?: ChatService,
    readonly signerSettings?: { signerId: string; policyId: string },
  ) {}
  async create(identity: Identity, raw: unknown) {
    assert(identity.appId === "statics", "app_capability_not_registered");
    const body = createInput.parse(raw);
    assert(body.input.wallet === identity.wallet, "wallet_binding_mismatch");
    const existing = await this.store.pool.query(
      "SELECT body FROM agent_actions WHERE user_id=$1 AND app_id=$2 AND intent_key=$3",
      [identity.userId, identity.appId, body.intentKey],
    );
    if (existing.rowCount) {
      const action = existing.rows[0].body as Action;
      assert(
        action.inputDigest === digest({ input: body.input, mode: body.mode }),
        "intent_key_conflict",
      );
      return action;
    }
    const plan = await this.adapter.prepare(body.input);
    return this.store.create(identity, body.intentKey, body.mode, plan);
  }
  async activate(
    identity: Identity,
    id: string,
    planDigest: string,
    mode: "manual" | "delegated",
  ) {
    const action = await this.store.get(id, identity);
    assert(
      action.identity.wallet === identity.wallet,
      "wallet_binding_mismatch",
    );
    const result = await this.store.walletLock(
      identity.wallet,
      action.plan.chainId,
      async (c) => {
        const fresh = await this.store.get(id, identity, c);
        assert(fresh.plan.digest === planDigest, "plan_revision_conflict");
        assert(
          !fresh.cancelRequested &&
            !["completed", "failed", "cancelled"].includes(fresh.status),
          "terminal_action",
        );
        assert(
          !fresh.attempts.length || fresh.mode === mode,
          "cannot_change_mode_after_attempt",
        );
        fresh.mode = mode;
        fresh.status = "running";
        delete fresh.reason;
        await atomic(c, () => this.store.save(c, fresh));
        return fresh;
      },
    );
    assert(result, "wallet_busy");
    return result;
  }
  async route(
    method: string,
    path: string,
    headers: Headers,
    raw: unknown,
  ): Promise<unknown> {
    const identity = await this.auth.verify(
      headers,
      headers.get("x-agent-wallet") ?? undefined,
    );
    await this.store.rateLimit(identity);
    if (path === "/v1/read" && method === "POST") {
      assert(identity.appId === "statics", "app_capability_not_registered");
      const body = z
        .object({
          deploymentId: z.string().min(1),
          positionId: z
            .string()
            .regex(/^[1-9][0-9]{0,76}$/)
            .optional(),
          cursor: z
            .string()
            .regex(/^(0|[1-9][0-9]{0,76})$/)
            .optional(),
        })
        .strict()
        .parse(raw);
      return this.adapter.readAccount(
        body.deploymentId,
        identity.wallet,
        body.positionId,
        body.cursor,
      );
    }
    if (path === "/v1/capabilities" && method === "GET")
      return {
        apiVersion: 1,
        actions: [{ kind: "statics.stake-existing", version: 1 }],
        deployments: this.adapter.deployments.map((d) => ({
          id: d.id,
          chainId: d.chainId,
          revision: digest(d),
        })),
        signer: this.signerSettings
          ? {
              ...this.signerSettings,
              installed:
                (await this.auth.signerInstalled?.(
                  identity,
                  this.signerSettings.signerId,
                  this.signerSettings.policyId,
                )) ?? false,
            }
          : null,
      };
    if (path === "/v1/actions" && method === "POST")
      return publicAction(await this.create(identity, raw));
    if (
      new URL(path, "http://local").pathname === "/v1/actions" &&
      method === "GET"
    )
      return this.store.list(
        identity,
        z.coerce.number().int().positive().parse(headers.get("x-agent-chain")),
        z.coerce
          .number()
          .int()
          .min(0)
          .max(10000)
          .parse(new URL(path, "http://local").searchParams.get("page") ?? 0),
      );
    const url = new URL(path, "http://local"),
      eventCursor = url.searchParams.get("after") ?? "0";
    if (url.pathname === "/v1/events" && method === "GET") {
      assert(/^\d{1,15}$/.test(eventCursor), "invalid_event_cursor");
      return this.store.events(identity, Number(eventCursor));
    }
    if (path === "/v1/policy" && method === "GET")
      return this.store.transaction(async (c) => ({
        global: await this.store.policy(
          c,
          identity,
          Number(headers.get("x-agent-chain")),
          "*",
        ),
        grant: await this.store.policy(
          c,
          identity,
          Number(headers.get("x-agent-chain")),
          identity.appId,
        ),
      }));
    if (path === "/v1/policy/global" && method === "PUT") {
      const body = globalInput.parse(raw);
      assert(body.wallet === identity.wallet, "wallet_binding_mismatch");
      return {
        version: await this.store.setPolicy(identity, body.chainId, "*", body),
      };
    }
    if (path === "/v1/grants" && method === "PUT") {
      assert(identity.appId === "statics", "app_capability_not_registered");
      const body = grantInput.parse(raw);
      assert(body.wallet === identity.wallet, "wallet_binding_mismatch");
      const deployment = this.adapter.deployment(body.deploymentId);
      assert(
        body.chainId === deployment.chainId && body.expiresAt > Date.now(),
        "invalid_grant_scope_or_expiry",
      );
      assert(identity.privyWalletId, "embedded_wallet_required");
      return {
        version: await this.store.setPolicy(
          identity,
          body.chainId,
          identity.appId,
          { ...body, active: true },
        ),
      };
    }
    if (path === "/v1/grants/revoke" && method === "POST") {
      const { chainId } = z
        .object({ chainId: z.number().int().positive() })
        .strict()
        .parse(raw);
      return {
        version: await this.store.setPolicy(identity, chainId, identity.appId, {
          active: false,
        }),
      };
    }
    const match = url.pathname.match(
      /^\/v1\/actions\/([a-f0-9-]{36})(?:\/(execute|cancel|resume|reprepare|signature))?$/,
    );
    if (match) {
      const action = await this.store.get(match[1], identity);
      assert(
        action.identity.wallet === identity.wallet,
        "wallet_binding_mismatch",
      );
      if (!match[2] && method === "GET") return publicAction(action);
      assert(method === "POST", "method_not_allowed");
      if (match[2] === "signature") {
        const body = z
          .object({
            raw: z
              .string()
              .regex(/^0x[0-9a-f]+$/i)
              .max(10_000),
          })
          .strict()
          .parse(raw);
        assert(this.manualSignature, "manual_transport_unavailable");
        return this.manualSignature(
          action.id,
          identity,
          body.raw as `0x${string}`,
          headers,
        );
      }
      if (match[2] === "execute" || match[2] === "resume") {
        const body = z
          .object({
            planDigest: z.string(),
            mode: z.enum(["manual", "delegated"]),
          })
          .strict()
          .parse(raw);
        return publicAction(
          await this.activate(identity, action.id, body.planDigest, body.mode),
        );
      }
      const changed = await this.store.walletLock(
        identity.wallet,
        action.plan.chainId,
        async (c) => {
          const fresh = await this.store.get(action.id, identity, c);
          if (match[2] === "cancel") {
            z.object({}).strict().parse(raw);
            assert(
              !["completed", "failed", "cancelled"].includes(fresh.status),
              "terminal_action",
            );
            fresh.cancelRequested = true;
            fresh.status = fresh.attempts.some(
              (a) =>
                a.hash &&
                !["confirmed", "reverted", "cancelled"].includes(a.status),
            )
              ? "reconciling"
              : "running";
          } else if (match[2] === "reprepare") {
            z.object({}).strict().parse(raw);
            assert(
              !fresh.attempts.some(
                (a) =>
                  !["confirmed", "reverted", "cancelled"].includes(a.status),
              ),
              "unresolved_attempt_prevents_reprepare",
            );
            assert(
              !["completed", "failed", "cancelled"].includes(fresh.status),
              "terminal_action",
            );
            assert(
              !fresh.attempts.some(
                (a) => a.status === "confirmed" && a.stepId.startsWith("stake"),
              ),
              "stake_already_confirmed",
            );
            // Prior immutable plans remain in the event log; exact input/limits do not change.
            fresh.plan = await this.adapter.prepare(fresh.plan.input);
            fresh.plan.steps = fresh.plan.steps.map((step) => ({
              ...step,
              id: `${step.kind}:${randomUUID()}`,
            }));
            const { digest: _old, ...planBody } = fresh.plan;
            fresh.plan.digest = digest(planBody);
            fresh.status = "ready";
          } else {
            const body = z
              .object({
                planDigest: z.string(),
                mode: z.enum(["manual", "delegated"]),
              })
              .strict()
              .parse(raw);
            assert(
              fresh.plan.digest === body.planDigest,
              "plan_revision_conflict",
            );
            assert(
              !fresh.cancelRequested &&
                !["completed", "failed", "cancelled"].includes(fresh.status),
              "terminal_action",
            );
            assert(
              !fresh.attempts.length || fresh.mode === body.mode,
              "cannot_change_mode_after_attempt",
            );
            fresh.mode = body.mode;
            fresh.status = "running";
            delete fresh.reason;
          }
          await atomic(c, () => this.store.save(c, fresh));
          return fresh;
        },
      );
      assert(changed, "wallet_busy");
      return publicAction(changed);
    }
    if (path === "/v1/conversations" && method === "POST") {
      z.object({}).strict().parse(raw);
      const id = randomUUID();
      await this.store.pool.query(
        "INSERT INTO agent_conversations(id,user_id,app_id) VALUES($1,$2,$3)",
        [id, identity.userId, identity.appId],
      );
      return { id };
    }
    const conversation = path.match(
      /^\/v1\/conversations\/([a-f0-9-]{36})(?:\/messages)?$/,
    );
    if (conversation) {
      const r = await this.store.pool.query(
        "SELECT 1 FROM agent_conversations WHERE id=$1 AND user_id=$2 AND app_id=$3",
        [conversation[1], identity.userId, identity.appId],
      );
      assert(r.rowCount, "conversation_not_found");
      if (method === "GET")
        return (
          await this.store.pool.query(
            "SELECT id,body,status FROM agent_messages WHERE conversation_id=$1 ORDER BY (body->>'createdAt')::bigint",
            [conversation[1]],
          )
        ).rows;
      if (method === "POST") {
        assert(this.chat, "chat_unavailable");
        return this.chat.respond(identity, conversation[1], raw);
      }
    }
    throw new Error("route_not_found");
  }
  manualSignature?: (
    id: string,
    identity: Identity,
    raw: `0x${string}`,
    headers: Headers,
  ) => Promise<unknown>;
  server() {
    const server = createServer(async (req, res) => {
      try {
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers))
          if (typeof value === "string") headers.set(key, value);
        const body = await readBody(req);
        const result = await this.route(
          req.method ?? "GET",
          req.url ?? "/",
          headers,
          body,
        );
        send(res, 200, result);
      } catch (error) {
        const message =
          error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message)
            ? error.message
            : "request_failed";
        send(res, message.includes("authentication") ? 401 : 400, {
          error: message,
        });
      }
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    return server;
  }
}
export async function readBody(req: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    assert(size <= 262_144, "body_too_large");
    chunks.push(chunk);
  }
  if (!size) return {};
  assert(
    req.headers["content-type"]?.includes("application/json"),
    "json_required",
  );
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
export function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}
