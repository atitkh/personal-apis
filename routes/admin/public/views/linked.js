// The "Linked" section of a record's drawer: records in other domains connected to this one, with a picker to add a link
// and a button to take one away. A link never changes either record. Titles are set as text, never as HTML.
import { h, button, chip, toast, formDialog, domainHue, emptyState } from '../ui.js';
import { recordHref } from './recordHref.js';

const DOMAIN_TITLE = { digests: 'Digest', deadlines: 'Deadline', preferences: 'Preference', places: 'Place', flights: 'Flight', trips: 'Trip', lifelog: 'Lifelog', portfolio: 'Portfolio', entities: 'Entity' };

export function linkedSection(ctx, domain, id) {
    const sid = `linked-${domain}-${id}`.replace(/[^a-z0-9-]/gi, '-');
    const list = h('div', { class: 'linked-body', 'aria-live': 'polite' }, h('p', { class: 'note', text: 'Loading…' }));
    const addBtn = button({ text: 'Add link', variant: 'quiet', size: 'small', iconName: 'plus', 'data-key': 'add-link' });

    const load = async () => {
        try {
            const r = await ctx.api(`/links?domain=${encodeURIComponent(domain)}&id=${encodeURIComponent(id)}`);
            if (!r.links.length) {
                list.replaceChildren(h('p', { class: 'note', text: r.hidden ? `Nothing you can see. ${r.hidden} link${r.hidden === 1 ? ' goes' : 's go'} to hidden records.` : 'Not linked to anything yet.' }));
                return;
            }
            list.replaceChildren(h('ul', { class: 'linked-list' }, r.links.map((l) => {
                const o = l.other;
                const un = button({ text: 'Remove link', variant: 'quiet', size: 'small', 'data-key': `unlink-${l.link_id}` });
                un.addEventListener('click', async () => {
                    un.disabled = true;
                    try { await ctx.api(`/links/${l.link_id}`, { method: 'DELETE', body: { confirm: true } }); toast('Link removed'); await load(); } catch (e) { toast(e.message, { kind: 'bad' }); un.disabled = false; }
                });
                return h('li', { class: 'linked-item' },
                    chip(DOMAIN_TITLE[o.domain] || o.domain, { hue: domainHue(o.domain) }),
                    h('a', { class: 'link', href: recordHref(o.domain, o.id, { date: o.date, title: o.title }), text: o.title }),
                    l.rel && l.rel !== 'related' ? h('span', { class: 'note', text: l.rel }) : null,
                    o.date ? h('span', { class: 'note', text: o.date }) : null,
                    l.note ? h('p', { class: 'note linked-note', text: l.note }) : null,
                    un);
            })));
        } catch (e) {
            list.replaceChildren(h('p', { class: 'error', text: e.message }));
        }
    };

    addBtn.addEventListener('click', async () => {
        const q = h('input', { type: 'search', id: `${sid}-q`, name: 'q', placeholder: 'Search for the record to link', autocomplete: 'off', spellcheck: 'false' });
        const rel = h('input', { type: 'text', id: `${sid}-rel`, name: 'rel', placeholder: 'related (or for, about, during …)', autocomplete: 'off', maxlength: '30' });
        const note = h('input', { type: 'text', id: `${sid}-note`, name: 'note', placeholder: 'Optional note', autocomplete: 'off', maxlength: '200' });
        const results = h('div', { class: 'linked-results', role: 'radiogroup', 'aria-label': 'Records found' });
        let timer = null;
        const find = async () => {
            const text = q.value.trim();
            if (text.length < 2) { results.replaceChildren(h('p', { class: 'note', text: 'Type two or more letters.' })); return; }
            try {
                const out = await ctx.api(`/search?q=${encodeURIComponent(text)}&per_domain=5&mode=keyword`);
                const rows = out.groups.flatMap((g) => g.results.map((r) => ({ ...r, domain: g.domain })))
                    .filter((r) => !(r.domain === domain && String(r.id) === String(id)));
                results.replaceChildren(...(rows.length ? rows.map((r, i) => h('label', { class: 'linked-pick' },
                    h('input', { type: 'radio', name: 'target', value: `${r.domain}|${r.id}`, ...(i === 0 ? { checked: 'checked' } : {}) }),
                    h('span', { class: 'chip', text: DOMAIN_TITLE[r.domain] || r.domain }),
                    h('span', { text: ` ${r.title}${r.date ? ` (${r.date})` : ''}` }))) : [h('p', { class: 'note', text: 'Nothing found.' })]));
            } catch (e) { results.replaceChildren(h('p', { class: 'error', text: e.message })); }
        };
        q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(find, 250); });
        find();
        const done = await formDialog({
            title: 'Link to another record',
            intro: 'Pick any record from any domain. The link shows on both records and never changes them.',
            fields: [h('div', { class: 'field' }, h('label', { for: q.id, text: 'Find a record' }), q), results,
                h('div', { class: 'field' }, h('label', { for: rel.id, text: 'Relation' }), rel),
                h('div', { class: 'field' }, h('label', { for: note.id, text: 'Note' }), note)],
            submit: 'Add link',
            onSubmit: (f) => {
                const pick = f.querySelector('input[name="target"]:checked');
                if (!pick) throw new Error('Pick a record first.');
                const [d, ...rest] = pick.value.split('|');
                return ctx.api('/links', { method: 'POST', body: { from: { domain, id: String(id) }, to: { domain: d, id: rest.join('|') }, rel: rel.value.trim() || undefined, note: note.value.trim() || undefined } });
            },
        });
        if (done) { toast(done.status === 'exists' ? 'Already linked' : 'Linked'); load(); }
    });

    load();
    return h('section', { class: 'drawer-section linked-section', 'aria-labelledby': sid },
        h('div', { class: 'section-head' }, h('h3', { id: sid, text: 'Linked' }), addBtn),
        list);
}
