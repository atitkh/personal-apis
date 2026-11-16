// The notes markdown renderer (routes/admin/public/markdown.js, a browser ES module): run in a child node process because
// jest here loads CommonJS. The renderer builds elements through an adapter, so the tests use a DOM-free one that records
// every element and attribute it is asked to create: that is what an attacker's text could possibly reach.
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const file = pathToFileURL(path.join(__dirname, '../routes/admin/public/markdown.js')).href;

function run(body) {
    const code = `const md = await import(${JSON.stringify(file)});
const made = [];
const adapter = {
  el: (tag, attrs, kids) => { const e = { tag, attrs: attrs || {}, kids: kids || [] }; made.push(e); return e; },
  text: (s) => ({ text: String(s) }),
};
const html = (n) => (n.text != null ? n.text.replace(/&/g, '&amp;').replace(/</g, '&lt;') : '<' + n.tag + Object.entries(n.attrs).map(([k, v]) => ' ' + k + '=' + JSON.stringify(v)).join('') + '>' + n.kids.map(html).join('') + '</' + n.tag + '>');
const render = (src, opts) => { made.length = 0; const root = md.render(src, { adapter, ...(opts || {}) }); return { html: html(root), made: made.map((e) => ({ tag: e.tag, attrs: Object.keys(e.attrs) })), hrefs: made.filter((e) => e.attrs.href !== undefined).map((e) => e.attrs.href) }; };
const out = await (async () => { ${body} })();
process.stdout.write(JSON.stringify(out));`;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
    if (res.status !== 0) throw new Error(res.stderr.slice(0, 2000));
    return JSON.parse(res.stdout);
}

describe('blocks and inline', () => {
    test('headings, paragraphs with line breaks, emphasis, code, strike, escapes', () => {
        const o = run(`return render('# Title\\n\\nline one\\nline **two** and *three* ~~four~~ \`c<d>\` snake_case_name \\\\*not\\\\*\\n\\n## Sub ##').html;`);
        expect(o).toBe('<div class="md"><h1>Title</h1><p>line one<br></br>line <strong>two</strong> and <em>three</em> <del>four</del> <code>c&lt;d></code> snake_case_name *not*</p><h2>Sub</h2></div>');
    });

    test('code fences keep their text as text; quotes, rules, lists, ordered lists and tasks', () => {
        const o = run(`return render('\`\`\`js\\n<b>x</b> [[Not a link]]\\n\`\`\`\\n\\n> quoted *text*\\n\\n---\\n\\n- a\\n  - nested\\n- b\\n\\n3. three\\n4. four\\n\\n- [ ] open\\n- [x] done').html;`);
        expect(o).toContain('<pre><code class="lang-js">&lt;b>x&lt;/b> [[Not a link]]</code></pre>');
        expect(o).toContain('<blockquote><p>quoted <em>text</em></p></blockquote>');
        expect(o).toContain('<hr>');
        expect(o).toContain('<ul><li><p>a</p><ul><li><p>nested</p></li></ul></li><li><p>b</p></li></ul>');
        expect(o).toContain('<ol start="3"><li><p>three</p></li><li><p>four</p></li></ol>');
        expect(o).toContain('class="md-task-item"');
        expect(o.match(/type="checkbox"/g)).toHaveLength(2);
        expect(o).toContain('checked=true');
    });

    test('tables and links: external opens safely, hub routes stay in the page, images are links', () => {
        const o = run(`return render('| a | b |\\n|:--|--:|\\n| 1 | **2** |\\n\\n[site](https://example.com/x?y=1) [mail](mailto:a@b.co) [note](#/notes/4) ![pic](https://example.com/p.png) <https://example.org> and https://example.net/path.').html;`);
        expect(o).toContain('<th style="text-align:left">a</th><th style="text-align:right">b</th>');
        expect(o).toContain('<td style="text-align:right"><strong>2</strong></td>');
        expect(o).toContain('<a href="https://example.com/x?y=1" class="md-link" target="_blank" rel="noopener noreferrer">site</a>');
        expect(o).toContain('<a href="#/notes/4" class="md-link">note</a>');
        expect(o).toContain('<a href="mailto:a@b.co"');
        expect(o).toContain('class="md-link md-image" target="_blank" rel="noopener noreferrer">pic</a>');
        expect(o).toContain('<a href="https://example.net/path" class="md-link" target="_blank" rel="noopener noreferrer">https://example.net/path</a>.');
        expect(o).not.toContain('<img');
    });

    test('wikilinks come out as resolved, missing or pending, through the view callback', () => {
        const o = run(`return render('See [[Seed bank]], [[Ghost|the ghost]], [[trips:3|Paris]] and [[Later]].', { wikilink: (n) => n.target === 'Seed bank' ? { href: '#/notes/2' } : n.target === 'Ghost' ? { missing: true } : n.target === 'trips:3' ? { href: '#/trips/3' } : null }).html;`);
        expect(o).toContain('<a href="#/notes/2" class="wikilink">Seed bank</a>');
        expect(o).toContain('class="wikilink missing" role="button" data-create="Ghost"');
        expect(o).toContain('>the ghost</a>');
        expect(o).toContain('<a href="#/trips/3" class="wikilink">Paris</a>');
        expect(o).toContain('<span class="wikilink pending">Later</span>');
        expect(run(`return md.wikilinkTargets('[[A]] \`[[B]]\` [[a|x]] [[C]]\\n\`\`\`\\n[[D]]\\n\`\`\`\\n- [[E]]');`)).toEqual(['A', 'C', 'E']);
    });

    test('toggleTaskLine flips the marker on the right line, also in lists and quotes', () => {
        expect(run(`return [md.toggleTaskLine('a\\n- [ ] x\\n- [x] y', 1), md.toggleTaskLine('a\\n- [ ] x\\n- [x] y', 2), md.toggleTaskLine('> 1. [ ] z', 0), md.toggleTaskLine('a', 0), md.toggleTaskLine('a', 5)];`))
            .toEqual(['a\n- [x] x\n- [x] y', 'a\n- [ ] x\n- [ ] y', '> 1. [x] z', null, null]);
        const o = run(`const r = render('x\\n\\n- [ ] one\\n> - [x] two'); return r.html;`);
        expect(o).toContain('data-line="2"');
        expect(o).toContain('data-line="3"');
    });
});

describe('safety', () => {
    const CORPUS = [
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        '<a href="javascript:alert(1)">x</a>',
        '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](  javascript:alert(1))', '[x](java\tscript:alert(1))',
        '[x](data:text/html;base64,PHNjcmlwdD4=)', '[x](vbscript:msgbox)', '[x](//evil.example/x)', '[x](/relative)', '[x](file:///etc/passwd)',
        '![x](javascript:alert(1))', '![x](https://evil.example/track.png)', '<https://ok.example"onmouseover="alert(1)>',
        '[x](https://ok.example" onmouseover="alert(1))', '[[x" onmouseover="alert(1)]]', '[[<script>]]|label',
        '**<svg onload=alert(1)>**', '`<iframe src=x>`', '<iframe srcdoc="<script>1</script>"></iframe>',
        '[a]([b](javascript:alert(1)))', '[![x](https://e.example/i.png)](javascript:alert(1))',
        '\\<script>alert(1)\\</script>', '&lt;script&gt;', '<style>*{display:none}</style>', '<meta http-equiv=refresh content="0;url=javascript:1">',
        '[x](#/notes/1" onclick="alert(1))', 'https://ok.example/"onmouseover="alert(1)', '[x](https://ok.example/\u0000javascript:1)',
    ];
    const ALLOWED_TAGS = ['div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'pre', 'code', 'strong', 'em', 'del', 'a', 'blockquote', 'ul', 'ol', 'li', 'input', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span'];
    const ALLOWED_ATTRS = ['class', 'href', 'target', 'rel', 'role', 'data-create', 'title', 'start', 'type', 'data-line', 'aria-label', 'checked', 'disabled', 'style'];

    test('the attack corpus only ever creates harmless elements and attributes', () => {
        const o = run(`return ${JSON.stringify(CORPUS)}.map((s) => { const r = render(s, { wikilink: () => null }); return { s, made: r.made, hrefs: r.hrefs, html: r.html }; });`);
        for (const r of o) {
            for (const e of r.made) {
                expect(ALLOWED_TAGS).toContain(e.tag);
                for (const a of e.attrs) expect(ALLOWED_ATTRS).toContain(a);
            }
            for (const h of r.hrefs) expect(h).toMatch(/^(https?:\/\/[^\s"<>]+|mailto:[^\s]+|#\/[^\s"<>]*|#)$/);
            expect(r.html).not.toMatch(/<(script|img|iframe|svg|style|meta)/i);   // the serialiser escapes text, so a real tag would show here
        }
    });

    test('unsafe addresses stay as the text typed; no link element is made for them', () => {
        const o = run(`return render('[x](javascript:alert(1)) and [y](//evil.example/x) and [z](/rel)');`);
        expect(o.hrefs).toEqual([]);
        expect(o.html).toContain('[x](javascript:alert(1))');
    });

    test('safeHref allows only http, https, mailto and hub routes', () => {
        expect(run(`return ['https://a.example/x', 'http://a.example', 'mailto:a@b.co', '#/notes/3?x=1', 'javascript:1', ' javascript:1', 'ftp://a.example', '#', '#frag', 'https://', 'https://a.example/ x', '//a.example', 'https://a.example/\\u0001'].map((u) => !!md.safeHref(u));`))
            .toEqual([true, true, true, true, false, false, false, false, false, false, false, false, false]);
    });

    test('unclosed and nested markup, huge input and deep nesting finish quickly and do not blow the stack', () => {
        const t0 = Date.now();
        const o = run(`
            const deepQuote = '> '.repeat(5000) + 'x';
            const deepList = Array.from({ length: 3000 }, (_, i) => ' '.repeat(i * 2) + '- item').join('\\n');
            const deepEm = '*a '.repeat(20000) + '**b '.repeat(20000);
            const brackets = '[['.repeat(50000) + '[a](' .repeat(20000);
            const ticks = Array.from({ length: 440 }, (_, i) => '\`'.repeat(i + 1) + 'x').join(' ');
            const spaces = '# a' + ' '.repeat(90000) + 'b';
            const fence = '\`\`\`' + ' '.repeat(50000) + '\`';
            const pipes = ('| a '.repeat(200) + '|\\n').repeat(400);
            const cases = [deepQuote, deepList, deepEm, brackets, ticks, spaces, fence, pipes, 'x'.repeat(300000), '<'.repeat(100000), '_'.repeat(100000), '~'.repeat(100000), '| a |\\n|---|\\n'.repeat(5000)];
            return cases.map((c) => { const t = Date.now(); const r = render(c); return { ms: Date.now() - t, n: r.html.length }; });`);
        for (const r of o) expect(r.ms).toBeLessThan(3000);
        expect(Date.now() - t0).toBeLessThan(25000);
    });

    test('nesting is capped: past the cap a quote or list is plain text, not a deeper element', () => {
        const o = run(`const r = render('> '.repeat(30) + 'deep'); let depth = 0; for (const e of r.made) if (e.tag === 'blockquote') depth += 1; return depth;`);
        expect(o).toBeLessThanOrEqual(9);
        const l = run(`const r = render(Array.from({ length: 30 }, (_, i) => ' '.repeat(i * 2) + '- x').join('\\n')); return r.made.filter((e) => e.tag === 'ul').length;`);
        expect(l).toBeLessThanOrEqual(10);
    });

    test('input past the character cap is cut, not rendered', () => {
        const o = run(`const r = render('a'.repeat(md.LIMITS.chars) + '\\n\\nTAIL'); return r.html.includes('TAIL');`);
        expect(o).toBe(false);
    });
});
