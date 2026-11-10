// Runs before the first paint (classic script, not a module) so the right theme is there from the start.
// theme.js owns the setting after that; both use the same storage key.
(function () {
    var pref = 'system';
    try { pref = localStorage.getItem('hub-theme') || 'system'; } catch (e) { /* storage blocked */ }
    var dark = pref === 'dark' || (pref !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme-pref', pref);
}());
