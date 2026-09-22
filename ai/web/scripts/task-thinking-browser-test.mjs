import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
const { chromium } = await import(process.env.PM_BROWSER_DRIVER || 'playwright-core');
const base = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(base + '/package.json');
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const bundle = await build({ entryPoints: [base + '/scripts/fixtures/task-thinking-browser.jsx'], bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'imports', setup(b) {
  b.onResolve({ filter: /^@\// }, a => { const stem = base + '/' + a.path.slice(2); for (const suffix of ['', '.ts', '.tsx']) if (existsSync(stem + suffix)) return { path: stem + suffix }; });
  b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const useRouter=()=>({replace:()=>{}});export const usePathname=()=>"/task";export const useSearchParams=()=>new URLSearchParams();', loader: 'js' }));
} }] });
let calls = 0, denied = false, progress = 'Checking the report.';
const run = (id, active = true) => ({ id, agentSlug: active ? 'worker' : 'reviewer', agentName: active ? 'Worker' : 'Reviewer', status: active ? 'streaming' : 'completed', provider: 'openai', model: 'fixture', createdAt: active ? '2026-09-22T03:00:00Z' : '2026-09-22T02:00:00Z', thinking: { progress, reasoning: '', tools: [{ id: 'read', name: 'read_file', status: 'start', at: '2026-09-22T03:00:00Z' }], role: active ? 'implementer' : 'reviewer', truncated: false } });
const server = http.createServer((req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); return res.end(bundle.outputFiles[0].contents); }
  if (req.url.startsWith('/api/')) { calls++; res.setHeader('content-type', 'application/json'); res.statusCode = denied ? 404 : 200; return res.end(JSON.stringify(denied ? { error: 'Not found' } : { runs: [run('live'),run('old',false)], nextCursor: null })); }
  res.end('<style>.hidden{display:none}[class*="overflow-y-auto"]{height:300px;overflow-y:auto}details{margin:10px}p{white-space:pre-wrap}</style><div id="root"></div><script src="/bundle.js"></script>');
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PM_BROWSER_BIN || '/usr/bin/chromium', headless: true, args: ['--disable-dev-shm-usage'] });
  const page = await browser.newPage(); const errors = []; page.on('pageerror',e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector('textarea'); assert.equal(calls,0,'hidden tab does not poll');
  await page.click('[role=tab]:last-child');
  await page.waitForFunction(() => document.body.textContent.includes('Checking the report.'));
  assert.equal(await page.$$eval('section > div details', rows => rows.filter(r=>r.querySelector('summary')?.textContent.includes('Worker')).length),1);
  assert.ok(await page.$eval('section',el=>el.textContent.includes('No reasoning summary was supplied')));
  progress = 'Rendering the report.';
  await page.waitForFunction(() => document.body.textContent.includes('Rendering the report.'), null, { timeout: 10000 });
  progress = Array.from({ length: 100 }, (_, i) => `Progress line ${i}`).join('\n');
  await page.waitForFunction(() => document.body.textContent.includes('Progress line 99'), null, { timeout: 10000 });
  await page.$eval('[class*=overflow-y-auto]', el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await page.waitForFunction(() => document.body.textContent.includes('Resume following live activity'));
  progress += '\nAnother update while reading history';
  await page.waitForFunction(() => document.body.textContent.includes('Another update while reading history'), null, { timeout: 10000 });
  assert.equal(await page.$eval('[class*=overflow-y-auto]', el => el.scrollTop), 0, 'new activity must not pull the reader away from earlier output');
  await page.getByRole('button', { name: 'Resume following live activity' }).click();
  await page.waitForFunction(() => { const el = document.querySelector('[class*=overflow-y-auto]'); return el.scrollTop > 100; });
  progress = 'Rendering the report.';
  await page.selectOption('select','reviewer');
  assert.equal(await page.$$eval('section strong',rows=>rows.length),1);
  await page.selectOption('select','all');
  await page.click('[role=tab]:first-child');
  const pausedCalls = calls;
  await new Promise(resolve => setTimeout(resolve,3400)); assert.equal(calls,pausedCalls,'leaving tab stops polling');
  assert.equal(await page.$eval('textarea',el=>el.value),'Unsaved description');
  await page.reload(); await page.click('[role=tab]:last-child');
  await page.waitForFunction(() => document.body.textContent.includes('Rendering the report.'));
  denied = true;
  await page.waitForFunction(() => document.body.textContent.includes('not available to this account'), null, {timeout:10000});
  assert.equal(await page.$$eval('section strong',rows=>rows.length),0,'revoked access clears history');
  assert.deepEqual(errors,[]);
  console.log('PASS real-browser live updates, agent filtering, missing telemetry, tab lifecycle, preserved editor, reload and access revocation');
} finally { if(browser) await browser.close(); await new Promise(resolve=>server.close(resolve)); }
