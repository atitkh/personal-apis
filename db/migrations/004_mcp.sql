-- How agents may reach a domain through the MCP endpoint (/hub/mcp):
--   off   - the domain's tool is not offered at all
--   read  - only read actions are offered
--   write - read and write actions are offered (each still needs its own key scope)
-- A domain that is switched off (enabled = 0) is never offered, whatever this says.
ALTER TABLE hub_domains ADD COLUMN mcp_mode TEXT NOT NULL DEFAULT 'read' CHECK (mcp_mode IN ('off', 'read', 'write'));
