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
        const err = new Error('The hub did not answer. Check the connection and that the service is running, then try again.');
        err.network = true;
        throw err;
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (res.status === 401 && path !== '/login') {
        onUnauthorized();
        const err = new Error('Your session ended. Sign in again.');
        err.status = 401;
        throw err;
    }
    if (!res.ok) {
        const err = new Error((data && data.error) || `The request failed (${res.status}).`);
        err.status = res.status;
        if (data && data.code) err.code = data.code;
        err.data = data;
        throw err;
    }
    return data;
}
