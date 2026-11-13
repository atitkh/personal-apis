-- hub_overview and hub_briefing now have scopes of their own (overview:read, briefing:read) so they can be switched off for
-- an agent that already gets the same changes another way (a webhook). Until now every key had both tools, so every existing key
-- gets both scopes and nothing stops working; turn them off per key in the dashboard. A key with `*` already includes them.
UPDATE api_keys
SET scopes = (
    SELECT json_group_array(v) FROM (
        SELECT value AS v FROM json_each(api_keys.scopes)
        UNION ALL SELECT 'overview:read' WHERE NOT EXISTS (SELECT 1 FROM json_each(api_keys.scopes) WHERE value = 'overview:read')
        UNION ALL SELECT 'briefing:read' WHERE NOT EXISTS (SELECT 1 FROM json_each(api_keys.scopes) WHERE value = 'briefing:read')
    )
)
WHERE NOT EXISTS (SELECT 1 FROM json_each(api_keys.scopes) WHERE value = '*');
