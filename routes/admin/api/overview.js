// The dashboard numbers: overview, the Today card (briefing) and the per-day series.
const stats = require('../../../services/adminStats');
const briefing = require('../../../services/briefing');

module.exports = (api, ctx) => {
    const { db } = ctx;

    api.get('/overview', (req, res) => res.json(stats.overview()));
    // The Today card: every domain (the admin sees them all), `days` clamped 1..90.
    api.get('/briefing', (req, res) => res.json(briefing.collect(db.get(), { days: req.query.days })));
    api.get('/series', (req, res) => res.json(stats.series(db.get(), { days: req.query.days })));
};
