-- Semantic search (optional, off by default): one vector per searchable record, from any OpenAI-compatible embeddings
-- endpoint (settings embeddings.* in hub_settings, set in the dashboard). title/snippet/date/kind are the same safe text
-- keyword search shows, so a semantic hit needs no lookup in the domain. A vector is float32, unit length.
CREATE TABLE embeddings (
    domain     TEXT NOT NULL,
    record_id  TEXT NOT NULL,
    model      TEXT NOT NULL,
    dim        INTEGER NOT NULL,
    vector     BLOB NOT NULL,
    text_hash  TEXT NOT NULL,
    title      TEXT NOT NULL,
    snippet    TEXT,
    date       TEXT,
    kind       TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (domain, record_id)
);
CREATE INDEX embeddings_model ON embeddings (model, domain);
