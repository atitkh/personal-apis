// Settings > Search: meaning-based search through any OpenAI-compatible embeddings endpoint (Ollama, llama.cpp, vLLM,
// LM Studio, OpenAI ...). Off by default. The key is write-only (never shown again); the address is shown as host and path.
import { h, button, toggleSwitch, toast, ago, hidden } from '../ui.js';

function field(id, label, input, help) {
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), input, help ? h('p', { class: 'note', text: help }) : null);
}

export function searchSection(ctx, data) {
    const s = data.settings;
    const st = data.status;
    const state = { enabled: s.enabled, lifelog: s.include_lifelog };
    const err = h('p', { class: 'error', role: 'alert' });
    const result = h('p', { class: 'note', 'aria-live': 'polite' });
    const url = h('input', { type: 'text', id: 'sem-url', name: 'base_url', value: '', placeholder: s.base_url ? `${s.base_url} (saved; type to replace)` : 'http://172.23.0.1:11434/v1', autocomplete: 'off', spellcheck: 'false' });
    const model = h('input', { type: 'text', id: 'sem-model', name: 'model', value: s.model || '', placeholder: 'mxbai-embed-large', autocomplete: 'off', spellcheck: 'false' });
    const key = h('input', { type: 'password', id: 'sem-key', name: 'api_key', value: '', placeholder: s.has_api_key ? 'Saved. Type to replace it.' : 'Optional', autocomplete: 'off' });
    const enabledText = h('span', { class: 'switch-text', text: s.enabled ? 'On' : 'Off' });
    const lifelogText = h('span', { class: 'switch-text', text: s.include_lifelog ? 'On' : 'Off' });
    const enabled = toggleSwitch({ checked: s.enabled, label: 'Semantic search', key: 'semantic-enabled', onChange: (v) => { state.enabled = v; enabled.setChecked(v); enabledText.textContent = v ? 'On' : 'Off'; } });
    const lifelog = toggleSwitch({ checked: s.include_lifelog, label: 'Include lifelog episodes', key: 'semantic-lifelog', onChange: (v) => { state.lifelog = v; lifelog.setChecked(v); lifelogText.textContent = v ? 'On' : 'Off'; } });
    const save = button({ text: 'Save', iconName: 'good', 'data-key': 'save-search' });
    const test = button({ text: 'Test connection', variant: 'quiet', 'data-key': 'test-search' });
    const reindex = button({ text: 'Rebuild index', variant: 'quiet', 'data-key': 'reindex-search' });

    const body = () => {
        const b = { model: model.value.trim(), enabled: state.enabled, include_lifelog: state.lifelog };
        if (url.value.trim()) b.base_url = url.value.trim();
        if (key.value) b.api_key = key.value;
        return b;
    };
    const run = async (btn, fn, done) => {
        err.textContent = '';
        btn.disabled = true;
        try { await fn(); if (done) toast(done); } catch (e) { err.textContent = e.message; } finally { btn.disabled = false; }
    };
    save.addEventListener('click', () => run(save, async () => { await ctx.api('/search/settings', { method: 'PUT', body: body() }); ctx.rerender(); }, 'Search settings saved'));
    test.addEventListener('click', () => run(test, async () => {
        result.className = 'note';
        result.textContent = 'Testing…';
        const r = await ctx.api('/search/test', { method: 'POST', body: {} });
        result.className = 'note good-text';
        result.textContent = `Works: ${r.dim} numbers per text, ${r.ms} ms. (Tests the saved settings: save first.)`;
    }).catch(() => {}).then(() => { if (err.textContent) { result.className = 'error'; result.textContent = err.textContent; err.textContent = ''; } }));
    reindex.addEventListener('click', () => run(reindex, async () => { await ctx.api('/search/reindex', { method: 'POST', body: {} }); ctx.rerender(); }, 'Rebuilding the index'));

    const rows = st.domains.map((d) => h('li', { class: 'setting-row' }, h('span', { text: d.title }), h('span', { class: 'note', text: `${d.indexed} of ${d.total} indexed` })));
    return h('section', { class: 'panel settings-form', 'aria-labelledby': 's-search' },
        h('h2', { id: 's-search', text: 'Search' }),
        h('p', { class: 'note', text: 'Keyword search always works. Turn this on to also find records by meaning ("airline seat" finds "aisle"). The hub sends each record\'s title and notes (never references, amounts, addresses or raw lifelog lines) to the address below, so use a local model server for private data.' }),
        h('div', { class: 'setting-row' }, h('span', { class: 'field-label', text: 'Semantic search' }), h('span', { class: 'switch-wrap' }, enabled, enabledText)),
        field('sem-url', 'Embeddings address', url, 'An OpenAI-compatible base URL (it gets /embeddings added), for example Ollama at http://172.23.0.1:11434/v1. Private network addresses are fine.'),
        field('sem-model', 'Model', model, 'The embedding model name on that server, for example mxbai-embed-large. Changing it rebuilds the index.'),
        field('sem-key', 'Key', key, 'Only if the server needs one. It is stored and never shown again.'),
        h('div', { class: 'setting-row' }, h('span', { class: 'field-label', text: 'Include lifelog episodes' }), h('span', { class: 'switch-wrap' }, lifelog, lifelogText)),
        h('p', { class: 'note', text: 'Off by default: lifelog is the most sensitive domain. Raw lifelog lines are never embedded.' }),
        err, result,
        h('div', { class: 'form-actions' }, save, test, reindex),
        h('h3', { text: 'Index' }),
        h('p', { class: 'note', text: st.enabled ? `${st.indexed} of ${st.total} records${st.last_run ? `, last run ${ago(st.last_run)}` : ''}${st.model ? `, model ${st.model}` : ''}.` : 'Off.' }),
        st.last_error ? h('p', { class: 'error', text: `Last error: ${st.last_error}` }) : null,
        h('ul', { class: 'webhook-list' }, rows),
        hidden('Search settings'));
}
