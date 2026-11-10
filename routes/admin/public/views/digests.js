// Digests.
//   #/digests?month=2026-11      coverage calendar for the month plus that month's digests
//   #/digests?kind=weekly        the weekly reviews
//   #/digests?q=words            full-text search (keeps ?kind)
//   #/digests/daily/2026-11-08   reader (serif), previous/next day, edit mode, history drawer
//   #/digests/weekly/2026-W45    the same for a week
// History, compare and restore live in a right-hand drawer so the text keeps its place.
import {
    h, icon, button, when, ago, plural, dot, emptyState, toast, confirmDialog, openDrawer, chipNav, dayLabel, hidden, actorName,
} from '../ui.js';
import { monthCalendar, isoDay, parseDay, addDays, addMonths, monthLabel } from '../charts.js';
import { href, navigate } from '../router.js';

const SOURCE_LABEL = { generated: 'Generated', import: 'Imported', edit: 'Edited', restore: 'Restored' };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_RE = /^\d{4}-W\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');

/* ---------- periods ---------- */

// 2026-11-08 -> 2026-W45 (ISO week: Monday start, week 1 holds the first Thursday).
export function isoWeek(day) {
    const d = parseDay(day);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 3);
    const year = d.getFullYear();
    const firstThu = new Date(year, 0, 4, 12);
    firstThu.setDate(firstThu.getDate() - ((firstThu.getDay() + 6) % 7) + 3);
    return `${year}-W${pad(1 + Math.round((d - firstThu) / (7 * 86400000)))}`;
}

// 2026-W45 -> the Monday, 2026-11-02
export function weekStart(period) {
    const [y, w] = period.split('-W').map(Number);
    const jan4 = new Date(y, 0, 4, 12);
    jan4.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (w - 1) * 7);
    return isoDay(jan4);
}

const addWeeks = (period, n) => isoWeek(addDays(weekStart(period), 7 * n));
const today = () => isoDay(new Date());

function periodTitle(kind, period) {
    if (kind === 'daily') return dayLabel(period, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const [y, w] = period.split('-W');
    return `Week ${Number(w)}, ${y}`;
}

function periodShort(kind, period) {
    if (kind === 'daily') return dayLabel(period, { weekday: 'short', month: 'short', day: 'numeric' });
    return `Week ${Number(period.split('-W')[1])}`;
}

function weekRange(period) {
    const start = weekStart(period);
    const end = addDays(start, 6);
    const opts = { month: 'long', day: 'numeric' };
    return `${dayLabel(start, opts)} to ${dayLabel(end, start.slice(5, 7) === end.slice(5, 7) ? { day: 'numeric' } : opts)}`;
}

const listHref = (kind, period) => (kind === 'daily'
    ? href('digests', [], { month: period ? period.slice(0, 7) : null })
    : href('digests', [], { kind: 'weekly' }));

/* ---------- small pieces ---------- */

// Turns [matched] words of a search snippet into <mark>, without innerHTML.
function highlight(snippet) {
    return snippet.split(/(\[[^\]]*\])/).filter(Boolean).map((part) => (/^\[.*\]$/.test(part) ? h('mark', { text: part.slice(1, -1) }) : part));
}

// Paragraph-level comparison of an older and a newer text.
function diffParagraphs(older, newer) {
    const A = older.split(/\n{2,}/).map((t) => t.trim()).filter(Boolean);
    const B = newer.split(/\n{2,}/).map((t) => t.trim()).filter(Boolean);
    const n = A.length;
    const m = B.length;
    const L = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (A[i] === B[j]) { out.push(['same', A[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(['del', A[i++]]);
        else out.push(['add', B[j++]]);
    }
    while (i < n) out.push(['del', A[i++]]);
    while (j < m) out.push(['add', B[j++]]);
    return out;
}

function sourceSummary(meta) {
    const src = meta && meta.sources;
    if (!src || typeof src !== 'object') return null;
    const names = Object.keys(src);
    const bad = names.filter((k) => src[k] !== 'ok').length;
    return { text: `${names.length - bad} of ${plural(names.length, 'source')}${bad ? `, ${bad} failed` : ''}`, bad };
}

function versionText(d) {
    const what = SOURCE_LABEL[d.source] || d.source;
    return d.rev > 1 ? `${what}, revision ${d.rev}` : what;
}

function digestItem(d) {
    const src = sourceSummary(d.meta);
    return h('li', {}, h('a', { class: 'dl-item', href: href('digests', [d.kind, d.period]), 'data-key': `d:${d.kind}:${d.period}` },
        h('span', { class: 'dl-title', text: d.kind === 'daily' ? dayLabel(d.period, { weekday: 'long', month: 'long', day: 'numeric' }) : `${periodTitle(d.kind, d.period)}, ${weekRange(d.period)}` }),
        h('span', { class: 'dl-meta' },
            h('span', { text: versionText(d) }),
            src ? h('span', {}, dot(src.bad ? 'warn' : 'good'), src.text) : null,
            h('span', { text: `${Math.max(1, Math.round(d.chars / 6)).toLocaleString()} words` }))));
}

function kindNav(kind, q) {
    return chipNav({
        label: 'Kind of digest',
        current: kind,
        items: [
            { id: 'daily', label: 'Daily', href: href('digests', [], { q: q || null }) },
            { id: 'weekly', label: 'Weekly', href: href('digests', [], { kind: 'weekly', q: q || null }) },
        ],
    });
}

function searchForm(kind, q) {
    const input = h('input', { type: 'search', id: 'd-search', name: 'q', value: q, placeholder: `Search ${kind} digests`, 'aria-label': `Search the text of ${kind} digests`, 'data-key': 'd-search', enterkeyhint: 'search' });
    return h('form', {
        class: 'search-form',
        role: 'search',
        onsubmit: (event) => {
            event.preventDefault();
            navigate(href('digests', [], { kind: kind === 'weekly' ? 'weekly' : null, q: input.value.trim() }));
        },
    }, icon('search', 'search-icon'), input,
    q ? h('a', { class: 'btn ghost small', href: href('digests', [], { kind: kind === 'weekly' ? 'weekly' : null }), text: 'Clear' }) : null);
}

/* ---------- list, calendar, search ---------- */

let pendingFocus = null; // a day to focus once the calendar for its month is on screen

async function results(ctx, kind, q) {
    const data = await ctx.api(`/digests?q=${encodeURIComponent(q)}&kind=${kind}&limit=50`);
    return h('section', { class: 'panel', 'aria-labelledby': 'res-title' },
        h('h2', { id: 'res-title', text: data.results.length ? `${plural(data.results.length, 'match', 'matches')} for "${q}"` : `Nothing matches "${q}"` }),
        data.results.length
            ? h('ol', { class: 'results' }, data.results.map((r) => h('li', {},
                h('a', { class: 'link res-title', href: href('digests', [r.kind, r.period]), text: r.kind === 'daily' ? periodTitle(r.kind, r.period) : `${periodTitle(r.kind, r.period)}, ${weekRange(r.period)}` }),
                h('p', { class: 'res-snippet' }, highlight(r.snippet)))))
            : emptyState({
                title: 'No digest has those words.',
                text: `Try fewer or different words, or search the ${kind === 'daily' ? 'weekly' : 'daily'} digests. Search looks at every revision.`,
                action: h('a', { class: 'btn quiet small', href: href('digests', [], { kind: kind === 'daily' ? 'weekly' : null, q }), text: `Search the ${kind === 'daily' ? 'weekly' : 'daily'} digests` }),
            }));
}

// The month calendar (one tab stop, arrows move by day, Page Up/Down by month). Used beside the list on
// #/digests and beside the reader on a digest's page. `go(month)` shows another month; `home` is the month
// the "back" link returns to.
async function calendarPanel(ctx, { month, selected = [], go, home, homeHref, homeText }) {
    const now = today();
    const data = await ctx.api(`/digests?kind=daily&from=${month}-01&to=${month}-31&limit=62`);
    const have = new Map(data.digests.map((d) => [d.period, d]));
    const first = data.bounds.first;

    const status = (day) => {
        if (have.has(day)) return 'have';
        if (day > now) return 'future';
        if (day === now) return 'today';
        if (!first || day < first) return 'before';
        return 'gap';
    };
    const minMonth = first ? first.slice(0, 7) : now.slice(0, 7);

    const cal = monthCalendar({
        month,
        status,
        selected,
        href: (day) => href('digests', ['daily', day]),
        focusDay: pendingFocus,
        onLeave: (day) => {
            const m = day.slice(0, 7);
            if (m < minMonth || m > now.slice(0, 7)) return;
            pendingFocus = day;
            go(m);
        },
    });
    if (pendingFocus && pendingFocus.startsWith(month)) {
        const day = pendingFocus;
        setTimeout(() => cal.focus(day), 0);
    }
    pendingFocus = null;

    const days = Array.from({ length: new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate() }, (_, i) => `${month}-${pad(i + 1)}`);
    const counted = days.filter((d) => ['have', 'gap'].includes(status(d)));
    const gaps = counted.filter((d) => status(d) === 'gap');
    const summary = !counted.length
        ? (first ? 'No days to count in this month yet.' : 'No daily digest has arrived yet. The nightly job publishes one each day at 11 PM.')
        : `${counted.length - gaps.length} of ${plural(counted.length, 'day')} have a digest.`;

    const prev = button({ variant: 'ghost', size: 'small', iconName: 'prev', label: `Previous month, ${monthLabel(addMonths(month, -1))}`, onClick: () => go(addMonths(month, -1)), disabled: month <= minMonth, 'data-key': 'cal-prev' });
    const next = button({ variant: 'ghost', size: 'small', iconName: 'next', label: `Next month, ${monthLabel(addMonths(month, 1))}`, onClick: () => go(addMonths(month, 1)), disabled: month >= now.slice(0, 7), 'data-key': 'cal-next' });

    const panel = h('section', { class: 'panel cal-panel', 'aria-labelledby': 'cal-title' },
        h('div', { class: 'cal-top' },
            h('h2', { id: 'cal-title', text: monthLabel(month) }),
            h('div', { class: 'cal-nav' }, prev,
                month !== home ? h('a', { class: 'btn ghost small', href: homeHref, text: homeText }) : null,
                next)),
        cal.el,
        h('ul', { class: 'cal-legend', 'aria-label': 'Key' },
            h('li', {}, h('span', { class: 'cal-key have', 'aria-hidden': 'true' }), 'Digest'),
            h('li', {}, h('span', { class: 'cal-key gap', 'aria-hidden': 'true' }), 'Missing'),
            h('li', {}, h('span', { class: 'cal-key none', 'aria-hidden': 'true' }), 'Nothing expected')),
        h('p', { class: 'cal-summary' }, summary,
            gaps.length ? h('span', { class: 'cal-gaps' }, ` Missing: ${gaps.map((d) => dayLabel(d, { month: 'short', day: 'numeric' })).join(', ')}.`) : null));
    return { panel, data, first };
}

async function daily(ctx) {
    const now = today();
    const asked = ctx.route.query.get('month');
    const month = asked && MONTH_RE.test(asked) && asked <= now.slice(0, 7) ? asked : now.slice(0, 7);
    const { panel, data, first } = await calendarPanel(ctx, {
        month,
        go: (m) => navigate(href('digests', [], { month: m === now.slice(0, 7) ? null : m })),
        home: now.slice(0, 7),
        homeHref: href('digests'),
        homeText: 'This month',
    });

    const list = data.digests.length
        ? h('ul', { class: 'digest-list' }, data.digests.map(digestItem))
        : emptyState({
            title: `No daily digests in ${monthLabel(month)}.`,
            text: first ? 'Pick another month, or search all of them.' : 'The nightly job publishes one each day at 11 PM. Until then, the weekly reviews may have something.',
            iconName: 'calendar',
            action: first && data.bounds.last
                ? h('a', { class: 'btn quiet small', href: href('digests', [], { month: data.bounds.last.slice(0, 7) === now.slice(0, 7) ? null : data.bounds.last.slice(0, 7) }), text: `Open ${monthLabel(data.bounds.last.slice(0, 7))}, the newest` })
                : h('a', { class: 'btn quiet small', href: href('digests', [], { kind: 'weekly' }), text: 'Open weekly reviews' }),
        });

    return h('div', { class: 'digests-browse' },
        panel,
        h('section', { class: 'panel dl-panel', 'aria-labelledby': 'dl-title' },
            h('div', { class: 'panel-head' },
                h('h2', { id: 'dl-title', text: `${monthLabel(month)}` }),
                h('span', { class: 'muted', text: plural(data.digests.length, 'digest') })),
            list));
}

async function weekly(ctx) {
    const data = await ctx.api('/digests?kind=weekly&limit=104');
    return h('section', { class: 'panel dl-panel', 'aria-labelledby': 'dl-title' },
        h('div', { class: 'panel-head' },
            h('h2', { id: 'dl-title', text: 'Weekly reviews' }),
            h('span', { class: 'muted', text: plural(data.bounds.count, 'week') })),
        data.digests.length
            ? h('ul', { class: 'digest-list' }, data.digests.map(digestItem))
            : emptyState({
                title: 'No weekly reviews yet.',
                text: 'The weekly review is published each Sunday from that week\'s daily digests.',
                iconName: 'calendar',
                action: h('a', { class: 'btn quiet small', href: href('digests'), text: 'Open daily digests' }),
            }));
}

async function browse(ctx) {
    const kind = ctx.route.query.get('kind') === 'weekly' ? 'weekly' : 'daily';
    const q = (ctx.route.query.get('q') || '').trim();
    const body = q ? await results(ctx, kind, q) : kind === 'daily' ? await daily(ctx) : await weekly(ctx);
    return h('div', { class: 'view digests' },
        h('div', { class: 'view-intro' },
            h('p', { class: 'lede', text: 'Written each night from your day, and each Sunday from the week. Read them, correct them, search them.' })),
        h('div', { class: 'toolbar' }, kindNav(kind, q), searchForm(kind, q)),
        body);
}

/* ---------- reader ---------- */

// Reader state for the open digest; reset when another one opens.
let st = { id: null, viewRev: null, editing: false };
let historyDrawer = null;

function pager(kind, period) {
    const isDaily = kind === 'daily';
    const prevP = isDaily ? addDays(period, -1) : addWeeks(period, -1);
    const nextP = isDaily ? addDays(period, 1) : addWeeks(period, 1);
    const nextAllowed = isDaily ? nextP <= today() : weekStart(nextP) <= today();
    const unit = isDaily ? 'day' : 'week';
    const link = (p, which, iconName, allowed) => (allowed
        ? h('a', { class: `btn quiet small pager-${which}`, href: href('digests', [kind, p]), 'data-key': `pager-${which}`, rel: which === 'prev' ? 'prev' : 'next' },
            which === 'prev' ? icon(iconName) : null,
            h('span', {}, h('span', { class: 'pager-word', text: which === 'prev' ? `Previous ${unit}` : `Next ${unit}` }), hidden(', '), h('span', { class: 'pager-date', text: periodShort(kind, p) })),
            which === 'next' ? icon(iconName) : null)
        : h('span', { class: `btn quiet small pager-${which}`, 'aria-disabled': 'true' }, h('span', { class: 'pager-word', text: `No next ${unit} yet` })));
    return h('nav', { class: 'pager', 'aria-label': `Other ${unit}s` },
        link(prevP, 'prev', 'prev', true), link(nextP, 'next', 'next', nextAllowed));
}

function readerHead(kind, period, byline) {
    return h('header', { class: 'reader-head' },
        h('p', { class: 'crumb' }, h('a', { class: 'link', href: listHref(kind, period), text: kind === 'daily' ? `Digests, ${monthLabel(period.slice(0, 7))}` : 'Weekly reviews' })),
        h('h2', { class: 'reader-title', text: periodTitle(kind, period) }),
        kind === 'weekly' ? h('p', { class: 'reader-range', text: weekRange(period) }) : null,
        byline ? h('p', { class: 'reader-byline', text: byline }) : null);
}

function openHistory(ctx, kind, period, d, base) {
    const reload = () => ctx.rerender();
    const listView = () => [
        h('p', { class: 'note', text: 'Revision 1 is what first arrived and is never changed. Restoring adds a new revision with the older text, so nothing is lost.' }),
        h('ol', { class: 'rev-list', reversed: true }, d.history.map((r) => h('li', { class: `rev${r.current ? ' current' : ''}` },
            h('div', { class: 'rev-main' },
                h('p', { class: 'rev-title' }, `Revision ${r.rev}`, r.current ? h('span', { class: 'chip', text: 'Current' }) : null),
                h('p', { class: 'rev-what', text: r.source === 'restore' && r.note ? r.note : `${SOURCE_LABEL[r.source] || r.source} by ${r.model || actorName(r.actor)}${r.note ? `: ${r.note}` : ''}` }),
                h('p', { class: 'rev-when' }, h('time', { datetime: r.at, text: when(r.at) }), ` (${ago(r.at)})`)),
            r.current ? null : h('div', { class: 'rev-actions' },
                button({ text: 'View', variant: 'quiet', size: 'small', label: `View revision ${r.rev}`, onClick: () => { st.viewRev = r.rev; st.editing = false; historyDrawer.close(true); reload(); } }),
                button({ text: 'Compare', variant: 'quiet', size: 'small', label: `Compare revision ${r.rev} with the current text`, onClick: () => compare(r.rev) }),
                button({ text: 'Restore', variant: 'quiet', size: 'small', label: `Restore revision ${r.rev}`, onClick: () => restore(r.rev) })))))];

    async function restore(rev) {
        const ok = await confirmDialog({
            title: `Restore revision ${rev}?`,
            body: `The text of revision ${rev} becomes the current text, as a new revision. The text you see now stays in the history.`,
            confirm: 'Restore',
        });
        if (!ok) return;
        try {
            await ctx.api(`${base}/restore`, { method: 'POST', body: { rev } });
            toast(`Revision ${rev} restored`);
            st.viewRev = null;
            historyDrawer.close(true);
            reload();
        } catch (err) {
            toast(`Could not restore. ${err.message}`, { kind: 'bad' });
        }
    }

    async function compare(rev) {
        historyDrawer.setTitle('Compare', `Revision ${rev} and the current text`);
        historyDrawer.setContent(h('p', { class: 'muted', text: 'Loading…' }));
        try {
            const [older, current] = await Promise.all([ctx.api(`${base}?rev=${rev}`), ctx.api(base)]);
            const parts = diffParagraphs(older.body, current.body);
            const changed = parts.filter(([k]) => k !== 'same').length;
            const back = button({ text: 'All revisions', variant: 'ghost', size: 'small', iconName: 'prev', onClick: () => { historyDrawer.setTitle('History', plural(d.history.length, 'revision')); historyDrawer.setContent(listView()); } });
            historyDrawer.setContent(
                h('div', { class: 'compare-top' }, back,
                    button({ text: `Restore revision ${rev}`, variant: 'quiet', size: 'small', onClick: () => restore(rev) })),
                h('p', { class: 'note', text: changed ? `${plural(changed, 'paragraph')} differ. Removed text is struck through, added text is marked with a plus.` : 'The two texts are the same.' }),
                h('div', { class: 'diff' }, parts.map(([k, text]) => h('p', { class: k },
                    k === 'add' ? hidden('Added: ') : k === 'del' ? hidden('Removed: ') : null, text))));
            back.focus();
        } catch (err) {
            historyDrawer.setContent(emptyState({ title: 'That did not load.', text: err.message, iconName: 'bad' }));
        }
    }

    historyDrawer = openDrawer({
        title: 'History',
        subtitle: plural(d.history.length, 'revision'),
        content: listView(),
        wide: true,
        onClose: () => { historyDrawer = null; },
        returnFocus: () => document.querySelector('[data-key="history"]'),
    });
}

async function reader(ctx, kind, period) {
    const valid = (kind === 'daily' && DAY_RE.test(period)) || (kind === 'weekly' && WEEK_RE.test(period));
    if (!valid) {
        return emptyState({ title: 'That is not a digest address.', text: 'Daily digests look like #/digests/daily/2026-11-08, weekly ones like #/digests/weekly/2026-W45.', iconName: 'warn', action: h('a', { class: 'btn', href: href('digests'), text: 'Open digests' }) });
    }
    const id = `${kind}/${period}`;
    if (st.id !== id) st = { id, viewRev: null, editing: false };
    ctx.onCleanup(() => { if (historyDrawer && !location.hash.startsWith(`#/digests/${kind}/${period}`)) historyDrawer.close(true); });

    // The month calendar sits beside the text on wide screens (below it on narrow ones). It is extra:
    // if it fails to load, the reader still shows.
    const firstDay = kind === 'daily' ? period : weekStart(period);
    const home = firstDay.slice(0, 7);
    const asked = ctx.route.query.get('month');
    const month = asked && MONTH_RE.test(asked) && asked <= today().slice(0, 7) ? asked : home;
    const sideP = calendarPanel(ctx, {
        month,
        selected: kind === 'daily' ? [period] : Array.from({ length: 7 }, (_, i) => addDays(firstDay, i)),
        go: (m) => navigate(href('digests', [kind, period], { month: m === home ? null : m })),
        home,
        homeHref: href('digests', [kind, period]),
        homeText: kind === 'daily' ? 'Back to this day' : 'Back to this week',
    }).catch(() => null);
    const layout = async (main) => {
        const side = await sideP;
        return h('div', { class: 'reader-layout' }, main,
            side ? h('aside', { class: 'reader-side', 'aria-label': 'Calendar' }, side.panel) : null);
    };

    const base = `/digests/${kind}/${encodeURIComponent(period)}`;
    let d;
    try {
        d = await ctx.api(`${base}${st.viewRev ? `?rev=${st.viewRev}` : ''}`);
    } catch (err) {
        if (err.status !== 404) throw err;
        const future = kind === 'daily' ? period >= today() : weekStart(period) > today();
        return layout(h('div', { class: 'view reader' },
            readerHead(kind, period),
            emptyState({
                title: future ? 'Not written yet.' : `No ${kind} digest for this ${kind === 'daily' ? 'day' : 'week'}.`,
                text: future ? 'The nightly job writes the daily digest at 11 PM.' : 'The job did not deliver one. It shows as missing on the calendar.',
                iconName: future ? 'calendar' : 'warn',
                action: h('a', { class: 'btn quiet small', href: listHref(kind, period), text: kind === 'daily' ? 'Open the month' : 'Open weekly reviews' }),
            }),
            pager(kind, period)));
    }
    const viewingOld = Boolean(st.viewRev && d.rev !== d.revisions);
    const who = d.model || actorName(d.actor);
    const byline = `${SOURCE_LABEL[d.source] || d.source}${who ? ` by ${who}` : ''}, ${when(d.revisedAt)}${d.revisions > 1 ? `. Revision ${d.rev} of ${d.revisions}` : ''}${d.note && d.source !== 'restore' ? `. Note: ${d.note}` : ''}.`;

    let main;
    if (st.editing) {
        const area = h('textarea', { id: 'd-body', rows: '18', 'aria-label': 'Digest text', class: 'reader-edit', spellcheck: 'true' });
        area.value = d.body;
        const note = h('input', { type: 'text', id: 'd-note', placeholder: 'What did you change? (optional)', maxlength: '200' });
        const error = h('p', { class: 'error', role: 'alert' });
        const save = button({ text: 'Save changes', type: 'submit' });
        const dirty = () => area.value !== d.body || note.value.trim() !== '';
        const cancel = async () => {
            if (dirty() && !(await confirmDialog({ title: 'Discard your changes?', body: 'The digest keeps its current text.', confirm: 'Discard', danger: true }))) return;
            st.editing = false;
            ctx.rerender();
        };
        main = h('form', {
            class: 'edit',
            onsubmit: async (event) => {
                event.preventDefault();
                error.textContent = '';
                if (area.value === d.body) { error.textContent = 'Nothing changed yet.'; return; }
                save.disabled = true;
                try {
                    await ctx.api(base, { method: 'PATCH', body: { body: area.value, note: note.value } });
                    st.editing = false;
                    toast('Digest saved');
                    ctx.rerender();
                } catch (err) {
                    error.textContent = err.message;
                    save.disabled = false;
                }
            },
            onkeydown: (event) => {
                if (event.key === 'Escape') { event.preventDefault(); cancel(); }
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save.click(); }
            },
        },
        h('p', { class: 'note', text: 'Saving adds a new revision; the current text stays in the history. Ctrl Enter saves, Esc cancels.' }),
        h('label', { for: 'd-body', class: 'visually-hidden', text: 'Digest text' }), area,
        h('label', { for: 'd-note' }, 'Note', note),
        error,
        h('div', { class: 'row' }, save, button({ text: 'Cancel', variant: 'quiet', onClick: cancel })));
        setTimeout(() => area.focus(), 0);
    } else {
        main = h('article', { class: 'reading', 'aria-label': periodTitle(kind, period) },
            d.body.split(/\n{2,}/).map((para) => para.trim()).filter(Boolean).map((para) => h('p', { text: para })));
    }

    const tools = !st.editing && h('div', { class: 'reader-tools' },
        viewingOld ? null : button({ text: 'Edit', variant: 'quiet', size: 'small', iconName: 'edit', 'data-key': 'edit', onClick: () => { st.editing = true; ctx.rerender(); } }),
        button({ text: d.revisions > 1 ? `History, ${plural(d.revisions, 'revision')}` : 'History', variant: 'quiet', size: 'small', iconName: 'history', 'data-key': 'history', 'aria-haspopup': 'dialog', onClick: async () => {
            const full = viewingOld ? await ctx.api(base) : d;
            openHistory(ctx, kind, period, full, base);
        } }));

    const src = d.meta && d.meta.sources && typeof d.meta.sources === 'object' ? Object.entries(d.meta.sources) : [];
    const sources = !st.editing && src.length ? h('section', { class: 'reader-sources', 'aria-labelledby': 'src-title' },
        h('h3', { id: 'src-title', text: 'Sources used' }),
        h('ul', {}, src.map(([name, status]) => h('li', {}, dot(status === 'ok' ? 'good' : 'warn'), h('span', { text: `${name}: ${status === 'ok' ? 'read' : status}` }))))) : null;

    return layout(h('div', { class: 'view reader' },
        readerHead(kind, period, byline),
        tools,
        viewingOld ? h('div', { class: 'banner', role: 'status' },
            h('span', { text: `You are reading revision ${d.rev}, not the current text.` }),
            button({ text: 'Back to the current text', variant: 'quiet', size: 'small', onClick: () => { st.viewRev = null; ctx.rerender(); } })) : null,
        main,
        sources,
        st.editing ? null : pager(kind, period)));
}

export function render(ctx) {
    const [kind, period] = ctx.route.parts;
    if (kind && period) return reader(ctx, kind, period);
    if (kind) return reader(ctx, kind, '');
    st.id = null;
    return browse(ctx);
}

// Exported for the palette and tests of week maths in the browser.
export { periodTitle, listHref, addWeeks };
