// Sign-in screen: one field for the admin key. The server sets an HttpOnly session cookie.
import { h, button, icon } from '../ui.js';
import { api } from '../api.js';

export function renderSignIn(root, onSignedIn) {
    document.title = 'Sign in - Personal hub';
    const error = h('p', { class: 'field-error', id: 'key-error', role: 'alert' });
    const input = h('input', {
        type: 'password', id: 'key', name: 'key', autocomplete: 'current-password', required: true,
        'aria-describedby': 'key-help key-error', spellcheck: 'false',
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
    h('p', { class: 'signin-lede', text: 'Where your data meets your agents. Sign in with the admin key to see and change what each one can reach.' }),
    h('div', { class: 'field' },
        h('label', { for: 'key', text: 'Admin key' }),
        input,
        h('p', { class: 'field-help', id: 'key-help', text: 'ADMIN_KEY in the service .env file. Five wrong tries lock sign-in for 15 minutes.' }),
        error),
    submit,
    h('p', { class: 'signin-foot' }, icon('info'), h('span', { text: 'The session lasts 12 hours on this browser.' })));

    root.replaceChildren(h('main', { class: 'signin' }, form));
    input.focus();
}
