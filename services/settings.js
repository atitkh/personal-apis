// Hub settings: typed key/value rows in hub_settings (migration 014), admin-only. A key without a row has its default.
// Editable keys are the ones in DEFS (validated here); internal keys (last_backup_error) are written by the services.
//   timezone            IANA zone the hub calls "today" in (default DIGEST_TZ, else America/Chicago)
//   backup.enabled      bool, default true
//   backup.dir          absolute path, default <data dir>/backups
//   backup.every_hours  integer 1..168, default 24
//   backup.keep         integer 1..90, default 7
//   backup.verify_after bool, default true: check each scheduled backup after writing it
//   lifelog.retention_days  integer 1..36500 or null (default null = keep forever). Stored only: no job deletes
//                       anything yet, and the Settings page does not show it.
const path = require('path');

class SettingError extends Error {
    constructor(message, key) {
        super(message);
        this.name = 'SettingError';
        this.status = 400;
        this.code = 'bad_setting';
        this.key = key;
    }
}

const FALLBACK_TZ = 'America/Chicago';
const defaultTz = () => process.env.DIGEST_TZ || FALLBACK_TZ;

function validTz(v) {
    if (typeof v !== 'string' || !v.trim() || v.length > 60) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: v.trim() }); return true; } catch (e) { return false; }
}

const bool = (key) => (v) => {
    if (v === true || v === 'true' || v === '1' || v === 1) return true;
    if (v === false || v === 'false' || v === '0' || v === 0) return false;
    throw new SettingError(`${key} must be true or false.`, key);
};
const int = (key, min, max) => (v) => {
    const n = typeof v === 'number' ? v : /^\s*\d+\s*$/.test(String(v)) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) throw new SettingError(`${key} must be a whole number from ${min} to ${max}.`, key);
    return n;
};

// Each def: parse (value -> clean value, throws SettingError), serialize (clean -> text), read (text -> value), def(conn) default.
const DEFS = {
    timezone: {
        parse: (v) => {
            if (!validTz(v)) throw new SettingError('timezone must be an IANA time zone name such as America/Chicago.', 'timezone');
            return String(v).trim();
        },
        def: () => defaultTz(),
    },
    'backup.enabled': { parse: bool('backup.enabled'), def: () => true },
    'backup.dir': {
        parse: (v) => {
            if (typeof v !== 'string' || !v.trim()) throw new SettingError('backup.dir must be a folder path.', 'backup.dir');
            const s = v.trim();
            if (s.length > 500 || s.includes('\0')) throw new SettingError('backup.dir is not a usable path.', 'backup.dir');
            if (!path.isAbsolute(s)) throw new SettingError('backup.dir must be an absolute path (it starts with /).', 'backup.dir');
            return path.resolve(s);
        },
        def: (conn) => defaultBackupDir(conn),
    },
    'backup.every_hours': { parse: int('backup.every_hours', 1, 168), def: () => 24 },
    'backup.keep': { parse: int('backup.keep', 1, 90), def: () => 7 },
    'backup.verify_after': { parse: bool('backup.verify_after'), def: () => true },
    'lifelog.retention_days': { parse: int('lifelog.retention_days', 1, 36500), def: () => null },
};
const KEYS = Object.keys(DEFS);
const INTERNAL = ['last_backup_error'];

// <data dir>/backups, or null for an in-memory database.
function defaultBackupDir(conn) {
    if (!conn || conn.memory || !conn.name) return null;
    return path.join(path.dirname(conn.name), 'backups');
}

function raw(conn, key) {
    const row = conn.prepare('SELECT value FROM hub_settings WHERE key = ?').get(key);
    return row ? row.value : undefined;
}

// The value of one setting: the stored one if it is still valid, else the default.
function get(conn, key) {
    if (!DEFS[key]) throw new SettingError(`Unknown setting ${String(key).slice(0, 40)}.`, key);
    const text = raw(conn, key);
    if (text !== undefined) {
        try { return DEFS[key].parse(text); } catch (e) { /* a bad stored value falls back to the default */ }
    }
    return DEFS[key].def(conn);
}

const isDefault = (conn, key) => raw(conn, key) === undefined;

// Every editable setting: { values, defaults, changed } (changed: keys that have their own row).
function all(conn) {
    const values = {};
    const defaults = {};
    const custom = [];
    for (const k of KEYS) {
        values[k] = get(conn, k);
        defaults[k] = DEFS[k].def(conn);
        if (!isDefault(conn, k)) custom.push(k);
    }
    return { values, defaults, custom };
}

// Validates and stores one setting. A null/empty value for backup.dir (or any key) goes back to the default (row removed).
// Returns { key, old, new } with the effective values; unchanged settings return changed false.
function set(conn, key, value) {
    if (!DEFS[key]) throw new SettingError(`Unknown setting ${String(key).slice(0, 40)}.`, key);
    const old = get(conn, key);
    if (value === null || (typeof value === 'string' && !value.trim() && key === 'backup.dir')) {
        conn.prepare('DELETE FROM hub_settings WHERE key = ?').run(key);
        const now = get(conn, key);
        return { key, old, new: now, changed: old !== now };
    }
    const clean = DEFS[key].parse(value);
    conn.prepare('INSERT INTO hub_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .run(key, String(clean), new Date().toISOString());
    return { key, old, new: clean, changed: old !== clean };
}

// Internal text values (last_backup_error): not validated as settings, never editable through the admin API.
function getInternal(conn, key) {
    if (!INTERNAL.includes(key)) throw new SettingError(`Unknown setting ${String(key).slice(0, 40)}.`, key);
    const v = raw(conn, key);
    return v === undefined ? null : v;
}
function setInternal(conn, key, value) {
    if (!INTERNAL.includes(key)) throw new SettingError(`Unknown setting ${String(key).slice(0, 40)}.`, key);
    if (value == null) conn.prepare('DELETE FROM hub_settings WHERE key = ?').run(key);
    else {
        conn.prepare('INSERT INTO hub_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
            .run(key, String(value).slice(0, 500), new Date().toISOString());
    }
}

module.exports = { get, set, all, getInternal, setInternal, defaultBackupDir, validTz, SettingError, KEYS, FALLBACK_TZ };
