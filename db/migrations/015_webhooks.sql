-- Webhooks: where the hub pushes briefing changes (an item appears, escalates, or resolves). Admin-only, set in the
-- dashboard; never reachable over /hub or MCP. The URL and secret are credentials: the API shows only the host.
-- webhook_state remembers what was last sent per item, so an unchanged item sends nothing however often the check runs.
-- webhook_outbox holds each event until it is delivered (retries with backoff) and keeps a short history.

CREATE TABLE webhooks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    url           TEXT NOT NULL,
    auth_mode     TEXT NOT NULL DEFAULT 'bearer' CHECK (auth_mode IN ('bearer', 'hmac', 'none')),
    secret        TEXT,
    min_severity  TEXT NOT NULL DEFAULT 'attention' CHECK (min_severity IN ('info', 'attention', 'urgent')),
    domains       TEXT,
    send_resolved INTEGER NOT NULL DEFAULT 0,
    enabled       INTEGER NOT NULL DEFAULT 1,
    baseline_done INTEGER NOT NULL DEFAULT 0,
    last_status   TEXT,
    last_at       TEXT,
    last_error    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE webhook_state (
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    item_id    TEXT NOT NULL,
    domain     TEXT NOT NULL,
    severity   TEXT NOT NULL,
    text       TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('active', 'resolved')),
    n          INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (webhook_id, item_id)
);

CREATE TABLE webhook_outbox (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_id      INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_id        TEXT NOT NULL,
    state           TEXT NOT NULL,
    item_id         TEXT NOT NULL,
    payload         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error      TEXT,
    created_at      TEXT NOT NULL,
    sent_at         TEXT
);
CREATE INDEX webhook_outbox_due ON webhook_outbox (status, next_attempt_at);
CREATE INDEX webhook_outbox_hook ON webhook_outbox (webhook_id, id);
