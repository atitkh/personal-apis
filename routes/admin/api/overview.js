// The dashboard numbers: overview, the Today card (briefing) and the per-day series.
const stats = require('../../../services/adminStats');
const briefing = require('../../../services/briefing');
const statsPage = require('../../../services/stats');

module.exports = (api, ctx) => {
    const { db } = ctx;

    api.get('/overview', (req, res) => res.json(stats.overview()));
    // The Today card: every domain (the admin sees them all), `days` clamped 1..90.
    api.get('/briefing', (req, res) => res.json(briefing.collect(db.get(), { days: req.query.days })));
    api.get('/series', (req, res) => res.json(stats.series(db.get(), { days: req.query.days })));
    // The Stats page: ?range=30|90|365|all (default 90). Admin only; deadline amounts appear here and nowhere on /hub or MCP.
    api.get('/stats', (req, res) => {
        const range = statsPage.cleanRange(req.query.range);
        if (!range) return res.status(400).json({ error: 'range must be one of 30, 90, 365, all.' });
        res.json(statsPage.collect(db.get(), { range }));
    });
};
