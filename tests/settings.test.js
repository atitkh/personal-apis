const db = require('../db');
const settings = require('../services/settings');
const { hubTz, todayIn, hourIn, stampIn } = require('../services/lib/tz');
const briefing = require('../services/briefing');
const deadlines = require('../services/deadlines');

let conn;
beforeEach(() => { conn = db.open(':memory:'); delete process.env.DIGEST_TZ; });
afterEach(() => { conn.close(); delete process.env.DIGEST_TZ; });

describe('settings service', () => {
    test('defaults without any row', () => {
        expect(settings.get(conn, 'timezone')).toBe('America/Chicago');
        expect(settings.get(conn, 'backup.enabled')).toBe(true);
        expect(settings.get(conn, 'backup.dir')).toBeNull(); // in-memory db has no data dir
        expect(settings.get(conn, 'backup.every_hours')).toBe(24);
        expect(settings.get(conn, 'backup.keep')).toBe(7);
        expect(settings.get(conn, 'backup.verify_after')).toBe(true);
        expect(settings.all(conn).custom).toEqual([]);
    });

    test('the default backup folder is <data dir>/backups for a file db', () => {
        const fake = { memory: false, name: '/data/hub.db' };
        expect(settings.defaultBackupDir(fake)).toBe('/data/backups');
    });

    test('DIGEST_TZ is the default until a row exists, and a row wins', () => {
        process.env.DIGEST_TZ = 'Europe/Berlin';
        expect(settings.get(conn, 'timezone')).toBe('Europe/Berlin');
        settings.set(conn, 'timezone', 'Asia/Tokyo');
        expect(settings.get(conn, 'timezone')).toBe('Asia/Tokyo');
        settings.set(conn, 'timezone', null); // back to the default
        expect(settings.get(conn, 'timezone')).toBe('Europe/Berlin');
        process.env.DIGEST_TZ = 'Not/AZone'; // a broken env value is not validated, but a stored row is
        expect(() => settings.set(conn, 'timezone', 'Not/AZone')).toThrow(/IANA/);
    });

    test('validates every key and reports old and new', () => {
        expect(settings.set(conn, 'timezone', ' Asia/Kathmandu ')).toEqual({ key: 'timezone', old: 'America/Chicago', new: 'Asia/Kathmandu', changed: true });
        expect(settings.set(conn, 'timezone', 'Asia/Kathmandu').changed).toBe(false);
        expect(() => settings.set(conn, 'timezone', 'Mars/Base')).toThrow(settings.SettingError);
        expect(() => settings.set(conn, 'timezone', '')).toThrow(/IANA/);
        expect(settings.set(conn, 'backup.every_hours', '6').new).toBe(6);
        expect(settings.set(conn, 'backup.keep', 90).new).toBe(90);
        for (const v of [0, 169, 1.5, 'x', -1, false]) expect(() => settings.set(conn, 'backup.every_hours', v)).toThrow(/1 to 168/);
        for (const v of [0, 91, 'x']) expect(() => settings.set(conn, 'backup.keep', v)).toThrow(/1 to 90/);
        expect(settings.set(conn, 'backup.enabled', 'false').new).toBe(false);
        expect(settings.set(conn, 'backup.verify_after', false).new).toBe(false);
        expect(() => settings.set(conn, 'backup.enabled', 'yes')).toThrow(/true or false/);
        expect(() => settings.set(conn, 'backup.dir', 'rel/dir')).toThrow(/absolute/);
        expect(settings.set(conn, 'backup.dir', '/mnt/nas/../nas/hub/').new).toBe('/mnt/nas/hub');
        expect(() => settings.set(conn, 'nope', 1)).toThrow(/Unknown setting/);
        expect(() => settings.set(conn, 'last_backup_error', 'x')).toThrow(/Unknown setting/);
        expect(settings.all(conn).custom.sort()).toEqual(['backup.dir', 'backup.enabled', 'backup.every_hours', 'backup.keep', 'backup.verify_after', 'timezone']);
    });

    test('a bad stored value falls back to the default', () => {
        conn.prepare("INSERT INTO hub_settings (key, value, updated_at) VALUES ('backup.keep', '9999', 'x')").run();
        expect(settings.get(conn, 'backup.keep')).toBe(7);
    });
});

describe('tz helper', () => {
    const NOW = new Date('2026-11-12T03:30:00Z'); // 21:30 on the 11th in Chicago, 12:30 on the 12th in Tokyo
    test('todayIn, hourIn and stampIn read the clock of the zone', () => {
        expect(todayIn('America/Chicago', NOW)).toBe('2026-11-11');
        expect(todayIn('Asia/Tokyo', NOW)).toBe('2026-11-12');
        expect(hourIn('America/Chicago', NOW)).toBe(21);
        expect(stampIn('Asia/Tokyo', NOW)).toEqual({ date: '2026-11-12', hm: '1230' });
        expect(stampIn('UTC', new Date('2026-11-12T00:05:00Z'))).toEqual({ date: '2026-11-12', hm: '0005' });
    });
    test('hubTz follows the setting, then DIGEST_TZ, then America/Chicago', () => {
        expect(hubTz(conn)).toBe('America/Chicago');
        expect(hubTz(null)).toBe('America/Chicago');
        process.env.DIGEST_TZ = 'Asia/Tokyo';
        expect(hubTz(conn)).toBe('Asia/Tokyo');
        settings.set(conn, 'timezone', 'Europe/Paris');
        expect(hubTz(conn)).toBe('Europe/Paris');
    });
    test("briefing and deadlines count 'today' in the hub zone", () => {
        expect(briefing.today(NOW)).toBe('2026-11-11');
        expect(briefing.today(NOW, 'Asia/Tokyo')).toBe('2026-11-12');
        expect(deadlines.daysLeft('2026-11-20', NOW)).toBe(9);
        expect(deadlines.daysLeft('2026-11-20', NOW, 'Asia/Tokyo')).toBe(8);
        const d = deadlines.create(conn, { title: 'Passport', kind: 'document', due_date: '2026-11-12' }, 'test');
        expect(deadlines.get(conn, d.id, { now: NOW }).days_left).toBe(1);
        settings.set(conn, 'timezone', 'Asia/Tokyo');
        expect(deadlines.get(conn, d.id, { now: NOW }).days_left).toBe(0);
        expect(deadlines.list(conn, { overdue: true, now: new Date('2026-11-12T16:00:00Z') }).total).toBe(1); // already the 13th in Tokyo
        settings.set(conn, 'timezone', 'America/Chicago');
        expect(deadlines.list(conn, { overdue: true, now: new Date('2026-11-12T16:00:00Z') }).total).toBe(0);
    });
    test('the digest check and the activity series use the hub zone', () => {
        const stats = require('../services/adminStats');
        settings.set(conn, 'timezone', 'Asia/Tokyo');
        expect(stats.series(conn, { days: 1, now: NOW })).toMatchObject({ tz: 'Asia/Tokyo', days: [{ day: '2026-11-12' }] });
        expect(stats.digestWatch(conn, NOW).coverage).toBeDefined();
        settings.set(conn, 'timezone', 'America/Chicago');
        expect(stats.series(conn, { days: 1, now: NOW }).days[0].day).toBe('2026-11-11');
    });
});
