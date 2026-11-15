-- hub_search has a scope of its own (search:read), like hub_overview and hub_briefing (migration 016): an agent that does
-- not need to search can be kept from it. Until now no such tool existed, so giving every existing key the scope changes
-- nothing that was reachable; turn it off per key in the dashboard. A key with `*` already includes it.
UPDATE api_keys
SET scopes = (
    SELECT json_group_array(v) FROM (
        SELECT value AS v FROM json_each(api_keys.scopes)
        UNION ALL SELECT 'search:read' WHERE NOT EXISTS (SELECT 1 FROM json_each(api_keys.scopes) WHERE value = 'search:read')
    )
)
WHERE NOT EXISTS (SELECT 1 FROM json_each(api_keys.scopes) WHERE value = '*');
