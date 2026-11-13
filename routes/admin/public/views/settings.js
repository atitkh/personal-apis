// Settings, two columns: a sub-nav (#/settings/<section>) and one section at a time: general (time zone),
// appearance (theme), account (session, sign out), backups (settingsForms.js), webhooks (webhooksSection.js),
// shortcuts (shortcuts.js) and about (facts from /overview). Stacked on phones.
import { h, button, segmented, when, bytes, span, plural, fact, dot, pageHeader } from '../ui.js';
import * as router from '../router.js';
import { SETTINGS_SECTIONS, DEFAULT_SETTINGS_SECTION } from '../settingsNav.js';
import { shortcutList } from '../shortcuts.js';
import { THEMES, preference, setPreference, onThemeChange } from '../theme.js';
import { timezoneSection, backupSection, everyWords } from './settingsForms.js';
import { webhooksSection } from './webhooksSection.js';

function timeLeft(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (!(ms > 0)) return 'ended';
    return `${span(Math.round(ms / 1000))} left`;
}

export async function render(ctx) {
    const [o, session, conf, hooks] = await Promise.all([ctx.api('/overview'), ctx.api('/session'), ctx.api('/settings'), ctx.api('/webhooks')]);

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

    const sections = {
        general: () => [timezoneSection(ctx, conf)],
        appearance: () => [
        h('section', { class: 'panel setting', 'aria-labelledby': 's-theme' },
            h('div', {}, h('h2', { id: 's-theme', text: 'Theme' }),
                h('p', { class: 'note', text: 'System follows your device. The choice is kept in this browser.' })),
            theme)],
        account: () => [
        h('section', { class: 'panel setting', 'aria-labelledby': 's-session' },
            h('div', {}, h('h2', { id: 's-session', text: 'Session' }),
                h('p', { class: 'note' }, session.expiresAt ? [`Signed in until ${when(session.expiresAt)} (`, left, '). Sessions last 12 hours; signing in again starts a new one.'] : 'Signed in.')),
            button({ text: 'Sign out', variant: 'quiet', iconName: 'signout', onClick: ctx.signOut }))],
        backups: () => [backupSection(ctx, conf)],
        webhooks: () => [webhooksSection(ctx, hooks)],
        shortcuts: () => [
        h('section', { class: 'panel', 'aria-labelledby': 's-keys' },
            h('h2', { id: 's-keys', text: 'Keyboard shortcuts' }),
            h('p', { class: 'note', text: 'Letter keys work anywhere except while you type in a field. Press ? to see this list from any page.' }),
            shortcutList())],
        about: () => [
        h('section', { class: 'panel', 'aria-labelledby': 's-about' },
            h('h2', { id: 's-about', text: 'This hub' }),
            h('dl', { class: 'facts about' },
                fact('Version', `${o.app.name} ${o.app.version}`),
                fact('Running for', span(o.app.uptimeSeconds)),
                fact('Runtime', `Node ${o.app.node.replace(/^v/, '')}, ${o.app.environment}`),
                fact('Database', dot(o.database.status === 'healthy' ? 'good' : 'bad'), `${o.database.status === 'healthy' ? 'Healthy' : 'Not responding'}, ${bytes(o.database.bytes)}`, o.database.walBytes ? ` plus ${bytes(o.database.walBytes)} of recent writes` : ''),
                fact('Schema', `${plural(o.database.migrations, 'migration')} applied`),
                fact('Backups', o.backups.newest ? `${plural(o.backups.count, 'copy', 'copies')}, newest ${when(o.backups.newest.modifiedAt)}` : 'None yet', conf.status.enabled ? ` (${everyWords(conf.status.everyHours)})` : ' (automatic backups are off)')))],
    };

    const known = (id) => SETTINGS_SECTIONS.some((s) => s.id === id);
    const active = known(ctx.route.parts[0]) ? ctx.route.parts[0] : DEFAULT_SETTINGS_SECTION;
    const subnav = h('nav', { class: 'subnav', 'aria-label': 'Settings sections' },
        h('ul', {}, SETTINGS_SECTIONS.map((s) => h('li', {},
            h('a', { class: 'subnav-link', href: router.href('settings', [s.id]), 'data-key': `settings-nav-${s.id}`, 'aria-current': s.id === active ? 'page' : null, text: s.title })))));

    return h('div', { class: 'view settings' },
        pageHeader({ lede: 'How the hub looks, how long you stay signed in, and how it keeps itself safe. Pick a section on the left.' }),
        h('div', { class: 'settings-layout' },
            subnav,
            h('div', { class: 'settings-panel', 'data-section': active }, sections[active]())));
}
