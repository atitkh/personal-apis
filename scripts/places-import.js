#!/usr/bin/env node
// Imports a markdown table of known places (columns: Match, Label, Notes) into the places domain.
// Run inside the container so it uses the same database file as the server (or point HUB_DB_FILE at a copy):
//   docker exec -i personal-hub node scripts/places-import.js - < known-places.md
//   node scripts/places-import.js <table.md> [--dry-run] [--force] [--exclude "Label=text"]...
//
// What it does, and it is safe to repeat:
//   - Rows with the same Label become ONE place; each Match becomes a street rule of it.
//   - A place that exists (same label, any case) is updated, never duplicated: missing street rules are
//     added, rules are never removed (so exclude rules added by hand survive a re-run).
//   - Notes follow the table until a person edits them; after that they are kept, unless --force.
//   - Kind is guessed from the label once, at creation (home, campus, store, family, else other).
//   - --dry-run shows what would happen and changes nothing.
//
// MANUAL STEP. A note that says a street is NOT the place ("... Jackson Heights is NOT this place") cannot
// be read reliably, so the importer only prints such notes. Turn each into an exclude rule yourself:
//   --exclude "Kunjal's place (NYC)=Jackson Heights"       (repeatable, also safe to repeat)
// or later: POST /hub/places/<id>/rules  { "type": "street", "value": "Jackson Heights", "exclude": true }
const fs = require('fs');
const places = require('../services/places');

const ACTOR = 'places-import';
const strip = (s) => s.trim().replace(/^[*_`]+|[*_`]+$/g, '').trim();
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

// [{ match, label, notes }] from the first table whose header has Match, Label and Notes columns.
function parseTable(markdown) {
    const rows = [];
    let cols = null;
    for (const line of String(markdown).split(/\r?\n/)) {
        if (!line.trim().startsWith('|')) continue;
        const c = cells(line);
        if (!cols) {
            const names = c.map((x) => strip(x).toLowerCase());
            const at = (word) => names.findIndex((n) => n.startsWith(word));
            if (at('match') >= 0 && at('label') >= 0 && at('notes') >= 0) cols = { match: at('match'), label: at('label'), notes: at('notes') };
            continue;
        }
        if (c.every((x) => /^:?-+:?$/.test(x))) continue; // the |---|---| line
        const match = strip(c[cols.match] || '');
        const label = strip(c[cols.label] || '');
        const notes = (c[cols.notes] || '').trim();
        if (match && label) rows.push({ match, label, notes: /^[-–—]*$/.test(notes) ? '' : notes });
    }
    if (!cols) throw new Error('No table with Match, Label and Notes columns was found.');
    return rows;
}

function kindFor(label) {
    if (/^home$/i.test(label)) return 'home';
    if (/campus|university/i.test(label)) return 'campus';
    if (/shop|store|mall|market/i.test(label)) return 'store';
    if (/brother|sister|mother|father|parents|family/i.test(label)) return 'family';
    return 'other';
}

function group(rows) {
    const groups = new Map();
    for (const row of rows) {
        const key = row.label.toLowerCase();
        if (!groups.has(key)) groups.set(key, { label: row.label, rows: [] });
        const g = groups.get(key);
        if (!g.rows.some((r) => places.fold(r.match) === places.fold(row.match))) g.rows.push(row);
    }
    return [...groups.values()].map((g) => {
        const noted = g.rows.filter((r) => r.notes);
        // One row: its note. Several rows: one line per street, so it stays clear which note is about which.
        const notes = g.rows.length === 1 ? g.rows[0].notes : noted.map((r) => `${r.match}: ${r.notes}`).join('\n');
        return { label: g.label, matches: g.rows.map((r) => r.match), notes: notes || null };
    });
}

// Who wrote the notes as they are now: the source of the newest revision in which they changed.
function notesOwner(db, place) {
    for (let rev = place.rev; rev >= 1; rev -= 1) {
        const at = places.get(db, place.id, { rev });
        if (rev === 1 || places.get(db, place.id, { rev: rev - 1 }).notes !== at.notes) {
            return places.history(db, place.id).find((h) => h.rev === rev).source;
        }
    }
    return null;
}

const hasStreet = (place, text) => place.rules.some((r) => r.type === 'street' && places.fold(r.value) === places.fold(text));

// Returns { places: [{ label, status, rules_added, notes, error? }], manual: [...], excludes: [...] }.
function run(db, markdown, { force = false, dryRun = false, excludes = [], actor = ACTOR } = {}) {
    const rows = parseTable(markdown);
    const report = { places: [], manual: [], excludes: [] };
    const find = (label) => places.list(db).find((p) => p.label.toLowerCase() === label.toLowerCase());

    db.exec('BEGIN');
    try {
        for (const g of group(rows)) {
            const line = { label: g.label, status: 'unchanged', rules_added: 0, notes: 'same' };
            try {
                const existing = find(g.label);
                if (!existing) {
                    places.create(db, { label: g.label, kind: kindFor(g.label), notes: g.notes, rules: g.matches.map((value) => ({ type: 'street', value })) }, actor, { source: 'import' });
                    Object.assign(line, { status: 'created', rules_added: g.matches.length, notes: g.notes ? 'set' : 'none' });
                } else {
                    for (const value of g.matches) {
                        if (hasStreet(existing, value)) continue;
                        places.addRule(db, existing.id, { type: 'street', value }, actor, { source: 'import' });
                        line.rules_added += 1;
                    }
                    if ((existing.notes || null) !== g.notes) {
                        if (force || existing.notes == null || notesOwner(db, existing) === 'import') {
                            places.update(db, existing.id, { notes: g.notes }, actor, { source: 'import' });
                            line.notes = 'updated';
                        } else {
                            line.notes = 'kept (edited by hand, --force replaces them)';
                        }
                    }
                    if (line.rules_added || line.notes === 'updated') line.status = 'updated';
                }
            } catch (err) {
                if (!(err instanceof places.PlaceError)) throw err;
                Object.assign(line, { status: 'failed', error: err.message });
            }
            report.places.push(line);
        }

        for (const row of rows) {
            if (/\bnot\b/i.test(row.notes)) report.manual.push({ label: row.label, match: row.match, notes: row.notes });
        }

        for (const spec of excludes) {
            const cut = String(spec).lastIndexOf('=');
            const label = cut > 0 ? spec.slice(0, cut).trim() : '';
            const value = cut > 0 ? spec.slice(cut + 1).trim() : '';
            const line = { label, status: 'unchanged' };
            try {
                const place = label && find(label);
                if (!place || !value) throw new places.PlaceError(400, 'bad_exclude', place ? 'Write it as "Label=text".' : `There is no place called "${label}".`);
                const same = place.rules.find((r) => r.type === 'street' && places.fold(r.value) === places.fold(value));
                if (same && !same.exclude) throw new places.PlaceError(409, 'bad_exclude', 'That text is one of the place\'s own street rules.');
                if (!same) {
                    places.addRule(db, place.id, { type: 'street', value, exclude: true }, actor, { source: 'import' });
                    line.status = 'added';
                }
            } catch (err) {
                if (!(err instanceof places.PlaceError)) throw err;
                Object.assign(line, { status: 'failed', error: err.message });
            }
            report.excludes.push(line);
        }
        db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
    } catch (err) {
        if (db.inTransaction) db.exec('ROLLBACK');
        throw err;
    }
    return report;
}

function print(report, { dryRun }) {
    const out = [];
    if (dryRun) out.push('Dry run: nothing was changed.');
    for (const p of report.places) {
        const bits = [`${p.rules_added} street ${p.rules_added === 1 ? 'rule' : 'rules'} added`, `notes ${p.notes}`];
        out.push(`${p.status.padEnd(9)} ${p.label}${p.status === 'failed' ? `: ${p.error}` : p.status === 'unchanged' ? '' : ` (${bits.join(', ')})`}`);
    }
    for (const e of report.excludes) out.push(`exclude   ${e.label}: ${e.status}${e.error ? ` (${e.error})` : ''}`);
    if (report.manual.length) {
        out.push('', 'Manual step: these notes say a street is NOT the place. Add an exclude rule for each (see the top of this script):');
        for (const m of report.manual) out.push(`  ${m.label} / ${m.match}: ${m.notes}`);
    }
    return out.join('\n');
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const opts = { force: false, dryRun: false, excludes: [] };
    let file = null;
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--force') opts.force = true;
        else if (args[i] === '--dry-run') opts.dryRun = true;
        else if (args[i] === '--exclude' && args[i + 1]) opts.excludes.push(args[i += 1]);
        else if (file === null && (args[i] === '-' || !args[i].startsWith('--'))) file = args[i];
        else file = false; // an option this script does not know
    }
    if (!file) {
        console.error('Usage: places-import.js <table.md | -> [--dry-run] [--force] [--exclude "Label=text"]...');
        process.exit(2);
    }
    const db = require('../db');
    try {
        const report = run(db.get(), fs.readFileSync(file === '-' ? 0 : file, 'utf8'), opts);
        console.log(print(report, opts));
        db.close();
        if ([...report.places, ...report.excludes].some((l) => l.status === 'failed')) process.exit(1);
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

module.exports = { parseTable, group, kindFor, run, print };
