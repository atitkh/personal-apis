// Search across every enabled domain, for the dashboard, and the semantic-search settings. Admin session only. The admin
// sees all domains (lifelog episodes included); results hold the same safe text the agent tool gets: no references,
// amounts or addresses. The embeddings key is write-only: no response here ever contains it, and audit rows carry the
// names of the settings that changed, never values.
const search = require('../../../services/search');
const embeddings = require('../../../services/embeddings');
const { adminHandler } = require('../../lib/handle');

module.exports = (api, ctx) => {
    const { audit } = ctx;
    const errors = [search.SearchError, embeddings.EmbeddingError];
    class Unexpected extends Error {}
    const base = adminHandler(Unexpected, 'admin search error:', { async: true });
    // Domain errors answer at their own status; anything else is a plain 500.
    const handler = (fn) => (req, res) => {
        const wrapped = base(async (rq, rs, conn) => {
            try { await fn(rq, rs, conn); } catch (err) {
                if (errors.some((E) => err instanceof E)) return rs.status(err.status).json({ error: err.message, code: err.code });
                throw err;
            }
        });
        return wrapped(req, res);
    };

    api.get('/search', handler(async (req, res, conn) => {
        const only = typeof req.query.domains === 'string' ? req.query.domains.split(',').map((d) => d.trim()).filter(Boolean) : undefined;
        res.json(await search.searchHybrid(conn, req.query.q, { domains: only, perDomain: req.query.per_domain || 10, mode: req.query.mode }));
    }));

    const shape = (conn) => ({ settings: embeddings.publicConfig(conn), status: embeddings.status(conn) });
    api.get('/search/settings', handler((req, res, conn) => res.json(shape(conn))));

    api.put('/search/settings', handler((req, res, conn) => {
        const changed = embeddings.saveConfig(conn, req.body);
        if (changed.length) {
            audit.record(conn, 'admin', 'search_settings_changed', { fields: changed }, req.ip);
            embeddings.poke();
        }
        res.json({ ok: true, changed, ...shape(conn) });
    }));

    // Embeds one short sentence with the saved settings and reports the vector size and the time it took.
    api.post('/search/test', handler(async (req, res, conn) => {
        const started = Date.now();
        const [v] = await embeddings.embed(conn, ['Test sentence from the hub.']);
        res.json({ ok: true, dim: v.length, ms: Date.now() - started });
    }));

    api.post('/search/reindex', handler((req, res, conn) => {
        const dropped = embeddings.reset(conn);
        audit.record(conn, 'admin', 'search_reindexed', { dropped }, req.ip);
        embeddings.poke();
        res.json({ ok: true, dropped, ...shape(conn) });
    }));
};
