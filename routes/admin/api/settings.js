// Settings: the hub time zone and the backup schedule. Admin session only; never over /hub or MCP.
// Shape (GET and PUT body): { timezone, backup: { enabled, dir, every_hours, keep, verify_after } }. PUT is partial: only the
// keys sent change; every one is checked before any is saved. backup.dir null (or empty) goes back to the default folder.
const settings = require('../../../services/settings');
const backup = require('../../../services/backup');

const BACKUP_KEYS = ['enabled', 'dir', 'every_hours', 'keep', 'verify_after'];

const shape = (conn) => {
    const { values, defaults, custom } = settings.all(conn);
    const pick = (v) => ({
        timezone: v.timezone,
        backup: Object.fromEntries(BACKUP_KEYS.map((k) => [k, v[`backup.${k}`]])),
    });
    return { settings: pick(values), defaults: pick(defaults), custom, status: backup.status(conn) };
};

// { timezone, backup: {..} } -> [[key, value], ...]; unknown keys are a 400.
function flatten(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new settings.SettingError('Send an object of settings.', null);
    const out = [];
    for (const [k, v] of Object.entries(body)) {
        if (k === 'timezone') out.push(['timezone', v]);
        else if (k === 'backup' && v && typeof v === 'object' && !Array.isArray(v)) {
            for (const [bk, bv] of Object.entries(v)) {
                if (!BACKUP_KEYS.includes(bk)) throw new settings.SettingError(`Unknown backup setting ${String(bk).slice(0, 40)}.`, `backup.${bk}`);
                out.push([`backup.${bk}`, bv]);
            }
        } else throw new settings.SettingError(`Unknown setting ${String(k).slice(0, 40)}.`, k);
    }
    if (!out.length) throw new settings.SettingError('Nothing to change.', null);
    return out;
}

module.exports = (api, ctx) => {
    const { db, audit } = ctx;
    const handler = (fn) => (req, res) => {
        try {
            fn(req, res, db.get());
        } catch (err) {
            if (err instanceof settings.SettingError || err instanceof backup.DirError) {
                return res.status(400).json({ error: err.message, ...(err.key ? { field: err.key } : {}) });
            }
            console.error('admin settings error:', err);
            res.status(500).json({ error: 'Something went wrong.' });
        }
    };

    api.get('/settings', handler((req, res, conn) => res.json(shape(conn))));

    api.put('/settings', handler((req, res, conn) => {
        const pairs = flatten(req.body);
        // check everything first, so a bad field saves nothing
        const clean = pairs.map(([k, v]) => {
            if (k === 'backup.dir' && v !== null && !(typeof v === 'string' && !v.trim())) backup.allowedDir(v);
            return [k, v];
        });
        const changes = [];
        conn.transaction(() => {
            for (const [k, v] of clean) {
                const r = settings.set(conn, k, v);
                if (r.changed) changes.push(r);
            }
        })();
        for (const c of changes) audit.record(conn, 'admin', 'setting_changed', { key: c.key, from: c.old, to: c.new }, req.ip);
        res.json({ ok: true, changed: changes.map((c) => c.key), ...shape(conn) });
    }));

    // Writes and deletes a small file in the folder (made if missing) and says how much room is left.
    api.post('/settings/backup-dir/test', handler((req, res) => {
        res.json(backup.checkDir(req.body && req.body.dir));
    }));
};
