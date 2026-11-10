// The app frame: left rail (bottom tab bar on phones), top bar with the page title, command palette
// button, theme toggle and the account menu. Built once after sign-in; views render into `content`.
import { h, icon, button, segmented, when, span, isMac, openSheet } from './ui.js';
import * as router from './router.js';
import { THEMES, preference, setPreference, onThemeChange } from './theme.js';

const THEME_ICONS = { system: 'system', light: 'sun', dark: 'moon' };
const RAIL_KEY = 'hub-rail';

function brandMark() {
    // Three short cables into one jack: the hub as a patch bay.
    return h('span', { class: 'brand-mark', 'aria-hidden': 'true' },
        h('span', { class: 'bm a' }), h('span', { class: 'bm b' }), h('span', { class: 'bm c' }));
}

export function createShell({ session, onSignOut, openPalette, api }) {
    const navLinks = new Map();
    const routes = router.all().filter((r) => r.nav);

    const rail = h('aside', { class: 'rail', 'aria-label': 'Main' },
        h('a', { class: 'brand', href: router.href('overview') }, brandMark(), h('span', { class: 'rail-label', text: 'Personal hub' })),
        h('nav', { class: 'rail-nav', 'aria-label': 'Sections' },
            h('ul', {}, routes.map((r) => {
                const a = h('a', { href: router.href(r.name), class: 'rail-link', title: r.title }, icon(r.icon), h('span', { class: 'rail-label', text: r.title }));
                navLinks.set(r.name, [a]);
                return h('li', {}, a);
            }))));

    let collapsed = false;
    try { collapsed = localStorage.getItem(RAIL_KEY) === 'collapsed'; } catch (e) { /* default */ }
    const collapseBtn = button({
        variant: 'ghost',
        size: 'small',
        iconName: collapsed ? 'expand' : 'collapse',
        label: collapsed ? 'Expand the menu' : 'Collapse the menu',
        'aria-expanded': String(!collapsed),
        class: 'btn ghost small icon-only rail-toggle',
        onClick: () => setCollapsed(!collapsed),
    });
    // Version and uptime live quietly at the foot of the rail (and in Settings).
    const about = h('p', { class: 'rail-about rail-label' });
    let appInfo = null;
    let infoAt = 0;
    const paintAbout = () => {
        if (!appInfo) return;
        const up = appInfo.uptimeSeconds + Math.round((Date.now() - infoAt) / 1000);
        about.replaceChildren(h('span', { text: `${appInfo.name} ${appInfo.version}` }), h('span', { text: `Up ${span(up)}` }));
    };
    if (api) {
        api('/overview').then((o) => { appInfo = o.app; infoAt = Date.now(); paintAbout(); }).catch(() => {});
        const tick = setInterval(() => (about.isConnected ? paintAbout() : clearInterval(tick)), 60000);
    }
    rail.append(h('div', { class: 'rail-foot' }, about, collapseBtn));

    const frame = h('div', { class: `app${collapsed ? ' rail-collapsed' : ''}` });
    function setCollapsed(v) {
        collapsed = v;
        frame.classList.toggle('rail-collapsed', v);
        collapseBtn.replaceChildren(icon(v ? 'expand' : 'collapse'));
        collapseBtn.setAttribute('aria-label', v ? 'Expand the menu' : 'Collapse the menu');
        collapseBtn.setAttribute('aria-expanded', String(!v));
        try { localStorage.setItem(RAIL_KEY, v ? 'collapsed' : 'open'); } catch (e) { /* fine */ }
    }

    const title = h('h1', { class: 'page-title', id: 'page-title', tabindex: '-1', text: '' });

    const paletteBtn = h('button', { type: 'button', class: 'palette-btn', onclick: openPalette, 'aria-keyshortcuts': isMac ? 'Meta+K' : 'Control+K' },
        icon('search'), h('span', { class: 'palette-btn-text', text: 'Search or jump to' }),
        h('kbd', { text: isMac ? '⌘ K' : 'Ctrl K' }));

    const theme = segmented({
        label: 'Theme',
        iconOnly: true,
        cls: 'theme-toggle',
        value: preference(),
        options: THEMES.map(([value, label]) => ({ value, label: `${label} theme`, icon: THEME_ICONS[value] })),
        onChange: (v) => setPreference(v),
    });
    // Phones get one small button that steps through system, light and dark.
    const themeName = (v) => (THEMES.find(([id]) => id === v) || THEMES[0])[1];
    const themeCycle = h('button', { type: 'button', class: 'btn ghost icon-only theme-cycle' });
    const paintCycle = (pref) => {
        const i = THEMES.findIndex(([id]) => id === pref);
        const next = THEMES[(i + 1) % THEMES.length][0];
        themeCycle.replaceChildren(icon(THEME_ICONS[pref] || 'system'));
        themeCycle.setAttribute('aria-label', `Theme: ${themeName(pref).toLowerCase()}. Switch to ${themeName(next).toLowerCase()}`);
        themeCycle.title = themeCycle.getAttribute('aria-label');
        themeCycle.dataset.next = next;
    };
    themeCycle.addEventListener('click', () => setPreference(themeCycle.dataset.next));
    paintCycle(preference());
    onThemeChange((pref) => { theme.setValue(pref); paintCycle(pref); });

    // Account menu: a disclosure button with a small popover.
    const menuId = 'account-menu';
    const accountBtn = h('button', {
        type: 'button', class: 'btn ghost icon-only account-btn', 'aria-label': 'Account', 'aria-expanded': 'false', 'aria-controls': menuId,
        onclick: () => toggleMenu(),
    }, icon('user'));
    const menu = h('div', { class: 'menu', id: menuId, hidden: true },
        h('p', { class: 'menu-note', text: session && session.expiresAt ? `Signed in until ${when(session.expiresAt)}` : 'Signed in' }),
        h('a', { class: 'btn quiet small', href: router.href('settings'), onclick: () => toggleMenu(false) }, icon('settings'), h('span', { text: 'Settings' })),
        button({ text: 'Sign out', variant: 'quiet', size: 'small', iconName: 'signout', onClick: onSignOut }));
    const account = h('div', { class: 'account' }, accountBtn, menu);
    function toggleMenu(open = menu.hidden) {
        menu.hidden = !open;
        accountBtn.setAttribute('aria-expanded', String(open));
        if (open) menu.querySelector('button').focus();
    }
    document.addEventListener('mousedown', (event) => { if (!menu.hidden && !account.contains(event.target)) toggleMenu(false); });
    account.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !menu.hidden) { toggleMenu(false); accountBtn.focus(); }
    });

    const topbar = h('header', { class: 'topbar' },
        h('a', { class: 'brand brand-small', href: router.href('overview'), 'aria-label': 'Personal hub, overview' }, brandMark()),
        title,
        h('div', { class: 'topbar-tools' }, paletteBtn, theme, themeCycle, account));

    const content = h('main', { class: 'content', id: 'content', tabindex: '-1' });

    // Phones: the four most used views plus More, a bottom sheet with the rest, search and sign out.
    const rest = router.all().filter((r) => r.nav && !r.mobile);
    let currentName = null;
    const moreBtn = h('button', { type: 'button', class: 'tab', 'aria-haspopup': 'dialog', onclick: () => openMore() }, icon('more'), h('span', { text: 'More' }));
    function openMore() {
        openSheet({
            title: 'More',
            content: h('nav', { class: 'sheet-nav', 'aria-label': 'More sections' },
                h('ul', {},
                    rest.map((r) => h('li', {}, h('a', { class: 'sheet-link', href: router.href(r.name), 'aria-current': r.name === currentName ? 'page' : null }, icon(r.icon), h('span', { text: r.title })))),
                    h('li', { class: 'sheet-sep' }, h('button', { type: 'button', class: 'sheet-link', onclick: (e) => { e.target.closest('dialog').close(); openPalette(); } }, icon('search'), h('span', { text: 'Search or jump to' }))),
                    h('li', {}, h('button', { type: 'button', class: 'sheet-link', onclick: (e) => { e.target.closest('dialog').close(); onSignOut(); } }, icon('signout'), h('span', { text: 'Sign out' }))))),
        });
    }
    const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Sections' },
        h('ul', {},
            router.all().filter((r) => r.mobile).map((r) => {
                const a = h('a', { href: router.href(r.name), class: 'tab' }, icon(r.icon), h('span', { text: r.short || r.title }));
                navLinks.get(r.name).push(a);
                return h('li', {}, a);
            }),
            h('li', {}, moreBtn)));

    frame.append(
        h('a', { class: 'skip', href: '#content', onclick: (e) => { e.preventDefault(); content.focus(); }, text: 'Skip to content' }),
        rail,
        h('div', { class: 'main-col' }, topbar, content),
        tabbar);

    return {
        el: frame,
        content,
        title,
        // `[` shows or hides the rail; phones have no rail.
        toggleRail() {
            if (matchMedia('(max-width: 760px)').matches) return;
            setCollapsed(!collapsed);
        },
        setRoute(name, text) {
            currentName = name;
            moreBtn.classList.toggle('is-current', rest.some((r) => r.name === name));
            title.textContent = text;
            document.title = `${text} - Personal hub`;
            for (const [n, links] of navLinks) {
                for (const a of links) {
                    if (n === name) a.setAttribute('aria-current', 'page');
                    else a.removeAttribute('aria-current');
                }
            }
        },
    };
}
