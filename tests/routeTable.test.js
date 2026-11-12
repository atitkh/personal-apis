// Route-table check for the refactor: every route and middleware layer of /admin and /hub, in registration order,
// must match tests/__snapshots__/routes.json. Regenerate on purpose with: UPDATE_ROUTES=1 npx jest tests/routeTable.test.js
const fs = require('fs');
const path = require('path');

const SNAPSHOT = path.join(__dirname, '__snapshots__', 'routes.json');

function mountPath(layer) {
    if (layer.regexp.fast_slash) return '';
    let src = layer.regexp.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\$$/, '');
    const keys = (layer.keys || []).map((k) => k.name);
    src = src.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${keys.shift()}`);
    return src.replace(/\\\//g, '/');
}

function walk(stack, prefix, out) {
    for (const layer of stack) {
        if (layer.route) {
            const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]).map((m) => m.toUpperCase()).join(',');
            out.push(`${methods} ${prefix}${layer.route.path}`);
        } else if (layer.name === 'router' && layer.handle.stack) {
            const mp = mountPath(layer);
            out.push(`MOUNT ${prefix}${mp || '/'}`);
            walk(layer.handle.stack, prefix + mp, out);
        } else {
            out.push(`USE ${prefix}${mountPath(layer) || '/'} ${layer.name === '<anonymous>' ? 'fn' : layer.name}`);
        }
    }
}

function table() {
    const { createAdminRouter } = require('../routes/admin/admin');
    const hub = require('../routes/hub/hub');
    const admin = [];
    walk(createAdminRouter().stack, '/admin', admin);
    const hubRoutes = [];
    walk(hub.stack, '/hub', hubRoutes);
    return { admin, hub: hubRoutes };
}

test('route table is unchanged', () => {
    const now = table();
    if (process.env.UPDATE_ROUTES) {
        fs.writeFileSync(SNAPSHOT, `${JSON.stringify(now, null, 2)}\n`);
        return;
    }
    expect(now).toEqual(JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')));
});
