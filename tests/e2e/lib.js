// Shared helpers for the browser flows in tests/e2e. SCRATCH hubs only: every function here refuses port 3000 and
// anything inside the repo's own data/ directory. See README.md for the environment variables.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const E2E_DIR = __dirname;
const REPO = path.resolve(__dirname, '..', '..');
const KEY = process.env.E2E_KEY || 'e'.repeat(40);
const LIVE_PORT = 3000;

function assertScratchPort(port) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error(`e2e: bad port ${port}`);
    if (p === LIVE_PORT) throw new Error('e2e: refusing to run against port 3000 (the live hub)');
    return p;
}

// Hard guard for runners pointed at a URL: only localhost, never port 3000.
function assertScratchUrl(url) {
    const u = new URL(url);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error(`e2e: refusing non-local host ${u.hostname}`);
    assertScratchPort(u.port || (u.protocol === 'https:' ? 443 : 80));
    return url;
}

// A data dir is acceptable only when it is outside the repo and is not the live data dir.
function assertScratchData(dir) {
    const real = (p) => { try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); } };
    const d = real(dir);
    const inside = (a, b) => a === b || a.startsWith(b + path.sep);
    if (inside(d, real(path.join(REPO, 'data'))) || inside(d, REPO)) throw new Error(`e2e: refusing data dir inside the repo: ${d}`);
    if (process.env.HUB_DATA_DIR && inside(d, real(process.env.HUB_DATA_DIR))) throw new Error('e2e: refusing the HUB_DATA_DIR data dir');
    return d;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

// Directory with node_modules built for node 20 (better-sqlite3 inside). The host node_modules is not enough.
function findNodeModules() {
    const cands = [process.env.E2E_NODE_MODULES, path.join(REPO, 'node_modules'), '/tmp/pa-run4/node_modules', '/tmp/pa-flights/node_modules'].filter(Boolean);
    for (const c of cands) if (fs.existsSync(path.join(c, 'better-sqlite3', 'package.json')) && fs.existsSync(path.join(c, 'express'))) return c;
    throw new Error('e2e: no node_modules with better-sqlite3 found; set E2E_NODE_MODULES (see tests/e2e/README.md)');
}

function copyCode(dest) {
    fs.mkdirSync(dest, { recursive: true });
    execFileSync('rsync', ['-a', '--delete', '--exclude', 'node_modules', '--exclude', '.git', '--exclude', 'data', '--exclude', '.env', '--exclude', 'coverage',
        '--exclude', 'chromadb_data', '--exclude', 'logs', '--exclude', 'tests', `${REPO}/`, `${dest}/`], { stdio: 'ignore' });
}

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const idArgs = () => (typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : []);

// Starts a scratch hub in a node:20 container: code copy of this repo, a temp data dir, admin key 'eee...'.
// opts: { seed: 'seed.js' | null, port, name }. Returns { port, origin, base, key, dataDir, outDir, seedCmd(file), stop() }.
async function startHub(opts = {}) {
    const port = assertScratchPort(opts.port || process.env.E2E_PORT || await freePort());
    const root = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), 'pa-e2e-'));
    const dataDir = assertScratchData(path.join(root, 'data'));
    const outDir = path.join(root, 'out');
    const appDir = path.join(root, 'app');
    for (const d of [dataDir, outDir]) fs.mkdirSync(d, { recursive: true, mode: 0o777 });
    fs.chmodSync(dataDir, 0o777); fs.chmodSync(outDir, 0o777);
    copyCode(appDir);
    const nm = findNodeModules();
    const cname = `pa-e2e-${port}-${process.pid}`;
    const mounts = ['-v', `${appDir}:/app`, '-v', `${nm}:/app/node_modules:ro`, '-v', `${E2E_DIR}:/e2e:ro`, '-v', `${outDir}:/out`, '-v', `${dataDir}:${dataDir}`];
    const env = ['-e', `HUB_DATA_DIR=${dataDir}`, '-e', `ADMIN_KEY=${KEY}`, '-e', 'PORT=3000', '-e', 'NODE_ENV=development', '-e', 'E2E_OUT=/out'];
    const base = ['docker', 'run', ...idArgs(), ...mounts, ...env, '-w', '/app'];
    const seedCmd = (file) => ['docker', 'run', '--rm', ...base.slice(2), 'node:20', 'node', `/e2e/${file}`].map(sh).join(' ');
    const hub = {
        port, dataDir, outDir, root, key: KEY, origin: `http://localhost:${port}`, base: `http://localhost:${port}/admin/`, seedCmd,
        seed(file) { return execSync(seedCmd(file), { encoding: 'utf8' }).trim().split('\n').slice(-1)[0]; },
        stop() {
            try { execFileSync('docker', ['rm', '-f', cname], { stdio: 'ignore' }); } catch (e) { /* already gone */ }
            if (!process.env.E2E_KEEP) fs.rmSync(root, { recursive: true, force: true });
        },
    };
    if (opts.seed) hub.seed(opts.seed);
    execFileSync('docker', ['run', '-d', '--name', cname, ...idArgs(), '-p', `127.0.0.1:${port}:3000`, ...mounts, ...env, '-w', '/app', 'node:20', 'node', 'app.js'], { stdio: 'ignore' });
    for (let i = 0; i < 60; i++) {
        try { const r = await fetch(`http://localhost:${port}/health`); if (r.ok) return hub; } catch (e) { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 500));
    }
    hub.stop();
    throw new Error('e2e: scratch hub did not come up');
}

// playwright-core: E2E_PLAYWRIGHT (path to the package), then the OpenClaw install on this host, then a normal resolve.
function loadPlaywright() {
    const cands = [process.env.E2E_PLAYWRIGHT, '/home/voltex/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core', 'playwright-core', 'playwright'].filter(Boolean);
    const errs = [];
    for (const c of cands) { try { return require(c); } catch (e) { errs.push(c); } }
    throw new Error(`e2e: no playwright-core found (tried ${errs.join(', ')}); set E2E_PLAYWRIGHT`);
}

function launchBrowser() {
    const { chromium } = loadPlaywright();
    return chromium.launch({ executablePath: process.env.E2E_BROWSER || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
}

function shotsDir() {
    const d = process.env.SHOTS || path.join(os.tmpdir(), 'pa-e2e-shots');
    fs.mkdirSync(d, { recursive: true });
    return d;
}

// Writes a ~900px wide JPEG q70 (python3 + Pillow when present, else Playwright's own JPEG). Returns the size in bytes.
async function shrinkShot(page, name, opts = {}) {
    const out = path.join(shotsDir(), `${name}.jpg`);
    const raw = path.join(os.tmpdir(), `${name}-${process.pid}-raw.png`);
    await page.screenshot({ path: raw, fullPage: false, ...opts });
    try { execFileSync('python3', ['-I', path.join(E2E_DIR, 'shrink.py'), raw, out], { stdio: 'ignore' }); } catch (e) { fs.copyFileSync(raw, out); }
    fs.rmSync(raw, { force: true });
    return fs.statSync(out).size;
}

module.exports = { E2E_DIR, REPO, KEY, assertScratchPort, assertScratchUrl, assertScratchData, freePort, startHub, loadPlaywright, launchBrowser, shotsDir, shrinkShot };
