// Portfolio counts and the activity feed (filters by audit action).
const stats = require('../../../services/adminStats');
const { clampLimit } = require('../../../services/lib/listing');
const apiKeys = require('../../../services/apiKeys');

// Activity filters: which audit actions each chip shows.
const ACTIVITY_TYPES = {
    all: null,
    keys: ['key_created', 'key_updated', 'key_revoked'],
    agents: ['mcp_call', 'domain_mcp_changed'],
    backups: ['backup_run', 'backup_failed', 'backup_verified'],
    settings: ['setting_changed'],
    domains: ['domain_enabled', 'domain_disabled', 'domain_mcp_changed'],
    digests: ['digest_edited', 'digest_restored', 'digest_deleted'],
    places: ['place_created', 'place_updated', 'place_restored', 'place_deleted', 'place_rule_added', 'place_rule_updated', 'place_rule_removed',
        'place_suggestion_accepted', 'place_suggestion_dismissed', 'place_suggestion_deleted'],
    flights: ['flight_created', 'flight_updated', 'flight_restored', 'trip_created', 'trip_updated', 'flight_settings_changed',
        'flight_candidate_filed', 'flight_candidate_accepted', 'flight_candidate_dismissed', 'flight_refreshed', 'flight_observed', 'flight_sources_changed',
        'flight_deleted', 'trip_deleted', 'flight_candidate_deleted'],
    deadlines: ['deadline_created', 'deadline_updated', 'deadline_done', 'deadline_ended', 'deadline_restored', 'deadline_deleted'],
    trips: ['trip_created', 'trip_updated', 'trip_restored', 'trip_flight_linked', 'trip_flight_unlinked', 'trip_deleted',
        'trip_item_added', 'trip_item_updated', 'trip_item_removed', 'trip_suggestion_accepted', 'trip_suggestion_dismissed', 'trip_suggestions_restored'],
    preferences: ['preference_set', 'preference_updated', 'preference_unset', 'preference_restored', 'preference_deleted'],
    lifelog: ['lifelog_pushed', 'lifelog_observation_added', 'lifelog_episode_created', 'lifelog_episode_updated', 'lifelog_episode_restored',
        'lifelog_episode_linked', 'lifelog_episode_unlinked', 'lifelog_forgotten'],
    signins: ['login', 'logout', 'login_failed'],
};

module.exports = (api, ctx) => {
    const { db, audit } = ctx;

    api.get('/portfolio', (req, res) => res.json(stats.portfolio()));
    // ?type= one of ACTIVITY_TYPES, ?before=<id> for older events. `more` says whether older ones exist.
    api.get('/activity', (req, res) => {
        const type = req.query.type || 'all';
        if (!Object.prototype.hasOwnProperty.call(ACTIVITY_TYPES, type)) {
            return res.status(400).json({ error: `type must be one of: ${Object.keys(ACTIVITY_TYPES).join(', ')}.` });
        }
        const limit = clampLimit(req.query.limit, 50, 199);
        const rows = audit.recent(db.get(), limit + 1, { before: req.query.before, actions: ACTIVITY_TYPES[type] });
        // Rows made by a key carry its id: show the key's current name, so a rename does not split the feed.
        const names = new Map(apiKeys.list(db.get()).map((k) => [k.id, k.name]));
        const events = rows.slice(0, limit).map((e) => {
            const id = audit.keyIdOf(e.detail);
            const current = id === null ? null : names.get(id);
            if (!current || current === e.actor) return e;
            return { ...e, actor: current, detail: e.action === 'mcp_call' ? { ...e.detail, key: current } : e.detail };
        });
        res.json({ events, more: rows.length > limit });
    });
};
