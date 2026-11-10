// Backups: the daily copies with size and age, Back up now, and how to restore one by hand (the dashboard
// deliberately has no restore button: replacing the live database belongs on the server, with the hub stopped).
import { h, icon, button, when, ago, bytes, plural, emptyState, toast, copyButton } from '../ui.js';

const STALE_MS = 36 * 3600 * 1000;

function step(n, text, command) {
    const field = command ? h('input', { type: 'text', class: 'secret', readonly: true, value: command, 'aria-label': `Command for step ${n}`, onfocus: (e) => e.target.select() }) : null;
    return h('li', {},
        h('p', { text }),
        command ? h('div', { class: 'copy-row' }, field, copyButton({ value: command, field, text: 'Copy', size: 'small', label: `Copy the command for step ${n}` })) : null);
}

export async function render(ctx) {
    const { backups: list } = await ctx.api('/backups');
    const newest = list[0];
    const total = list.reduce((n, b) => n + b.bytes, 0);
    const stale = !newest || Date.now() - Date.parse(newest.modifiedAt) > STALE_MS;

    const run = button({
        text: 'Back up now',
        iconName: 'backup',
        'data-key': 'backup-now',
        onClick: async () => {
            run.disabled = true;
            run.querySelector('span').textContent = 'Backing up…';
            try {
                const res = await ctx.api('/backups', { method: 'POST' });
                toast(res.created === false ? 'Backup finished. Today\'s copy was already up to date.' : 'Backup finished');
            } catch (err) {
                toast(`The backup failed. ${err.message} Check the container logs.`, { kind: 'bad' });
            }
            ctx.rerender();
        },
    });

    const example = newest ? newest.name : 'hub-2026-11-08.db';
    return h('div', { class: 'view backups' },
        h('div', { class: 'view-intro row-between' },
            h('p', { class: 'lede', text: 'The hub copies its database once a day, from inside the service. The newest seven copies are kept next to the database file, in data/backups.' }),
            run),
        h('section', { class: `panel backup-status ${stale ? 'warn' : 'good'}`, 'aria-live': 'polite' },
            icon(stale ? 'warn' : 'good'),
            h('p', {},
                newest ? h('strong', { text: `Newest copy ${ago(newest.modifiedAt)}.` }) : h('strong', { text: 'No copy yet.' }),
                ' ',
                newest ? `${plural(list.length, 'copy', 'copies')}, ${bytes(total)} in total.${stale ? ' That is more than a day and a half old; use Back up now and check the logs.' : ''}` : 'The first one is made shortly after the service starts, or use Back up now.')),
        list.length ? h('section', { 'aria-labelledby': 'b-list' },
            h('h2', { id: 'b-list', class: 'section-title', text: 'Copies' }),
            h('div', { class: 'table-wrap' }, h('table', { class: 'stack' },
                h('thead', {}, h('tr', {},
                    h('th', { scope: 'col', text: 'File' }),
                    h('th', { scope: 'col', text: 'Saved' }),
                    h('th', { scope: 'col', text: 'Age' }),
                    h('th', { scope: 'col', class: 'num', text: 'Size' }))),
                h('tbody', {}, list.map((b, i) => h('tr', {},
                    h('td', { class: 'cell-main' }, h('code', { text: b.name }), i === 0 ? h('span', { class: 'chip', text: 'Newest' }) : null),
                    h('td', { 'data-label': 'Saved', text: when(b.modifiedAt) }),
                    h('td', { 'data-label': 'Age', text: ago(b.modifiedAt) }),
                    h('td', { class: 'num cell-side', text: bytes(b.bytes) }))))))) : emptyState({ title: 'No copies yet.', text: 'Use Back up now to make the first one.', iconName: 'backups' }),
        h('section', { class: 'panel restore-guide', 'aria-labelledby': 'b-restore' },
            h('h2', { id: 'b-restore', text: 'Restoring a copy' }),
            h('p', { class: 'note', text: 'There is no restore button on purpose: the live database must not change under a running hub. On the server, in the personal-apis folder:' }),
            h('ol', { class: 'steps' },
                step(1, 'Stop the hub.', 'docker stop nodejs'),
                step(2, 'Move the current database aside, with its two journal files, so nothing is lost.', 'mkdir -p data/replaced && mv data/hub.db data/hub.db-wal data/hub.db-shm data/replaced/ 2>/dev/null; ls data/replaced'),
                step(3, 'Copy the backup you want into place.', `cp data/backups/${example} data/hub.db`),
                step(4, 'Start the hub and check this page and the overview.', 'docker start nodejs')),
            h('p', { class: 'note', text: 'Anything written after the copy was made (digest edits, new keys, the activity log) is not in it. Keys created since then stop working.' })));
}
