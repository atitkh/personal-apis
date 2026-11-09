#!/usr/bin/env node
// Manage API keys. Run inside the container so it uses the same database file as the server:
//   docker exec nodejs node scripts/keys.js create <name> <scope[,scope...]>
//   docker exec nodejs node scripts/keys.js list
//   docker exec nodejs node scripts/keys.js revoke <id|name>
const db = require('../db');
const apiKeys = require('../services/apiKeys');

const [cmd, ...args] = process.argv.slice(2);

function usage() {
    console.error('Usage:\n  keys.js create <name> <scope[,scope...]>   (scopes look like attendance:read, flights:*, or *)\n  keys.js list\n  keys.js revoke <id|name>');
    process.exit(2);
}

try {
    const conn = db.get();
    if (cmd === 'create') {
        if (args.length < 2) usage();
        const k = apiKeys.create(conn, { name: args[0], scopes: args[1] });
        console.log(`Created key #${k.id} "${k.name}" with scopes: ${k.scopes.join(', ')}`);
        console.log('\n  ' + k.key + '\n');
        console.log('Store it now: it is not saved anywhere and cannot be shown again.');
    } else if (cmd === 'list') {
        const rows = apiKeys.list(conn);
        if (rows.length === 0) console.log('No keys yet.');
        for (const r of rows) {
            const state = r.revoked_at ? `revoked ${r.revoked_at}` : `last used ${r.last_used_at || 'never'}`;
            console.log(`#${r.id}  ${r.name}  ${r.key_prefix}…  [${r.scopes.join(', ')}]  created ${r.created_at}  ${state}`);
        }
    } else if (cmd === 'revoke') {
        if (args.length < 1) usage();
        console.log(apiKeys.revoke(conn, args[0]) ? `Revoked ${args[0]}.` : `No active key matches "${args[0]}".`);
    } else {
        usage();
    }
    db.close();
} catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
}
