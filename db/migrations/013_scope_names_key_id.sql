-- Scope names and audit by key id (hardening run 1).
-- 1. X:write -> X:api-write (REST writes for jobs and scripts) and X:edit -> X:agent-write (writes through the agent tool).
--    Same meaning. Order is kept; a scope held under both names becomes one entry. Unknown scopes are left as they are.
--    The old names stay accepted as aliases in services/apiKeys.js, so this only tidies what is stored.
UPDATE api_keys
SET scopes = (
    SELECT json_group_array(v) FROM (
        SELECT v, MIN(pos) AS first FROM (
            SELECT key AS pos,
                   CASE WHEN value LIKE '%:write' THEN substr(value, 1, length(value) - 6) || ':api-write'
                        WHEN value LIKE '%:edit' THEN substr(value, 1, length(value) - 5) || ':agent-write'
                        ELSE value END AS v
            FROM json_each(api_keys.scopes)
        ) GROUP BY v ORDER BY first
    )
)
WHERE EXISTS (SELECT 1 FROM json_each(api_keys.scopes) WHERE value LIKE '%:write' OR value LIKE '%:edit');

-- 2. Audit rows made by a key carry the key id in detail.key_id (the name stays in actor and, for mcp_call, detail.key as a
--    display snapshot), so a renamed key keeps its history. Old rows are matched by name where exactly one key has that
--    name (live or revoked); a name shared by several keys is skipped and such rows keep matching by name.
UPDATE audit_log
SET detail = json_set(COALESCE(detail, '{}'), '$.key_id', (SELECT k.id FROM api_keys k WHERE k.name = audit_log.actor))
WHERE actor NOT IN ('admin', 'anonymous')
  AND (detail IS NULL OR (json_valid(detail) AND json_type(detail) = 'object' AND json_extract(detail, '$.key_id') IS NULL))
  AND (SELECT COUNT(*) FROM api_keys k WHERE k.name = audit_log.actor) = 1;
