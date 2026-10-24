CREATE TABLE IF NOT EXISTS agent_actions (
 id uuid PRIMARY KEY, user_id text NOT NULL, app_id text NOT NULL,
 wallet text NOT NULL, intent_key text NOT NULL, input_digest text NOT NULL,
 body jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,app_id,intent_key)
);
CREATE INDEX IF NOT EXISTS agent_actions_pending ON agent_actions ((body->>'status'));
CREATE TABLE IF NOT EXISTS agent_events (
 sequence bigserial PRIMARY KEY, action_id uuid NOT NULL REFERENCES agent_actions(id),
 user_id text NOT NULL, app_id text NOT NULL, body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_policies (
 user_id text NOT NULL, wallet text NOT NULL, chain_id integer NOT NULL,
 scope text NOT NULL, version integer NOT NULL, body jsonb NOT NULL,
 PRIMARY KEY(user_id,wallet,chain_id,scope)
);
CREATE TABLE IF NOT EXISTS agent_budgets (
 user_id text NOT NULL, wallet text NOT NULL, chain_id integer NOT NULL,
 scope text NOT NULL, day date NOT NULL, asset text NOT NULL,
 reserved numeric(78,0) NOT NULL DEFAULT 0 CHECK(reserved >= 0),
 spent numeric(78,0) NOT NULL DEFAULT 0 CHECK(spent >= 0),
 PRIMARY KEY(user_id,wallet,chain_id,scope,day,asset)
);
CREATE TABLE IF NOT EXISTS agent_reservations (
 action_id uuid NOT NULL REFERENCES agent_actions(id), step_id text NOT NULL,
 scope text NOT NULL, asset text NOT NULL, day date NOT NULL,
 amount numeric(78,0) NOT NULL, settled boolean NOT NULL DEFAULT false,
 PRIMARY KEY(action_id,step_id,scope,asset)
);
CREATE TABLE IF NOT EXISTS agent_conversations (
 id uuid PRIMARY KEY, user_id text NOT NULL, app_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_messages (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES agent_conversations(id),
 intent_key text NOT NULL, body jsonb NOT NULL, status text NOT NULL,
 UNIQUE(conversation_id,intent_key)
);
CREATE TABLE IF NOT EXISTS agent_usage (
 scope text NOT NULL, day date NOT NULL, reserved numeric NOT NULL DEFAULT 0,
 spent numeric NOT NULL DEFAULT 0, PRIMARY KEY(scope,day)
);

CREATE TABLE IF NOT EXISTS agent_rate_limits (
 scope text NOT NULL, minute bigint NOT NULL, requests integer NOT NULL,
 PRIMARY KEY(scope,minute)
);
