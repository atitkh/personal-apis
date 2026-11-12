// The two editable sections of Settings: the hub time zone and the backups (folder, schedule, keep, verify). Each section
// saves on its own (PUT /api/settings with only its own keys); errors from the hub show inline next to the field.
import { h, button, toggleSwitch, toast, bytes, hidden } from '../ui.js';

const zoneOk = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return Boolean(tz && tz.trim()); } catch (e) { return false; } };
const nowIn = (tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date());

function field(id, label, input, help, errorEl) {
    return h('div', { class: 'field' },
        h('label', { for: id, text: label }),
        input,
        help ? h('p', { class: 'note', id: `${id}-help`, text: help }) : null,
        errorEl || null);
}

// Plain-words schedule, e.g. "Every 24 hours (daily), keep 7".
export const everyWords = (n) => (n === 24 ? 'every 24 hours (daily)' : n === 168 ? 'every 168 hours (weekly)' : n === 1 ? 'every hour' : `every ${n} hours`);

export function timezoneSection(ctx, data) {
    const err = h('p', { class: 'error', role: 'alert' });
    const preview = h('p', { class: 'note', 'aria-live': 'polite' });
    const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    const input = h('input', { type: 'text', id: 's-tz-input', name: 'timezone', value: data.settings.timezone, list: 's-tz-list', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 's-tz-preview s-tz-err' });
    const save = button({ text: 'Save time zone', iconName: 'good', 'data-key': 'save-timezone' });
    preview.id = 's-tz-preview';
    err.id = 's-tz-err';
    const refresh = () => {
        const v = input.value.trim();
        input.removeAttribute('aria-invalid');
        err.textContent = '';
        if (!v) { preview.textContent = ''; return; }
        if (zoneOk(v)) preview.textContent = `Now there: ${nowIn(v)}.`;
        else { preview.textContent = ''; }
    };
    input.addEventListener('input', refresh);
    const tick = setInterval(refresh, 30000);
    ctx.onCleanup(() => clearInterval(tick));
    refresh();

    save.addEventListener('click', async () => {
        const v = input.value.trim();
        if (!zoneOk(v)) {
            input.setAttribute('aria-invalid', 'true');
            err.textContent = 'That is not a time zone name. Use one like America/Chicago or Asia/Kathmandu.';
            input.focus();
            return;
        }
        save.disabled = true;
        try {
            await ctx.api('/settings', { method: 'PUT', body: { timezone: v } });
            toast('Time zone saved');
            ctx.rerender();
        } catch (e) {
            input.setAttribute('aria-invalid', 'true');
            err.textContent = e.message;
        } finally { save.disabled = false; }
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } });

    return h('section', { class: 'panel settings-form', 'aria-labelledby': 's-tz' },
        h('h2', { id: 's-tz', text: 'Time zone' }),
        h('p', { class: 'note', text: 'The hub decides what "today" is in this zone: deadlines (days left, overdue), the briefing, and the check that yesterday\'s digest arrived.' }),
        h('datalist', { id: 's-tz-list' }, zones.map((z) => h('option', { value: z }))),
        field('s-tz-input', 'Hub time zone', input, `Default is ${data.defaults.timezone}. Pick from the list or type a name.`, null),
        preview, err,
        h('div', { class: 'form-actions' }, save));
}

export function backupSection(ctx, data) {
    const s = data.settings.backup;
    const state = { enabled: s.enabled, verify: s.verify_after };
    const err = h('p', { class: 'error', role: 'alert', id: 's-bk-err' });
    const test = h('p', { class: 'note', 'aria-live': 'polite', id: 's-bk-test' });
    const dirDefault = data.status.dirIsDefault ? data.status.dir : null;
    const dir = h('input', { type: 'text', id: 's-bk-dir', name: 'backup.dir', value: s.dir || '', placeholder: dirDefault || '/backups', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 's-bk-dir-help s-bk-test' });
    const every = h('input', { type: 'number', id: 's-bk-every', name: 'backup.every_hours', min: '1', max: '168', step: '1', value: String(s.every_hours), inputmode: 'numeric', 'aria-describedby': 's-bk-every-help' });
    const keep = h('input', { type: 'number', id: 's-bk-keep', name: 'backup.keep', min: '1', max: '90', step: '1', value: String(s.keep), inputmode: 'numeric', 'aria-describedby': 's-bk-keep-help' });
    const enabledText = h('span', { class: 'switch-text', text: s.enabled ? 'On' : 'Off' });
    const verifyText = h('span', { class: 'switch-text', text: s.verify_after ? 'On' : 'Off' });
    const enabled = toggleSwitch({ checked: s.enabled, label: 'Make backups automatically', key: 'backup-enabled', onChange: (v) => { state.enabled = v; enabled.setChecked(v); enabledText.textContent = v ? 'On' : 'Off'; } });
    const verify = toggleSwitch({ checked: s.verify_after, label: 'Check each new backup', key: 'backup-verify', onChange: (v) => { state.verify = v; verify.setChecked(v); verifyText.textContent = v ? 'On' : 'Off'; } });
    const save = button({ text: 'Save backups', iconName: 'good', 'data-key': 'save-backups' });
    const testBtn = button({ text: 'Test location', variant: 'quiet', iconName: 'backups', 'data-key': 'test-backup-dir' });
    const words = h('p', { class: 'note', 'aria-live': 'polite' });
    const sayWords = () => {
        const n = Number(every.value);
        const k = Number(keep.value);
        words.textContent = Number.isInteger(n) && n >= 1 && n <= 168 && Number.isInteger(k) && k >= 1 && k <= 90
            ? `That is ${everyWords(n)}, keeping the newest ${k} ${k === 1 ? 'copy' : 'copies'}.` : '';
    };
    every.addEventListener('input', sayWords);
    keep.addEventListener('input', sayWords);
    sayWords();

    testBtn.addEventListener('click', async () => {
        const target = dir.value.trim() || dirDefault || '';
        test.className = 'note';
        test.textContent = 'Testing…';
        testBtn.disabled = true;
        try {
            const r = await ctx.api('/settings/backup-dir/test', { method: 'POST', body: { dir: target } });
            if (r.ok) {
                test.className = 'note good-text';
                test.textContent = `Writable: ${r.resolved}${r.created ? ' (the folder did not exist and was created)' : ''}. ${r.free_bytes == null ? '' : `${bytes(r.free_bytes)} free.`}`;
            } else {
                test.className = 'error';
                test.textContent = r.error || `Cannot write in ${r.resolved}.`;
            }
        } catch (e) {
            test.className = 'error';
            test.textContent = e.message;
        } finally { testBtn.disabled = false; }
    });

    save.addEventListener('click', async () => {
        err.textContent = '';
        for (const el of [dir, every, keep]) el.removeAttribute('aria-invalid');
        const body = {
            enabled: state.enabled,
            dir: dir.value.trim() || null,
            every_hours: every.value.trim() === '' ? null : Number(every.value),
            keep: keep.value.trim() === '' ? null : Number(keep.value),
            verify_after: state.verify,
        };
        if (body.every_hours == null || body.keep == null) {
            const bad = body.every_hours == null ? every : keep;
            bad.setAttribute('aria-invalid', 'true');
            err.textContent = 'Fill in both numbers.';
            bad.focus();
            return;
        }
        save.disabled = true;
        try {
            await ctx.api('/settings', { method: 'PUT', body: { backup: body } });
            toast('Backup settings saved');
            ctx.rerender();
        } catch (e) {
            err.textContent = e.message;
            const bad = e.data && e.data.field && document.querySelector(`[name="${e.data.field}"]`);
            if (bad) { bad.setAttribute('aria-invalid', 'true'); bad.focus(); }
        } finally { save.disabled = false; }
    });

    return h('section', { class: 'panel settings-form', 'aria-labelledby': 's-bk' },
        h('h2', { id: 's-bk', text: 'Backups' }),
        h('p', { class: 'note', text: 'The hub copies its database by itself. Changes apply at the next check (every five minutes), no restart needed.' }),
        h('div', { class: 'setting-row' }, h('span', { class: 'field-label', text: 'Make backups automatically' }), h('span', { class: 'switch-wrap' }, enabled, enabledText)),
        field('s-bk-dir', 'Backup folder', dir,
            `A path inside the container. Leave empty for the default${dirDefault ? ` (${dirDefault})` : ''}. To keep copies off this machine, mount a host folder into the container and enter its path here.`, null),
        h('div', { class: 'form-actions' }, testBtn),
        test,
        field('s-bk-every', 'Back up every (hours)', every, 'From 1 to 168. 24 is daily. Below 24 the file names carry the time of day.', null),
        field('s-bk-keep', 'Keep the newest (copies)', keep, 'From 1 to 90. Older scheduled copies are deleted. Copies taken before a delete or a migration are kept separately.', null),
        words,
        h('div', { class: 'setting-row' }, h('span', { class: 'field-label', text: 'Check each new backup' }), h('span', { class: 'switch-wrap' }, verify, verifyText)),
        h('p', { class: 'note', text: 'Opens the fresh copy and runs SQLite\'s integrity check right after it is written. A failure shows up on the Overview.' }),
        err,
        h('div', { class: 'form-actions' }, save),
        hidden('Backup settings'));
}
