// Agent access (/hub/mcp): tools, what each key sees now, recent calls.
const agents = require('../../../services/mcp/agents');

module.exports = (api, ctx) => {
    const { db } = ctx;

    // ---- agent access (/hub/mcp): tools, what each key sees now, recent calls ----
    api.get('/agents', (req, res) => res.json(agents.summary(db.get())));
};
