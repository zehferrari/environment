import { runRouteHandler } from '@/scripts/lib/next-route-harness.ts';
import assert from 'node:assert/strict';
import { db } from '@/lib/db.ts';
import { POST } from '@/app/api/work-items/[kind]/[itemId]/save/route.ts';
import { NextRequest } from 'next/server';
async function main() {
    const owner = await db.user.create({ data: { username: 'owner', email: 'owner@editor.invalid', isOwner: true, kind: 'human' } });
    globalThis.editorTestViewer = { id: owner.id, username: 'owner', kind: 'human', role: 'owner', agentVisibility: 'all', canAccessOwnerFeatures: true };
    const project = await db.project.create({ data: { slug: 'editor', name: 'Editor' } });
    const task = await db.task.create({ data: { projectId: project.id, title: 'Original task', reporterId: owner.id } });
    const epic = await db.epic.create({ data: { projectId: project.id, title: 'Original epic', reporterId: owner.id } });
    const save = async (kind, id, values = {}, origin = 'http://localhost') => { const f = new FormData(); f.set(kind + 'Id', id); f.set('projectSlug', 'editor'); f.set('title', 'Saved ' + kind); f.set('description', 'Description ' + kind); for (const [k, v] of Object.entries(values))
        f.set(k, v); return runRouteHandler(() => POST(new NextRequest('http://localhost/api/work-items/' + kind + '/' + id + '/save', { method: 'POST', headers: { origin, host: 'localhost', 'x-pm-editor': '1' }, body: f }), { params: Promise.resolve({ kind, itemId: id }) })); };
    for (const [kind, row] of [['task', task], ['epic', epic]]) {
        const res = await save(kind, row.id);
        assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
        assert.equal((await res.json()).ok, true);
        const stored = await db[kind].findUniqueOrThrow({ where: { id: row.id } });
        assert.equal(stored.title, 'Saved ' + kind);
        assert.equal(stored.description, 'Description ' + kind);
        const noop = await save(kind, row.id);
        assert.equal(noop.status, 200);
        const bad = await save(kind, row.id, { title: '' });
        assert.equal(bad.status, 400);
        assert.match((await bad.json()).error, /Title/);
        assert.equal((await db[kind].findUniqueOrThrow({ where: { id: row.id } })).title, 'Saved ' + kind);
        const csrf = await save(kind, row.id, {}, 'http://evil.invalid');
        assert.equal(csrf.status, 403);
        const mismatch = await save(kind, row.id, { [kind + 'Id']: 'different' });
        assert.equal(mismatch.status, 400);
    }
    const stale = await save('epic', epic.id, { title: 'Must not save', status: 'In Progress', statusRevision: 'outdated' });
    assert.equal(stale.status, 400);
    assert.match((await stale.json()).error, /status changed/);
    assert.equal((await db.epic.findUniqueOrThrow({ where: { id: epic.id } })).title, 'Saved epic');
    globalThis.editorTestViewer = { ...globalThis.editorTestViewer, role: 'member', canAccessOwnerFeatures: false };
    assert.equal((await save('task', task.id, { assigneeId: owner.id })).status, 400);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).assigneeId, null);
    console.log('PASS real Task/Epic save handlers and database writes, repeat/no-op, validation, same-origin and owner-role guards');
}
main().finally(() => db.$disconnect()).catch(e => { console.error(e); process.exitCode = 1; });
