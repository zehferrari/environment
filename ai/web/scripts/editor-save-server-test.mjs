import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const base = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(base + '/package.json');
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const dir = await mkdtemp(path.join(tmpdir(), 'pm-editor-server-'));
const outfile = path.join(dir, 'test.cjs');
await build({ entryPoints: [path.join(base, 'scripts/fixtures/editor-save-server.mjs')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile, plugins: [{ name: 'test-session', setup(b) { b.onResolve({ filter: /^@\/lib\/auth$/ }, () => ({ path: 'auth', namespace: 'auth-stub' })); b.onLoad({ filter: /.*/, namespace: 'auth-stub' }, () => ({ contents: 'export const auth=async()=>null;', loader: 'ts' })); b.onResolve({ filter: /^@\/lib\/auth\/permissions$/ }, () => ({ path: 'session', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export * from '${base}/lib/auth/permissions.ts';export const requireViewer=async()=>globalThis.editorTestViewer;`, loader: 'ts', resolveDir: base })); b.onResolve({ filter: /^@\// }, a => { const stem = base + '/' + a.path.slice(2); for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx', '.js']) {
                if (existsSync(stem + suffix))
                    return { path: stem + suffix };
            } }); } }] });
const env = { ...process.env, DATABASE_URL: 'file:' + path.join(dir, 'test.db'), APP_URL: 'http://localhost', AUTH_SECRET: 'isolated-editor-test', NODE_PATH: base + '/node_modules', PM_ASYNC_DISPATCH: '1', PM_ASYNC_DISPATCH_INLINE_NUDGE: '0' };
const migrate = spawnSync('pnpm', ['prisma', 'migrate', 'deploy'], { cwd: base, env, encoding: 'utf8' });
if (migrate.status !== 0)
    throw new Error(migrate.stderr || migrate.stdout);
const result = spawnSync(process.execPath, [outfile], { cwd: base, env, encoding: 'utf8', maxBuffer: 2000000 });
console.log(result.stdout);
if (result.status !== 0) {
    console.error(result.stderr, result.error, result.signal, result.status);
    process.exitCode = 1;
}
else
    await rm(dir, { recursive: true, force: true });
