// Sign-in screen: one field for the admin key. The server sets an HttpOnly session cookie.
import { h, button, icon } from '../ui.js';
import { api } from '../api.js';

// `note`: why the screen is back (the session ended), shown above the field.
export function renderSignIn(root, onSignedIn, { note = '' } = {}) {
    document.title = 'Sign in - Personal hub';
    const error = h('p', { class: 'field-error', id: 'key-error', role: 'alert' });
    const input = h('input', {
        type: 'password', id: 'key', name: 'key', autocomplete: 'current-password', required: true,
        'aria-describedby': 'key-error', spellcheck: 'false',
    });
    const submit = button({ text: 'Sign in', type: 'submit', class: 'btn wide' });

    const form = h('form', {
        class: 'signin-card',
        'aria-labelledby': 'signin-title',
        onsubmit: async (event) => {
            event.preventDefault();
            error.textContent = '';
            input.removeAttribute('aria-invalid');
            submit.disabled = true;
            submit.querySelector('span').textContent = 'Signing in…';
            try {
                await api('/login', { method: 'POST', body: { key: input.value } });
                input.value = '';
                await onSignedIn();
            } catch (err) {
                error.textContent = err.message;
                input.setAttribute('aria-invalid', 'true');
                input.select();
                submit.disabled = false;
                submit.querySelector('span').textContent = 'Sign in';
            }
        },
    },
    h('div', { class: 'signin-brand', 'aria-hidden': 'true' },
        h('span', { class: 'brand-mark large' }, h('span', { class: 'bm a' }), h('span', { class: 'bm b' }), h('span', { class: 'bm c' }))),
    h('h1', { id: 'signin-title', text: 'Personal hub' }),
    note ? h('p', { class: 'signin-note', role: 'status' }, icon('info'), h('span', { text: note })) : null,
    h('div', { class: 'field' },
        h('label', { for: 'key', text: 'Admin key' }),
        input,
        error),
    submit);

    root.replaceChildren(h('main', { class: 'signin' }, form));
    input.focus();
}
