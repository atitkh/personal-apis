// Light, dark or follow the system. The choice is kept in localStorage; theme-boot.js applies it before paint.
const KEY = 'hub-theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();

export const THEMES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];

export function preference() {
    try {
        const v = localStorage.getItem(KEY);
        return THEMES.some(([id]) => id === v) ? v : 'system';
    } catch (e) {
        return 'system';
    }
}

function apply() {
    const pref = preference();
    const dark = pref === 'dark' || (pref === 'system' && media.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme-pref', pref);
    for (const fn of listeners) fn(pref);
}

export function setPreference(pref) {
    try { localStorage.setItem(KEY, pref); } catch (e) { /* storage blocked: still apply for this page */ }
    apply();
}

export function onThemeChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

media.addEventListener('change', () => { if (preference() === 'system') apply(); });
