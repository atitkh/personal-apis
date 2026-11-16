// What a domain page says about its on/off switch. Switched off: a notice above the page header that says what
// off really means, with Turn on and (for domains that have an agent tool) the agent access selector. On: a
// quiet "Switch off" button in the page header's actions. Both follow domainState live.
//
// What off does (the hub's own behaviour, not a promise made here): agents lose the domain's MCP tool, search,
// the briefing, the graph and links skip it, and its /hub REST routes answer "switched off". The admin pages
// keep working on the records, which are never touched; for the portfolio the public site stops loading.
import { h, icon, button, toast, confirmDialog } from './ui.js';
import * as state from './domainState.js';

const MODE_LABEL = { off: 'Off', read: 'Read', write: 'Read and write' };
const OFF_BODY = 'Agents and search stop using it; records stay.';

const what = (d) => (d.name === 'portfolio'
    ? 'The public portfolio site is not served until it is turned back on. Your files are untouched, and you can still edit them here.'
    : 'Agents, search, the briefing and the graph skip it, and API keys get a "switched off" answer for it. Your records are untouched, and you can still open and edit them here.');

let seq = 0;

// Adds the notice and the header button to a freshly rendered view; `node` is the view's root (.view).
// Pages that are not a domain's page (or an error placeholder) are left alone.
export function decorate(node, routeName, { onCleanup } = {}) {
    const name = state.domainOfRoute(routeName);
    if (!name || !node || !node.classList || !node.classList.contains('view')) return;
    const id = ++seq;

    let banner = null;
    let errorLine = null;
    let select = null;
    let busy = false;

    const switchOff = button({ text: 'Switch off', variant: 'quiet', size: 'small', iconName: 'power', class: 'btn quiet small domain-off-btn', hidden: true });
    switchOff.addEventListener('click', async () => {
        const d = state.get(name);
        if (!d || busy) return;
        const ok = await confirmDialog({
            title: `Switch off ${d.title}?`,
            body: d.confirmOff || OFF_BODY,
            confirm: 'Switch off',
            danger: true,
        });
        if (!ok) return;
        busy = true;
        switchOff.disabled = true;
        try {
            await state.setEnabled(name, false);
            toast(`${d.title} is off`, { kind: 'info' });
        } catch (err) {
            toast(`Could not switch ${d.title} off. ${err.message}`, { kind: 'bad' });
        } finally {
            busy = false;
            switchOff.disabled = false;
        }
    });

    // The button lives in the first page header's actions (made if the header has none).
    const mount = () => {
        if (switchOff.isConnected) return;
        const head = node.querySelector('.page-header');
        if (!head) return;
        let actions = head.querySelector('.page-header-actions');
        if (!actions) { actions = h('div', { class: 'page-header-actions' }); head.append(actions); }
        actions.append(switchOff);
    };

    async function turnOn(d, btn) {
        if (busy) return;
        busy = true;
        btn.disabled = true;
        if (errorLine) errorLine.textContent = '';
        try {
            await state.setEnabled(name, true);
            toast(`${d.title} is on`);
        } catch (err) {
            if (errorLine) errorLine.textContent = `Could not turn ${d.title} on. ${err.message}`;
        } finally {
            busy = false;
            btn.disabled = false;
        }
    }

    async function setMode(d, mode) {
        if (busy) return;
        if (mode === 'write' && d.mcpMode !== 'write') {
            let warn = null;
            try { warn = (await import('./views/overview.js')).writeWarning(name); } catch (e) { /* the generic line below */ }
            const ok = await confirmDialog({
                title: `Let agents change ${d.title}?`,
                body: warn || "Agents holding an agent-write or publish scope will be able to change this domain's data.",
                confirm: 'Allow changes',
                danger: true,
            });
            if (!ok) { select.value = d.mcpMode; return; }
        }
        busy = true;
        select.disabled = true;
        if (errorLine) errorLine.textContent = '';
        try {
            await state.setMode(name, mode);
            toast(`Agent access for ${d.title} set to ${MODE_LABEL[mode].toLowerCase()}`);
        } catch (err) {
            select.value = d.mcpMode;
            if (errorLine) errorLine.textContent = `Could not change agent access for ${d.title}. ${err.message}`;
        } finally {
            busy = false;
            select.disabled = false;
        }
    }

    function build(d) {
        const turn = button({ text: 'Turn on', variant: 'primary', size: 'small', iconName: 'power' });
        turn.addEventListener('click', () => turnOn(d, turn));
        errorLine = h('p', { class: 'error domain-notice-error', role: 'alert' });
        const controls = [turn];
        select = null;
        if (d.mcpTool) {
            const sid = `domain-notice-mode-${id}`;
            select = h('select', { id: sid, class: 'domain-notice-mode' }, Object.entries(MODE_LABEL).map(([k, label]) => h('option', { value: k, text: label })));
            select.value = d.mcpMode;
            select.addEventListener('change', () => setMode(state.get(name) || d, select.value));
            controls.push(h('label', { class: 'domain-notice-select', for: sid }, h('span', { text: 'Agent access' }), select));
        }
        return h('section', { class: 'domain-notice', role: 'region', 'aria-label': `${d.title} is switched off`, 'data-domain': name },
            h('span', { class: 'domain-notice-icon', 'aria-hidden': 'true' }, icon('power')),
            h('div', { class: 'domain-notice-text' },
                h('p', {}, h('strong', { text: `${d.title} is switched off.` }), ' ', what(d))),
            h('div', { class: 'domain-notice-actions' }, controls),
            errorLine);
    }

    function paint() {
        const d = state.get(name);
        const off = Boolean(d) && d.enabled === false;
        if (off) {
            if (banner && !banner.isConnected) banner = null;
            if (!banner) {
                banner = build(d);
                node.prepend(banner);
            } else if (select && d.mcpTool && select.value !== d.mcpMode && !busy) select.value = d.mcpMode;
        } else if (banner) {
            banner.remove();
            banner = null;
        }
        mount();
        switchOff.hidden = !d || off;
    }

    paint();
    const unsub = state.subscribe(paint);
    if (onCleanup) onCleanup(unsub);
}
