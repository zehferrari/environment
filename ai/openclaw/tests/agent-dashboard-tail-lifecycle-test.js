#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const dashboard = require('../bin/agent-dashboard');

const {
  broadcast,
  clients,
  reconcileSessionTailsWithRegistry,
  startSessionTail,
  stopSessionTail,
  tails,
} = dashboard.__test;

class FakeTail extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.kills = 0;
  }

  kill() {
    this.kills += 1;
    this.emit('exit', null);
  }
}

function createHarness(user) {
  const children = [];
  const timers = new Map();
  let nextTimer = 1;

  const deps = {
    resolveSession: () => ({ file: `/tmp/${user}.jsonl`, format: 'openclaw' }),
    spawnTail: () => {
      const child = new FakeTail();
      children.push(child);
      return child;
    },
    scheduleRestart: (fn) => {
      const id = nextTimer++;
      timers.set(id, fn);
      return id;
    },
    cancelRestart: (id) => timers.delete(id),
    restartDelayMs: 1,
  };

  return {
    children,
    deps,
    timers,
    runTimers() {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
  };
}

// Removing or disabling an agent during a registry reload must tear down both
// its current child and any pending crash restart.
for (const [label, agents] of [
  ['removed', []],
  ['disabled', [{ user: 'placeholder', enabled: false }]],
]) {
  const user = `dashboard-test-registry-${label}`;
  const h = createHarness(user);
  startSessionTail(user, h.deps);
  h.children[0].emit('exit', 1);
  assert.strictEqual(h.timers.size, 1, `${label}: crash restart must be pending`);

  const nextAgents = agents.map(agent => ({ ...agent, user }));
  reconcileSessionTailsWithRegistry({ agents: nextAgents });

  assert.strictEqual(tails[user], undefined, `${label}: tail entry must be removed`);
  assert.strictEqual(h.children[0].kills, 1, `${label}: child must be stopped`);
  assert.strictEqual(h.timers.size, 0, `${label}: restart timer must be cancelled`);
  h.runTimers();
  assert.strictEqual(h.children.length, 1, `${label}: stale timer must not respawn`);
}

// Replacing a healthy tail intentionally kills the old child. That exit must
// not enqueue a delayed restart behind the newly-created replacement.
{
  const user = 'dashboard-test-rotation';
  const h = createHarness(user);
  startSessionTail(user, h.deps);
  const first = h.children[0];
  startSessionTail(user, h.deps);

  assert.strictEqual(first.kills, 1, 'rotation must stop the old child');
  assert.strictEqual(h.children.length, 2, 'rotation must create one replacement');
  assert.strictEqual(h.timers.size, 0, 'intentional child exit must not schedule a restart');
  assert.strictEqual(tails[user].child, h.children[1], 'replacement must remain current');
  stopSessionTail(user);
}

// An unexpected exit gets exactly one delayed restart, even if a broken/mock
// child emits `exit` more than once.
{
  const user = 'dashboard-test-crash';
  const h = createHarness(user);
  startSessionTail(user, h.deps);
  h.children[0].emit('exit', 1);
  h.children[0].emit('exit', 1);

  assert.strictEqual(h.timers.size, 1, 'unexpected exit must enqueue one restart');
  h.runTimers();
  assert.strictEqual(h.children.length, 2, 'restart timer must create one replacement');
  assert.strictEqual(h.timers.size, 0, 'replacement must not inherit another timer');
  stopSessionTail(user);
}

// A rotation while a crash restart is pending cancels the stale timer, so it
// cannot later kill and replace the newer tail.
{
  const user = 'dashboard-test-pending';
  const h = createHarness(user);
  startSessionTail(user, h.deps);
  h.children[0].emit('exit', 1);
  assert.strictEqual(h.timers.size, 1);

  startSessionTail(user, h.deps);
  const replacement = h.children[1];
  assert.strictEqual(h.timers.size, 0, 'rotation must cancel pending crash restart');
  h.runTimers();
  assert.strictEqual(h.children.length, 2, 'cancelled timer must not spawn again');
  assert.strictEqual(tails[user].child, replacement, 'new tail must remain current');
  stopSessionTail(user);
}

// SSE sends each event once per connected client.
{
  const writes = [];
  const client = { write: line => writes.push(line) };
  clients.add(client);
  broadcast({ type: 'test_event', value: 1 });
  clients.delete(client);

  assert.strictEqual(writes.length, 1, 'broadcast must write once per client');
  assert.match(writes[0], /^data: .*"type":"test_event".*\n\n$/);
}

console.log('agent-dashboard tail lifecycle tests passed');
