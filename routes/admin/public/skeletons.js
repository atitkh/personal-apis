// Loading placeholders shaped like each view: they use the view's own layout classes, so the page does not
// jump when the data arrives. Bars only (no text); the wrapper says "Loading" to screen readers.
import { h, hidden } from './ui.js';

const bar = (cls = '') => h('div', { class: `skeleton ${cls}`.trim(), 'aria-hidden': 'true' });
const wrap = (cls, ...kids) => h('div', { class: `skel ${cls}`, 'aria-busy': 'true' }, hidden('Loading'), ...kids);
const rows = (n, make) => Array.from({ length: n }, (_, i) => make(i));

function tableRows(n, cols = 4, head = '') {
    return h('div', { class: 'table-wrap skel-table' },
        h('div', { class: `skel-thead ${head}`.trim() }, rows(cols, () => bar('sk-xs'))),
        rows(n, () => h('div', { class: 'skel-tr' }, bar('sk-name'), rows(cols - 1, () => bar('sk-cell')))));
}

const lede = () => h('div', { class: 'skel-lede' }, bar('sk-line w-80'), bar('sk-line w-80 sk-narrow'), bar('sk-line w-50'));

function calendar() {
    return h('section', { class: 'panel cal-panel' },
        h('div', { class: 'cal-top' }, bar('sk-title w-40'), bar('sk-pill')),
        h('div', { class: 'cal' },
            h('div', { class: 'cal-row cal-head' }, rows(7, () => h('div', { class: 'cal-wd' }, bar('sk-xs w-50')))),
            rows(6, () => h('div', { class: 'cal-row' }, rows(7, () => h('div', { class: 'cal-cell' }, bar('sk-day')))))),
        bar('sk-xs w-80'),
        bar('sk-line w-70'), bar('sk-line w-50'));
}

const SHAPES = {
    overview: () => wrap('overview',
        h('header', { class: 'page-header' }, h('div', { class: 'page-header-main' }, h('p', { class: 'lede' }, bar('sk-line w-60')))),
        h('div', { class: 'overview-top' },
            h('section', { class: 'panel sk-panel' }, bar('sk-line w-30'), bar('sk-line w-80'), bar('sk-line w-60')),
            h('section', { class: 'panel sk-panel' }, bar('sk-line w-30'), bar('sk-line w-80'), bar('sk-line w-70'))),
        h('section', { class: 'board' },
            h('div', { class: 'board-head' }, bar('sk-title w-20'), bar('sk-line w-70'), bar('sk-line w-70'), bar('sk-line w-20')),
            h('ul', { class: 'channels' }, rows(3, (i) => h('li', { class: 'channel' },
                h('div', { class: 'ch-name' }, bar('sk-name-lg w-60'), bar('sk-line w-80'), i === 0 ? bar('sk-line w-70') : null, bar('sk-xs w-50')),
                h('div', { class: 'ch-power' }, bar('sk-switch')),
                h('div', { class: 'ch-route' }, bar('sk-cable'), bar('sk-xs w-40')),
                h('div', { class: 'ch-mode' }, bar('sk-seg')))))),
        h('section', { class: 'panel sk-panel' }, bar('sk-line w-40'), bar('sk-block'))),

    digests: (route) => (route.parts.length >= 2
        ? wrap('reader-layout',
            h('div', { class: 'view reader' },
                h('div', { class: 'reader-head' }, bar('sk-read w-30'), bar('sk-display w-60'), bar('sk-line w-70')),
                h('div', { class: 'reader-tools' }, bar('sk-pill'), bar('sk-pill')),
                h('div', { class: 'skel-reading' }, rows(4, (i) => h('div', { class: 'skel-para' }, bar('sk-read'), bar('sk-read'), bar('sk-read'), bar(`sk-read w-${[60, 80, 40, 70][i]}`))))),
            h('aside', { class: 'reader-side' }, calendar()))
        : wrap('view digests',
            lede(),
            h('div', { class: 'toolbar' }, h('div', { class: 'row' }, bar('sk-chip'), bar('sk-chip')), bar('sk-search')),
            h('div', { class: 'digests-browse' }, calendar(),
                h('section', { class: 'panel dl-panel' }, h('div', { class: 'panel-head' }, bar('sk-title w-30')),
                    rows(5, () => h('div', { class: 'dl-item' }, bar('sk-read w-50'), bar('sk-line w-80'))))))),

    places: (route) => wrap('view places',
        h('div', { class: 'page-header' }, h('div', { class: 'page-header-main lede' }, bar('sk-line w-90'), bar('sk-line w-80 sk-narrow'), bar('sk-line w-60')), bar('sk-button')),
        h('div', { class: 'vtabs' }, bar('sk-tab'), bar('sk-tab')),
        route.query.get('tab') === 'queue'
            ? h('div', { class: 'tab-panel' }, bar('sk-line w-80'),
                h('div', { class: 'row' }, rows(4, () => bar('sk-chip'))),
                h('section', { class: 'skel-stack' }, bar('sk-title w-20'),
                    h('ul', { class: 'queue-list' }, rows(3, () => h('li', { class: 'queue-item' },
                        h('div', { class: 'q-main' }, bar('sk-read w-40'), bar('sk-line w-70'), bar('sk-line w-50')),
                        h('div', { class: 'q-actions' }, bar('sk-pill'), bar('sk-pill')))))))
            : h('div', { class: 'tab-panel' },
                h('section', { class: 'panel check-box sk-check' }, bar('sk-line w-30')),
                h('div', { class: 'toolbar' }, h('div', { class: 'row' }, bar('sk-chip'), bar('sk-chip'), bar('sk-chip')), bar('sk-search')),
                h('section', { class: 'skel-stack' }, bar('sk-title w-20'), tableRows(5, 5)))),

    flights: (route) => wrap('view flights',
        h('div', { class: 'page-header' }, h('div', { class: 'page-header-main lede' }, bar('sk-line w-90'), bar('sk-line w-80 sk-narrow'), bar('sk-line w-60')), bar('sk-button')),
        h('div', { class: 'vtabs' }, bar('sk-tab'), bar('sk-tab'), bar('sk-tab')),
        route.query.get('tab') === 'found'
            ? h('div', { class: 'tab-panel' }, bar('sk-line w-80'),
                h('section', { class: 'skel-stack' }, bar('sk-title w-20'),
                    h('ul', { class: 'queue-list' }, rows(3, () => h('li', { class: 'queue-item' },
                        h('div', { class: 'q-main' }, bar('sk-read w-40'), bar('sk-line w-70'), bar('sk-line w-50')),
                        h('div', { class: 'q-actions' }, bar('sk-pill'), bar('sk-pill')))))))
            : route.query.get('tab') === 'flights' || route.parts.length
                ? h('div', { class: 'tab-panel' },
                    h('div', { class: 'toolbar' }, h('div', { class: 'row' }, bar('sk-chip'), bar('sk-chip'), bar('sk-chip')), bar('sk-search')),
                    h('section', { class: 'skel-stack' }, bar('sk-title w-20'), tableRows(5, 6)))
                : h('div', { class: 'tab-panel' },
                    h('div', { class: 'row' }, rows(4, () => bar('sk-chip'))),
                    h('div', { class: 'count-grid' }, rows(6, () => bar('sk-tile'))),
                    bar('sk-map'))),

    deadlines: () => wrap('view deadlines',
        h('div', { class: 'page-header' }, h('div', { class: 'page-header-main lede' }, bar('sk-line w-90'), bar('sk-line w-60')), bar('sk-button')),
        h('div', { class: 'vtabs' }, bar('sk-tab'), bar('sk-tab'), bar('sk-tab')),
        h('div', { class: 'tab-panel' },
            h('div', { class: 'toolbar' }, h('div', { class: 'row' }, bar('sk-chip'), bar('sk-chip'), bar('sk-chip')), bar('sk-search')),
            h('section', { class: 'skel-stack' }, bar('sk-title w-20'), tableRows(5, 5)))),

    trips: () => wrap('view trips',
        h('div', { class: 'page-header' }, h('div', { class: 'page-header-main lede' }, bar('sk-line w-90'), bar('sk-line w-60')), bar('sk-button')),
        h('div', { class: 'vtabs' }, bar('sk-tab'), bar('sk-tab'), bar('sk-tab')),
        h('div', { class: 'tab-panel skel-stack' }, bar('sk-title w-20'), rows(3, () => bar('sk-block')))),

    lifelog: () => wrap('view lifelog',
        h('div', { class: 'page-header' }, h('div', { class: 'page-header-main lede' }, bar('sk-line w-90'), bar('sk-line w-60')), bar('sk-button')),
        h('div', { class: 'toolbar' }, h('div', { class: 'row' }, bar('sk-chip'), bar('sk-chip'), bar('sk-chip')), bar('sk-search')),
        h('section', { class: 'skel-stack' }, bar('sk-title w-30'), bar('sk-block'), rows(3, () => bar('sk-line w-80')))),

    preferences: () => wrap('view preferences',
        h('div', { class: 'page-header' }, h('div', { class: 'page-header-main lede' }, bar('sk-line w-90'), bar('sk-line w-60')), bar('sk-button')),
        h('div', { class: 'toolbar' }, h('div', { class: 'row' }, bar('sk-chip'), bar('sk-chip')), bar('sk-search')),
        h('section', { class: 'skel-stack' }, bar('sk-title w-20'), tableRows(3, 3), bar('sk-title w-20'), tableRows(2, 3))),

    keys: () => wrap('view keys',
        h('div', { class: 'page-header' }, h('div', { class: 'page-header-main lede' }, bar('sk-line w-90'), bar('sk-line w-80 sk-narrow'), bar('sk-line w-60')), bar('sk-button')),
        h('section', {}, bar('sk-title w-20'), tableRows(3)),
        bar('sk-line w-20')),

    agents: () => wrap('view agents', lede(),
        h('section', {}, bar('sk-title w-30'), tableRows(3, 5, 'tall')),
        h('section', {}, bar('sk-title w-20'), tableRows(5))),

    backups: () => wrap('view backups',
        h('div', { class: 'page-header' }, h('div', { class: 'page-header-main lede' }, bar('sk-line w-90'), bar('sk-line w-80 sk-narrow'), bar('sk-line w-60')), bar('sk-button')),
        h('section', { class: 'panel skel-status' }, bar('sk-icon'), bar('sk-read w-80')),
        h('section', {}, bar('sk-title w-20'), tableRows(1)),
        h('section', { class: 'skel-stack' }, bar('sk-title w-30'), bar('sk-line w-70'), bar('sk-block'))),

    portfolio: () => wrap('view portfolio', lede(),
        h('div', { class: 'counts' }, rows(5, () => h('div', { class: 'count' }, bar('sk-display w-40'), bar('sk-line w-60'), bar('sk-xs w-70')))),
        h('section', { class: 'skel-stack' }, bar('sk-title w-20'), h('div', { class: 'panel skel-stack' }, bar('sk-line w-60'), bar('sk-line w-50'), bar('sk-line w-70'), bar('sk-line w-40'), bar('sk-line w-50'))),
        h('section', {}, bar('sk-title w-20'), tableRows(5, 5))),

    activity: () => wrap('view activity', lede(),
        h('div', { class: 'row' }, rows(6, () => bar('sk-chip'))),
        h('div', { class: 'days' }, h('div', { class: 'day' }, bar('sk-line w-20'),
            h('div', { class: 'events' }, rows(8, () => h('div', { class: 'event' }, bar('sk-xs'), bar('sk-icon'), bar('sk-line w-70'))))))),

    settings: () => wrap('view settings',
        h('section', { class: 'panel setting' }, h('div', { class: 'skel-stack sk-grow' }, bar('sk-title w-20'), bar('sk-line w-80')), bar('sk-seg')),
        h('section', { class: 'panel setting' }, h('div', { class: 'skel-stack sk-grow' }, bar('sk-title w-20'), bar('sk-line w-90'), bar('sk-line w-50')), bar('sk-button')),
        h('section', { class: 'panel skel-stack' }, bar('sk-title w-20'), rows(6, () => bar('sk-line w-60'))),
        h('section', { class: 'panel skel-stack' }, bar('sk-title w-30'), bar('sk-line w-80'), bar('sk-block sk-tall'))),
};

export function pageSkeleton(route) {
    const make = SHAPES[route.name];
    return make ? make(route) : wrap('view', lede(), bar('sk-block'));
}
