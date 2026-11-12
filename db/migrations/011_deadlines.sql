-- Deadlines: dates Atit must not miss (documents, insurance, licences, subscriptions, bills, casual tasks).
-- The model is described at the top of services/deadlines.js. Dates are LOCAL dates (YYYY-MM-DD, no zone).
-- Windows are custom per item: attention starts lead_days before the due date, urgent starts urgent_days before.

CREATE TABLE deadlines (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
    kind        TEXT NOT NULL CHECK (kind IN ('document', 'insurance', 'license', 'subscription', 'membership', 'bill', 'task', 'other')),
    due_date    TEXT NOT NULL CHECK (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    due_time    TEXT CHECK (due_time IS NULL OR due_time GLOB '[0-2][0-9]:[0-5][0-9]'),
    repeat_kind TEXT NOT NULL DEFAULT 'none' CHECK (repeat_kind IN ('none', 'yearly', 'monthly', 'every_n_months')),
    repeat_n    INTEGER CHECK (repeat_n IS NULL OR repeat_n >= 1),
    lead_days   INTEGER NOT NULL DEFAULT 14 CHECK (lead_days BETWEEN 0 AND 730),
    urgent_days INTEGER NOT NULL DEFAULT 3 CHECK (urgent_days BETWEEN 0 AND 730),
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'ended')),
    reference   TEXT CHECK (reference IS NULL OR length(reference) <= 120),   -- private: only in answers to deadlines:read keys, never in audit or logs
    issuer      TEXT,
    amount_cents INTEGER,              -- money fields: subscription, membership and bill only (checked in code)
    currency    TEXT CHECK (currency IS NULL OR length(currency) = 3),
    cycle       TEXT CHECK (cycle IS NULL OR cycle IN ('weekly', 'monthly', 'quarterly', 'yearly')),
    auto_renew  INTEGER CHECK (auto_renew IS NULL OR auto_renew IN (0, 1)),
    cancel_by   TEXT CHECK (cancel_by IS NULL OR cancel_by GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    trip_id     INTEGER,               -- a flights trip; no foreign key, so a future trips domain can own it
    notes       TEXT,
    done_at     TEXT,                  -- UTC ISO of the last time it was marked done
    current_rev INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT NOT NULL,
    CHECK ((repeat_kind = 'every_n_months' AND repeat_n IS NOT NULL) OR (repeat_kind != 'every_n_months' AND repeat_n IS NULL)),
    CHECK (urgent_days <= lead_days)
);
CREATE INDEX deadlines_due ON deadlines (status, due_date);

-- Every version of a deadline (all editable fields as they were after the change). Revision 1 is what was first
-- filed and is never rewritten; a restore is itself a new revision.
CREATE TABLE deadline_revisions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    deadline_id INTEGER NOT NULL REFERENCES deadlines (id) ON DELETE CASCADE,
    rev         INTEGER NOT NULL,
    snapshot    TEXT NOT NULL,         -- JSON of the editable fields (reference included)
    source      TEXT NOT NULL,         -- create | edit | done | end | restore
    actor       TEXT NOT NULL,
    note        TEXT,
    at          TEXT NOT NULL,
    UNIQUE (deadline_id, rev)
);
