// JSON calls to /admin/api. Every request carries X-Requested-With (the server refuses changes without it).
let onUnauthorized = () => {};

export function setUnauthorizedHandler(fn) {
    onUnauthorized = fn;
}

export async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
        res = await fetch(`api${path}`, {
            method,
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'hub-admin', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch (e) {
        throw new Error('The hub did not answer. Check that the service is running, then try again.');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (res.status === 401 && path !== '/login') {
        onUnauthorized();
        throw new Error('Your session ended. Sign in again.');
    }
    if (!res.ok) {
        const err = new Error((data && data.error) || `The request failed (${res.status}).`);
        err.status = res.status;
        throw err;
    }
    return data;
}
