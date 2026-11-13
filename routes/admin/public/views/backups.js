// Backups: where the copies go and how often, the copies with size and age, Back up now, Verify newest, and how to
// restore one by hand (the dashboard deliberately has no restore button: replacing the live database belongs on the
// server, with the hub stopped). The folder and the schedule are edited in Settings.
import { h, icon, button, when, ago, bytes, plural, emptyState, toast, copyButton, fact, dot, pageHeader } from '../ui.js';
import { everyWords } from './settingsForms.js';

const KIND = { scheduled: 'Scheduled', 'pre-delete': 'Before a delete', 'pre-migration': 'Before a migration' };

function step(n, text, command) {
    const field = command ? h('input', { type: 'text', class: 'secret', readonly: true, value: command, 'aria-label': `Command for step ${n}`, onfocus: (e) => e.target.select() }) : null;
    return h('li', {},
        h('p', { text }),
        command ? h('div', { class: 'copy-row' }, field, copyButton({ value: command, field, text: 'Copy', size: 'small', label: `Copy the command for step ${n}` })) : null);
}

export async function render(ctx) {
    const { backups: list, status } = await ctx.api('/backups');
    const newest = status.newest;
    const total = list.reduce((n, b) => n + b.bytes, 0);
    const staleMs = Math.max(36, status.everyHours * 1.5) * 3600 * 1000;
    const stale = status.enabled && (!newest || Date.now() - Date.parse(newest.modifiedAt) > staleMs);
    const failing = Boolean(status.lastError);

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
                toast(`${err.message} Check the container logs.`, { kind: 'bad' });
            }
            ctx.rerender();
        },
    });

    const report = h('div', { class: 'verify-report', 'aria-live': 'polite' });
    const verify = button({
        text: 'Verify newest',
        variant: 'quiet',
        iconName: 'good',
        'data-key': 'verify-backup',
        onClick: async () => {
            verify.disabled = true;
            report.replaceChildren(h('p', { class: 'note', text: 'Checking a temporary copy of the newest backup…' }));
            try {
                const r = await ctx.api('/backups/verify', { method: 'POST' });
                report.replaceChildren(h('div', { class: `panel verify ${r.ok ? 'good' : 'warn'}` },
                    icon(r.ok ? 'good' : 'warn'),
                    h('div', {},
                        h('p', {}, h('strong', { text: r.ok ? `${r.file} is sound.` : `${r.file} has a problem.` }), ` Integrity check: ${r.integrity || 'not run'}.`),
                        r.problems.length ? h('ul', {}, r.problems.map((p) => h('li', { text: p }))) : null,
                        h('p', { class: 'note', text: 'Rows in the backup compared with the live database (a live table can be ahead: it kept changing after the copy).' }),
                        h('ul', { class: 'verify-tables' }, r.tables.map((t) => h('li', { text: `${t.table}: ${t.backup == null ? 'missing' : t.backup} in the backup, ${t.live} live` }))))));
            } catch (err) {
                report.replaceChildren(h('p', { class: 'error', role: 'alert', text: err.message }));
            } finally { verify.disabled = false; }
        },
    });

    const example = newest ? newest.name : 'hub-2026-11-08.db';
    const where = status.dirIsDefault ? 'data/backups' : status.dir;
    return h('div', { class: 'view backups' },
        pageHeader({
            lede: ['The hub copies its database by itself, from inside the service. Where the copies go and how often is set in ', h('a', { href: '#/settings/backups', text: 'Settings' }), '.'],
            actions: h('div', { class: 'row' }, verify, run),
        }),
        h('section', { class: `panel backup-status ${failing ? 'warn' : stale ? 'warn' : 'good'}`, 'aria-live': 'polite' },
            icon(failing || stale ? 'warn' : 'good'),
            h('div', {},
                failing ? h('p', { class: 'error', text: `Backups failing: ${status.lastError.message}` }) : null,
                h('p', {},
                    newest ? h('strong', { text: `Newest scheduled copy ${ago(newest.modifiedAt)}.` }) : h('strong', { text: status.enabled ? 'No scheduled copy yet.' : 'Automatic backups are off.' }),
                    ' ',
                    newest ? `${plural(list.length, 'file')}, ${bytes(total)} in total.${stale ? ' That is later than the schedule expects; use Back up now and check the logs.' : ''}` : (status.enabled ? 'The first one is made shortly after the service starts, or use Back up now.' : '')),
            h('dl', { class: 'facts' },
                fact('Folder', h('code', { text: status.dir || 'none (in-memory database)' }), status.dirIsDefault ? ' (the default, next to the database)' : ''),
                fact('Schedule', status.enabled ? `${everyWords(status.everyHours)}, keep the newest ${status.keep}` : 'off', status.enabled && status.verifyAfter ? ', each copy is checked' : ''),
                fact('Free space', status.freeBytes == null ? 'unknown' : bytes(status.freeBytes)),
                fact('Last error', failing ? [dot('bad'), ` ${status.lastError.message} (${when(status.lastError.at)})`] : 'none')),
            report)),
        list.length ? h('section', { 'aria-labelledby': 'b-list' },
            h('h2', { id: 'b-list', class: 'section-title', text: 'Copies' }),
            h('div', { class: 'table-wrap' }, h('table', { class: 'stack' },
                h('thead', {}, h('tr', {},
                    h('th', { scope: 'col', text: 'File' }),
                    h('th', { scope: 'col', text: 'Kind' }),
                    h('th', { scope: 'col', text: 'Saved' }),
                    h('th', { scope: 'col', text: 'Age' }),
                    h('th', { scope: 'col', class: 'num', text: 'Size' }))),
                h('tbody', {}, list.map((b) => h('tr', {},
                    h('td', { class: 'cell-main' }, h('code', { text: b.name }), newest && b.name === newest.name ? h('span', { class: 'chip', text: 'Newest' }) : null),
                    h('td', { 'data-label': 'Kind', text: KIND[b.kind] || b.kind }),
                    h('td', { 'data-label': 'Saved', text: when(b.modifiedAt) }),
                    h('td', { 'data-label': 'Age', text: ago(b.modifiedAt) }),
                    h('td', { class: 'num cell-side', text: bytes(b.bytes) }))))))) : emptyState({ title: 'No copies yet.', text: 'The first copy is made shortly after the service starts. Or make one now.', iconName: 'backups', action: button({ text: 'Back up now', variant: 'quiet', size: 'small', iconName: 'backup', onClick: () => run.click() }) }),
        h('section', { class: 'panel restore-guide', 'aria-labelledby': 'b-restore' },
            h('h2', { id: 'b-restore', text: 'Restoring a copy' }),
            h('p', { class: 'note', text: 'There is no restore button on purpose: the live database must not change under a running hub. On the server, in the personal-apis folder:' }),
            h('ol', { class: 'steps' },
                step(1, 'Stop the hub.', 'docker stop personal-hub'),
                step(2, 'Move the current database aside, with its two journal files, so nothing is lost.', 'mkdir -p data/replaced && mv data/hub.db data/hub.db-wal data/hub.db-shm data/replaced/ 2>/dev/null; ls data/replaced'),
                step(3, 'Copy the backup you want into place.', `cp ${where}/${example} data/hub.db`),
                step(4, 'Start the hub and check this page and the overview.', 'docker start personal-hub')),
            h('p', { class: 'note', text: 'Anything written after the copy was made (digest edits, new keys, the activity log) is not in it. Keys created since then stop working.' })));
}
