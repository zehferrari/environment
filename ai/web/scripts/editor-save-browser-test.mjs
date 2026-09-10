import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
const { default: puppeteer } = await import(process.env.PM_BROWSER_DRIVER || 'puppeteer-core');
const base = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(base + '/package.json');
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const bundle = await build({ entryPoints: [base + '/scripts/fixtures/editor-save-browser.jsx'], bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'imports', setup(b) { b.onResolve({ filter: /^@\/lib\/projects\/actions$/ }, () => ({ path: 'projects', namespace: 'projects-stub' })); b.onLoad({ filter: /.*/, namespace: 'projects-stub' }, () => ({ contents: 'export const clearDescriptionDraftAction=async()=>{};', loader: 'js' })); b.onResolve({ filter: /^@\/lib\/markdown$/ }, () => ({ path: 'markdown', namespace: 'markdown-stub' })); b.onLoad({ filter: /.*/, namespace: 'markdown-stub' }, () => ({ contents: 'export const renderFullMarkdown=s=>({__html:s});', loader: 'js' })); b.onResolve({ filter: /^@\/components\/avatar-combobox$/ }, () => ({ path: 'avatar', namespace: 'avatar-stub' })); b.onLoad({ filter: /.*/, namespace: 'avatar-stub' }, () => ({ contents: 'export default function Avatar(){return null}', loader: 'js' })); b.onResolve({ filter: /^@\/lib\/agents\/chat\/actions$/ }, () => ({ path: 'chat', namespace: 'chat-stub' })); b.onLoad({ filter: /.*/, namespace: 'chat-stub' }, () => ({ contents: 'export const sendAgentChatMessage=async()=>{};', loader: 'js' })); b.onResolve({ filter: /^@\// }, a => { const stem = base + '/' + a.path.slice(2); for (const suffix of ['', '.ts', '.tsx', '/index.ts', '/index.tsx'])
                if (existsSync(stem + suffix))
                    return { path: stem + suffix }; }); b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const useRouter=()=>({refresh:()=>{window.refreshes++}});', loader: 'js' })); } }] });
let saves = [];
const server = http.createServer(async (req, res) => {
    if (req.url === '/bundle.js') {
        res.setHeader('content-type', 'text/javascript');
        return res.end(bundle.outputFiles[0].contents);
    }
    if (req.method === 'POST') {
        const chunks = [];
        for await (const c of req)
            chunks.push(c);
        const data = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData();
        const values = [...data];
        saves.push({ url: req.url, values });
        const title = data.get('title');
        if (title.startsWith('delay'))
            await new Promise(r => setTimeout(r, 450));
        res.setHeader('content-type', 'application/json');
        if (title === 'fail') {
            res.statusCode = 400;
            return res.end(JSON.stringify({ ok: false, error: 'Validation failed; draft kept.' }));
        }
        return res.end(JSON.stringify({ ok: true }));
    }
    res.end('<div id="root"></div><script src="/bundle.js"></script>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser;
try {
    browser = await puppeteer.launch({ executablePath: process.env.PM_BROWSER_BIN || '/usr/bin/chromium', headless: true, args: ['--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector('#task input[name=title]');
    const set = async (kind, value) => page.$eval('#' + kind + ' input[name=title]', (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
    const save = async (kind) => { await page.click('#' + kind + ' button'); await page.waitForFunction(k => document.querySelector('#' + k + ' button').disabled === false, {}, kind); };
    assert.equal(await page.evaluate(() => isDirty()), false);
    for (const kind of ['task', 'epic']) {
        await set(kind, kind + ' changed');
        assert.equal(await page.evaluate(() => isDirty()), true);
        await save(kind);
        assert.equal(await page.evaluate(() => isDirty()), false);
        await save(kind);
        assert.equal(await page.evaluate(() => isDirty()), false);
        assert.equal(await page.$eval('#' + kind + ' input[name=title]', el => el.value), kind + ' changed');
    }
    assert.ok(saves.every(s => s.values.find(([k]) => k === 'status')[1] === ''), 'unchanged status omitted');
    await page.click('#epic input[value=one]');
    assert.equal(await page.evaluate(() => isDirty()), true);
    await save('epic');
    assert.equal(await page.evaluate(() => isDirty()), false);
    assert.deepEqual(saves.at(-1).values.filter(([k]) => k === 'assigneeId').map(([, v]) => v), ['two']);
    await set('task', 'fail');
    await save('task');
    assert.equal(await page.evaluate(() => isDirty()), true);
    assert.equal(await page.$eval('#task input[name=title]', el => el.value), 'fail');
    assert.match(await page.$eval('#task [role=alert]', el => el.textContent), /Validation failed/);
    let confirms = 0;
    page.on('dialog', async (d) => { confirms++; await d.dismiss(); });
    await page.click('a');
    assert.equal(confirms, 1);
    await set('task', 'delay first');
    await page.click('#task button');
    await set('task', 'newer edit');
    await page.waitForFunction(() => !document.querySelector('#task button').disabled);
    assert.equal(await page.evaluate(() => isDirty()), true);
    assert.match(await page.$eval('#task [role=status]', el => el.textContent), /Newer edits/);
    await save('task');
    assert.equal(await page.evaluate(() => isDirty()), false);
    await page.evaluate(() => { document.querySelector('a').addEventListener('click', e => e.preventDefault()); });
    await page.click('a');
    assert.equal(confirms, 1, 'no stale warning after success');
    await page.click('#task [aria-label="Edit description"]');
    await page.type('#task textarea[name=description]', ' local edit');
    const draft = await page.$eval('#task textarea[name=description]', el => el.value);
    await page.evaluate(() => window.refreshDescriptiontask('another server version'));
    await page.waitForFunction(() => document.querySelector('#task textarea[name=description]').defaultValue.includes('local edit'));
    assert.equal(await page.$eval('#task textarea[name=description]', el => el.value), draft, 'background props preserve local description');
    assert.equal(await page.evaluate(() => isDirty()), true);
    await save('task');
    assert.equal(await page.evaluate(() => isDirty()), false);
    assert.equal(saves.at(-1).values.find(([k]) => k === 'description')[1], draft);
    assert.deepEqual(errors, []);
    console.log('PASS real-browser Task/Epic repeated saves, failed-save draft retention, multi-value fields, newer in-flight edits, status preservation and navigation guard');
}
finally {
    await browser?.close();
    server.close();
}
