// Backups: the daily copies and a Back up now button. Ported from the old app; stage 2 redoes it.
import { h, when, ago, bytes, emptyState, toast } from '../ui.js';

export async function render(ctx) {
    const { backups: list } = await ctx.api('/backups');
    const run = h('button', {
        class: 'btn',
        type: 'button',
        text: 'Back up now',
        onclick: async () => {
            run.disabled = true;
            run.textContent = 'Backing up…';
            try {
                await ctx.api('/backups', { method: 'POST' });
                toast('Backup finished');
            } catch (err) {
                toast(`The backup failed. ${err.message}`, { kind: 'bad' });
            }
            ctx.rerender();
        },
    });
    return h('div', { class: 'legacy' },
        h('p', { class: 'lede', text: 'The database is copied once a day, from inside the service. The newest seven copies are kept next to the database file.' }),
        h('p', { class: 'row' }, run),
        h('section', {},
            list.length
                ? h('div', { class: 'table-wrap' }, h('table', {},
                    h('thead', {}, h('tr', {}, h('th', { text: 'Copy' }), h('th', { text: 'Saved' }), h('th', { class: 'num', text: 'Size' }))),
                    h('tbody', {}, list.map((b) => h('tr', {},
                        h('td', {}, h('code', { text: b.name })),
                        h('td', { text: `${when(b.modifiedAt)} (${ago(b.modifiedAt)})` }),
                        h('td', { class: 'num', text: bytes(b.bytes) }))))))
                : emptyState({ title: 'No copies yet.', text: 'The first one is made shortly after the service starts, or use Back up now.' })));
}
