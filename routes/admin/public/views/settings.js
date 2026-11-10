// Settings: theme, the session (expiry, sign out), facts about this hub (from /overview) and the keyboard
// shortcuts that work today.
import { h, button, segmented, when, bytes, span, plural, fact, dot, isMac } from '../ui.js';
import { THEMES, preference, setPreference, onThemeChange } from '../theme.js';

const MOD = isMac ? '⌘' : 'Ctrl';

// [keys, '+' (pressed together) or '/' (any of them), what it does]
export const SHORTCUTS = [
    [[MOD, 'K'], '+', 'Search, jump to any page, digest or key, and run actions'],
    [['Esc'], '+', 'Close a drawer, dialog or the palette; cancel editing a digest'],
    [['←', '→', '↑', '↓'], '/', 'Move between days in the digest calendar and the 30-day strip, and between options in a selector'],
    [['Page Up', 'Page Down'], '/', 'Previous or next month in the digest calendar'],
    [['Home', 'End'], '/', 'Start or end of the week in the calendar'],
    [[MOD, 'Enter'], '+', 'Save a digest while editing'],
];

function timeLeft(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (!(ms > 0)) return 'ended';
    return `${span(Math.round(ms / 1000))} left`;
}

export async function render(ctx) {
    const [o, session] = await Promise.all([ctx.api('/overview'), ctx.api('/session')]);

    const theme = segmented({
        label: 'Theme',
        value: preference(),
        options: THEMES.map(([value, label]) => ({ value, label, icon: { system: 'system', light: 'sun', dark: 'moon' }[value] })),
        onChange: (v) => setPreference(v),
    });
    const off = onThemeChange((pref) => theme.setValue(pref));
    ctx.onCleanup(off);

    const left = h('span', { text: session.expiresAt ? timeLeft(session.expiresAt) : '' });
    const tick = setInterval(() => { if (session.expiresAt) left.textContent = timeLeft(session.expiresAt); }, 30000);
    ctx.onCleanup(() => clearInterval(tick));

    return h('div', { class: 'view settings' },
        h('section', { class: 'panel setting', 'aria-labelledby': 's-theme' },
            h('div', {}, h('h2', { id: 's-theme', text: 'Theme' }),
                h('p', { class: 'note', text: 'System follows your device. The choice is kept in this browser.' })),
            theme),
        h('section', { class: 'panel setting', 'aria-labelledby': 's-session' },
            h('div', {}, h('h2', { id: 's-session', text: 'Session' }),
                h('p', { class: 'note' }, session.expiresAt ? [`Signed in until ${when(session.expiresAt)} (`, left, '). Sessions last 12 hours; signing in again starts a new one.'] : 'Signed in.')),
            button({ text: 'Sign out', variant: 'quiet', iconName: 'signout', onClick: ctx.signOut })),
        h('section', { class: 'panel', 'aria-labelledby': 's-about' },
            h('h2', { id: 's-about', text: 'This hub' }),
            h('dl', { class: 'facts about' },
                fact('Version', `${o.app.name} ${o.app.version}`),
                fact('Running for', span(o.app.uptimeSeconds)),
                fact('Runtime', `Node ${o.app.node.replace(/^v/, '')}, ${o.app.environment}`),
                fact('Database', dot(o.database.status === 'healthy' ? 'good' : 'bad'), `${o.database.status === 'healthy' ? 'Healthy' : 'Not responding'}, ${bytes(o.database.bytes)}`, o.database.walBytes ? ` plus ${bytes(o.database.walBytes)} of recent writes` : ''),
                fact('Schema', `${plural(o.database.migrations, 'migration')} applied`),
                fact('Backups', o.backups.newest ? `${plural(o.backups.count, 'copy', 'copies')}, newest ${when(o.backups.newest.modifiedAt)}` : 'None yet'))),
        h('section', { class: 'panel', 'aria-labelledby': 's-keys' },
            h('h2', { id: 's-keys', text: 'Keyboard shortcuts' }),
            h('dl', { class: 'shortcuts' }, SHORTCUTS.map(([keys, join, text]) => [
                h('dt', {}, keys.map((k, i) => [i ? h('span', { class: 'kbd-join', text: join === '+' ? ' + ' : ' ' }) : null, h('kbd', { text: k })])),
                h('dd', { text }),
            ]))));
}
