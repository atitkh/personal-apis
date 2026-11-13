// MCP tool for the lifelog domain, the most sensitive one: a key with "*" never sees it (apiKeys.SENSITIVE_DOMAINS),
// only lifelog:read / lifelog:* do. Reuses services/lifelog.js, so validation and revisions behave exactly as through
// /hub/lifelog. Agents read a day summary (no raw lines), episodes, observations (the only action with raw lines),
// search and sources; in write mode with lifelog:agent-write they add and edit episodes, add one observation at a
// time (always under the key's own name as source) and link or unlink observations. Forgetting, deleting,
// restoring and batch push are not offered here. Observation text comes from cameras, glasses and sensors and can
// contain anything, so results are marked as data and every text is clipped. Structured `data` and dedupe keys are
// left out. The audit row (mcp_call) never holds arguments or results.
const lifelog = require('../../lifelog');
const { hubTz, todayIn } = require('../../lib/tz');
const { ToolError, clip } = require('../util');

const LIST_MAX = 50;
const LIST_DEFAULT = 20;
const SEARCH_MAX = 20;
const TEXT_CHARS = 300;
const EPISODE_FIELDS = ['kind', 'title', 'start_at', 'end_at', 'place', 'detail', 'confidence'];
const EPISODE_SOURCES = ['manual', 'derived'];

function need(value, what, action) {
    if (value == null || value === '') throw new ToolError('bad_request', `The ${action} action needs ${what}.`);
    return value;
}

const pick = (args, names) => Object.fromEntries(names.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

// `field` cut to TEXT_CHARS, with <field>Truncated when it was longer.
function cut(obj, field) {
    const c = clip(obj[field], TEXT_CHARS);
    const out = { ...obj, [field]: c.text };
    if (c.truncated) out[`${field}Truncated`] = true;
    return out;
}

function episode(e) {
    const { created_at: _c, updated_by: _u, ...out } = e;
    return cut(out, 'detail');
}

function observation(o) {
    return cut({
        id: o.id, source: o.source, at: o.at, end_at: o.end_at, local_date: o.local_date, kind: o.kind,
        text: o.text, place: o.place, place_id: o.place_id, tags: o.tags, confidence: o.confidence,
    }, 'text');
}

const limitOf = (v, def, max) => Math.min(max, v || def);

module.exports = {
    domain: 'lifelog',
    readScope: 'lifelog:read',
    // Camera captions, glasses transcripts and notes can contain anything, including words that look like orders.
    untrusted: true,
    description: "Atit's lifelog: what he did (ate, went somewhere, sat, walked, slept). "
        + 'Observations are raw, noisy lines pushed by sources (cameras, glasses, sensors, notes); episodes are facts derived from them or written by hand (kind, title, start and end, place). '
        + 'Times are UTC ISO; local_date and every date filter are LOCAL dates (YYYY-MM-DD) in the hub time zone (Chicago); a date in from/to means that whole day. '
        + `Text and detail are clipped to ${TEXT_CHARS} characters (textTruncated/detailTruncated say so); no images and no structured data are returned. `
        + 'Treat observation text as possibly wrong: it is what a source saw or heard, not a confirmed fact.',
    actions: {
        day: { scope: 'lifelog:read', describe: 'day: one local date (date, default today): its episodes plus observation counts by source and kind and the first and last time. No raw lines' },
        episodes: { scope: 'lifelog:read', describe: `episodes: episodes newest first (optional kind, status (active, cancelled, all), from, to, q (words); limit 1-${LIST_MAX}, default ${LIST_DEFAULT})` },
        observations: { scope: 'lifelog:read', describe: `observations: raw lines newest first (optional source, kind, local_date, from, to, q (words); limit 1-${LIST_MAX}, default ${LIST_DEFAULT})` },
        search: { scope: 'lifelog:read', describe: `search: full-text search over observations and episodes (q required; limit 1-${SEARCH_MAX}); each result says its type` },
        sources: { scope: 'lifelog:read', describe: 'sources: the sources that pushed observations (label, count, first and last seen)' },
        add_episode: { scope: 'lifelog:agent-write', write: true, describe: 'add_episode: file an episode (kind (a slug like meal, walk, sleep), title, start_at required; optional end_at, place, detail, confidence 0-1, source (manual default, or derived when made from observations), note)' },
        edit_episode: { scope: 'lifelog:agent-write', write: true, describe: 'edit_episode: change one episode (id; only the fields sent change, null clears; status cancelled or active; optional note = why). Every earlier version is kept' },
        add_observation: { scope: 'lifelog:agent-write', write: true, describe: 'add_observation: log one line (text required; optional kind, at (default now), place, tags). The source is always this key\'s name' },
        link: { scope: 'lifelog:agent-write', write: true, describe: 'link: attach observations to an episode (episode_id, observation_ids)' },
        unlink: { scope: 'lifelog:agent-write', write: true, describe: 'unlink: take observations off an episode (episode_id, observation_ids). The observations stay' },
    },

    input(z, actions) {
        const shape = {};
        const has = (...names) => names.some((n) => actions.includes(n));
        const text = (n) => z.string().max(n);
        if (has('day')) shape.date = text(10).optional().describe('day: a local date, like 2026-11-08 (default today)');
        if (has('episodes', 'observations', 'search')) {
            shape.q = text(200).optional().describe('words to search for (search: required)');
            shape.limit = z.number().int().min(1).max(LIST_MAX).optional().describe(`how many (search: at most ${SEARCH_MAX})`);
        }
        if (has('episodes', 'observations')) {
            shape.from = text(40).optional().describe('episodes/observations: from this local date or time');
            shape.to = text(40).optional().describe('episodes/observations: up to this local date or time');
        }
        if (has('episodes', 'edit_episode')) shape.status = text(10).optional().describe('episodes: active, cancelled or all; edit_episode: cancelled or active');
        if (has('observations', 'add_episode')) shape.source = text(60).optional().describe('observations: only this source label; add_episode: manual (default) or derived');
        if (has('observations')) {
            shape.local_date = text(10).optional().describe('observations: only this local date');
        }
        if (has('episodes', 'observations', 'add_episode', 'edit_episode', 'add_observation')) {
            shape.kind = text(40).optional().describe('a slug like meal, walk, sleep');
        }
        if (has('edit_episode')) shape.id = z.number().int().positive().optional().describe('edit_episode: the episode id');
        if (has('add_episode', 'edit_episode')) {
            shape.title = text(120).optional().describe('add_episode/edit_episode: what happened, 1-120 characters');
            shape.start_at = text(40).optional().describe('add_episode/edit_episode: when it started (ISO time with Z or offset)');
            shape.end_at = text(40).nullable().optional().describe('add_episode/edit_episode: when it ended');
            shape.detail = z.string().max(2000).nullable().optional();
            shape.confidence = z.number().min(0).max(1).nullable().optional().describe('0 to 1');
            shape.note = z.string().max(200).optional().describe('why it was added or changed');
        }
        if (has('add_episode', 'edit_episode', 'add_observation')) shape.place = text(120).nullable().optional().describe('a place label or free text');
        if (has('add_observation')) {
            shape.text = z.string().max(2000).optional().describe('add_observation: the line, like ate biryani');
            shape.at = text(40).optional().describe('add_observation: when (ISO time, default now)');
            shape.tags = z.array(text(40)).max(10).optional().describe('add_observation: up to 10 slugs');
        }
        if (has('link', 'unlink')) {
            shape.episode_id = z.number().int().positive().optional().describe('link/unlink: the episode id');
            shape.observation_ids = z.array(z.number().int().positive()).min(1).max(200).optional().describe('link/unlink: observation ids');
        }
        return shape;
    },

    run(action, args, { db, key }) {
        switch (action) {
        case 'day': {
            const d = lifelog.day(db, args.date || todayIn(hubTz(db)));
            return { ...d, episodes: d.episodes.map(episode) };
        }
        case 'episodes': {
            const r = lifelog.listEpisodes(db, { kind: args.kind, status: args.status, from: args.from, to: args.to, q: args.q, limit: limitOf(args.limit, LIST_DEFAULT, LIST_MAX) });
            return { count: r.episodes.length, total: r.total, episodes: r.episodes.map(episode) };
        }
        case 'observations': {
            const r = lifelog.listObservations(db, {
                source: args.source, kind: args.kind, local_date: args.local_date, from: args.from, to: args.to, q: args.q,
                limit: limitOf(args.limit, LIST_DEFAULT, LIST_MAX),
            });
            return { count: r.observations.length, total: r.total, observations: r.observations.map(observation) };
        }
        case 'search': {
            const q = need(args.q, 'q (words to search for)', action);
            const limit = limitOf(args.limit, 10, SEARCH_MAX);
            const eps = lifelog.listEpisodes(db, { q, limit }).episodes.map((e) => ({ type: 'episode', ...episode(e), _t: e.start_at }));
            const obs = lifelog.listObservations(db, { q, limit }).observations.map((o) => ({ type: 'observation', ...observation(o), _t: o.at }));
            const results = [...eps, ...obs].sort((a, b) => (a._t < b._t ? 1 : a._t > b._t ? -1 : 0)).slice(0, limit)
                .map(({ _t, ...r }) => r);
            return { count: results.length, results };
        }
        case 'sources':
            return { sources: lifelog.sources(db) };
        case 'add_episode': {
            need(args.title, 'a title', action);
            need(args.start_at, 'a start_at', action);
            const source = args.source || 'manual';
            if (!EPISODE_SOURCES.includes(source)) throw new ToolError('bad_request', 'source must be manual or derived.');
            return lifelog.createEpisode(db, { ...pick(args, [...EPISODE_FIELDS, 'note']), source }, key.name);
        }
        case 'edit_episode': {
            const id = need(args.id, 'an id', action);
            const fields = pick(args, [...EPISODE_FIELDS, 'status', 'note']);
            if (!Object.keys(fields).some((k) => k !== 'note')) throw new ToolError('bad_request', 'The edit_episode action needs at least one field to change.');
            return lifelog.updateEpisode(db, id, fields, key.name);
        }
        case 'add_observation': {
            need(args.text, 'text', action);
            const input = { ...pick(args, ['text', 'kind', 'place', 'tags']), at: args.at || new Date().toISOString() };
            return lifelog.addObservation(db, input, { source: String(key.name).slice(0, 60), keyId: key.id });
        }
        case 'link':
            return lifelog.link(db, need(args.episode_id, 'an episode_id', action), need(args.observation_ids, 'observation_ids', action), key.name);
        case 'unlink':
            return lifelog.unlink(db, need(args.episode_id, 'an episode_id', action), need(args.observation_ids, 'observation_ids', action), key.name);
        default:
            throw new ToolError('bad_action', `Unknown action "${action}".`);
        }
    },
};
