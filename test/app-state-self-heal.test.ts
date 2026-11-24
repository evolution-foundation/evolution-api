import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';

import {
  AppStateSelfHealer,
  createSocketHealTarget,
  LTHASH_PATCH_FAILURE_MSG,
  parseLtHashPatchFailure,
  runAsHealReplay,
  suppressHealReplay,
  watchAppStateFailures,
  type AppStateCollection,
  type AppStateHealTarget,
} from '../src/api/integrations/channel/whatsapp/app-state-self-heal';

function fakeTarget(
  opts: {
    open?: boolean;
    failResync?: boolean;
    storeNothing?: boolean;
    versions?: Record<string, number | undefined>;
    onResync?: () => void;
  } = {},
) {
  const calls: string[] = [];
  const versions: Record<string, number | undefined> = { regular_low: 108, ...(opts.versions ?? {}) };
  const target: AppStateHealTarget & { open: boolean } = {
    open: opts.open ?? true,
    isOpen() {
      return this.open;
    },
    async readVersion(name) {
      return versions[name];
    },
    async readState(name) {
      return versions[name] === undefined ? undefined : { version: versions[name] };
    },
    async clearVersion(name) {
      calls.push(`clear:${name}`);
      versions[name] = undefined; // keys.set(null)
    },
    async restoreIfEmpty(name, state) {
      if (versions[name] !== undefined) return false;
      calls.push(`restore:${name}:v${state.version}`);
      versions[name] = state.version;
      return true;
    },
    async resync(name) {
      calls.push(`resync:${name}`);
      opts.onResync?.();
      if (opts.failResync) throw new Error('boom');
      if (!opts.storeNothing) versions[name] = 215; // snapshot restored
    },
  };
  return { target, calls, versions };
}

function fakeLog() {
  const lines: string[] = [];
  return { lines, log: { warn: (m: string) => lines.push(`WARN ${m}`), error: (m: string) => lines.push(`ERROR ${m}`) } };
}

function healer(target: AppStateHealTarget | undefined, extra: { now?: () => number; instanceName?: string } = {}) {
  const { lines, log } = fakeLog();
  const h = new AppStateSelfHealer({
    instanceName: extra.instanceName ?? 'Leandro',
    getTarget: () => target,
    log,
    now: extra.now,
  });
  return { h, lines };
}

test('only the patch mismatch warning is recognised (not the snapshot variant, not other collections)', () => {
  assert.deepEqual(parseLtHashPatchFailure([{ name: 'regular_low', version: 105 }, LTHASH_PATCH_FAILURE_MSG]), {
    name: 'regular_low',
    version: 105,
  });
  assert.equal(
    parseLtHashPatchFailure([
      { name: 'regular_low', version: 1 },
      'LTHash verification failed on snapshot, continuing with partial state',
    ]),
    null,
  );
  assert.equal(parseLtHashPatchFailure([{ name: 'bogus', version: 1 }, LTHASH_PATCH_FAILURE_MSG]), null);
  assert.equal(parseLtHashPatchFailure([LTHASH_PATCH_FAILURE_MSG]), null);
});

test('logger proxy reports the warning, still forwards it, and covers child loggers and silenced levels', () => {
  const forwarded: unknown[][] = [];
  const base = {
    level: 'error',
    warn: (...args: unknown[]) => forwarded.push(args),
    info: () => undefined,
    child() {
      return { warn: (...args: unknown[]) => forwarded.push(['child', ...args]) };
    },
  };
  const seen: unknown[] = [];
  const logger = watchAppStateFailures(base, (f) => seen.push(f));

  logger.warn({ name: 'regular_low', version: 106 }, LTHASH_PATCH_FAILURE_MSG);
  logger.warn('unrelated');
  logger.child().warn({ name: 'regular_high', version: 7 }, LTHASH_PATCH_FAILURE_MSG);

  assert.deepEqual(seen, [
    { name: 'regular_low', version: 106 },
    { name: 'regular_high', version: 7 },
  ]);
  assert.equal(forwarded.length, 3);
  assert.equal(logger.level, 'error');
});

test('a failing callback never breaks logging', () => {
  const forwarded: unknown[][] = [];
  const logger = watchAppStateFailures({ warn: (...a: unknown[]) => forwarded.push(a) }, () => {
    throw new Error('x');
  });
  logger.warn({ name: 'regular_low', version: 1 }, LTHASH_PATCH_FAILURE_MSG);
  assert.equal(forwarded.length, 1);
});

test('failure clears the stored version, resyncs that collection only, and logs old version and outcome', async () => {
  const { target, calls } = fakeTarget();
  const { h, lines } = healer(target);
  h.report({ name: 'regular_low', version: 108 });
  await h.flush();

  assert.deepEqual(calls, ['clear:regular_low', 'resync:regular_low']);
  assert.match(lines[0], /^WARN app-state self-heal: Leandro regular_low v108 → snapshot$/);
  assert.match(lines[1], /^WARN app-state self-heal: Leandro regular_low OK \(snapshot restored at v215\)$/);
  assert.deepEqual(h.pendingCollections, []);
});

test('report itself never touches the store (it runs inside Baileys\' sync transaction)', () => {
  const { target, calls } = fakeTarget();
  const { h } = healer(target);
  h.report({ name: 'regular_low', version: 108 });
  assert.deepEqual(calls, []);
  assert.deepEqual(h.pendingCollections, ['regular_low']);
});

test('nothing runs while the socket is not open; the heal stays queued and runs once it opens', async () => {
  const { target, calls } = fakeTarget({ open: false });
  const { h } = healer(target);
  h.report({ name: 'regular_low', version: 108 });
  await h.flush();
  assert.deepEqual(calls, []);
  assert.deepEqual(h.pendingCollections, ['regular_low']);

  target.open = true;
  await h.flush();
  assert.deepEqual(calls, ['clear:regular_low', 'resync:regular_low']);
});

test('no target (no socket yet) is a no-op', async () => {
  const { h } = healer(undefined);
  h.report({ name: 'regular_low', version: 1 });
  await h.flush();
  assert.deepEqual(h.pendingCollections, ['regular_low']);
});

test('cooldown suppresses a second attempt for the same collection, other collections are independent', async () => {
  const { target, calls } = fakeTarget({ versions: { regular_high: 3 } });
  let now = 1_000_000;
  const { h, lines } = healer(target, { now: () => now });

  h.report({ name: 'regular_low', version: 108 });
  await h.flush();
  assert.equal(calls.length, 2);

  now += 60_000; // 1 min later: still inside the 10 min cooldown
  h.report({ name: 'regular_low', version: 109 });
  await h.flush();
  assert.equal(calls.length, 2);
  assert.ok(lines.some((l) => /regular_low skipped \(cooldown/.test(l)));

  h.report({ name: 'regular_high', version: 3 });
  await h.flush();
  assert.deepEqual(calls.slice(2), ['clear:regular_high', 'resync:regular_high']);

  now += 11 * 60_000; // past the cooldown
  h.report({ name: 'regular_low', version: 120 });
  await h.flush();
  assert.deepEqual(calls.slice(4), ['clear:regular_low', 'resync:regular_low']);
});

test('at most 3 attempts per hour per collection', async () => {
  const { target, calls } = fakeTarget();
  let now = 5_000_000;
  const { h, lines } = healer(target, { now: () => now });

  for (let i = 0; i < 3; i++) {
    h.report({ name: 'regular_low', version: i });
    await h.flush();
    now += 11 * 60_000;
  }
  assert.equal(calls.filter((c) => c.startsWith('resync')).length, 3);

  h.report({ name: 'regular_low', version: 99 }); // 4th within the hour
  await h.flush();
  assert.equal(calls.filter((c) => c.startsWith('resync')).length, 3);
  assert.ok(lines.some((l) => /skipped \(3 attempts in the last hour\)/.test(l)));

  now += 60 * 60_000; // window slides
  h.report({ name: 'regular_low', version: 100 });
  await h.flush();
  assert.equal(calls.filter((c) => c.startsWith('resync')).length, 4);
});

test('a failing resync is logged as an error, not thrown, and still counts as an attempt', async () => {
  const { target, calls, versions } = fakeTarget({ failResync: true });
  let now = 1;
  const { h, lines } = healer(target, { now: () => now });
  h.report({ name: 'regular_low', version: 108 });
  await h.flush();
  assert.ok(
    lines.some((l) =>
      /^ERROR app-state self-heal: Leandro regular_low FAILED \(boom\); previous state v108 restored$/.test(l),
    ),
  );
  // Never left cleared: an ordinary resync from v0 would replay the whole snapshot unguarded.
  assert.equal(versions.regular_low, 108);

  now += 1000;
  h.report({ name: 'regular_low', version: 109 });
  await h.flush();
  assert.equal(calls.filter((c) => c.startsWith('resync')).length, 1); // cooldown
});

test('a resync that stores nothing (e.g. collection parked on a missing key) restores the previous state', async () => {
  const { target, calls, versions } = fakeTarget({ storeNothing: true });
  const { h, lines } = healer(target);
  h.report({ name: 'regular_low', version: 108 });
  await h.flush();
  assert.deepEqual(calls, ['clear:regular_low', 'resync:regular_low', 'restore:regular_low:v108']);
  assert.equal(versions.regular_low, 108);
  assert.ok(lines.some((l) => /FAILED \(no state stored after resync\); previous state v108 restored$/.test(l)));
});

test('the previous state is not restored over a state another resync stored meanwhile', async () => {
  const { target, calls, versions } = fakeTarget({ failResync: true });
  target.resync = async (name) => {
    calls.push(`resync:${name}`);
    versions[name] = 300; // an ordinary resync won the mutex and stored a fresh snapshot
    throw new Error('timed out');
  };
  const { h, lines } = healer(target);
  h.report({ name: 'regular_low', version: 108 });
  await h.flush();
  assert.equal(versions.regular_low, 300);
  assert.ok(!calls.some((c) => c.startsWith('restore')));
  assert.ok(lines.some((l) => /FAILED \(timed out\)$/.test(l)));
});

test('replay guard: chat/message events emitted inside a heal resync are dropped, live ones pass', async () => {
  const delivered: string[] = [];
  const ev = suppressHealReplay({
    emit(event: string, data: unknown) {
      delivered.push(`${event}:${JSON.stringify(data)}`);
      return true;
    },
  });
  suppressHealReplay(ev); // idempotent: a second install must not double-wrap

  let timerEmit: Promise<void> | undefined;
  const suppressed = await runAsHealReplay(async () => {
    await Promise.resolve();
    ev.emit('chats.update', [{ id: 'g@g.us', unreadCount: 0 }]); // stale read marker
    ev.emit('chats.delete', ['old@s.whatsapp.net']); // chat deleted months ago
    ev.emit('messages.delete', { keys: [] });
    ev.emit('creds.update', { me: { name: 'x' } }); // not a chat/message replay
    // A timer started inside (Baileys' buffer flush) runs after the heal: not suppressed.
    timerEmit = new Promise((resolve) =>
      setTimeout(() => {
        ev.emit('chats.update', [{ id: 'after@s.whatsapp.net', unreadCount: 1 }]);
        resolve();
      }, 5),
    );
  });
  ev.emit('chats.update', [{ id: 'live@s.whatsapp.net', unreadCount: 0 }]); // outside the heal
  await timerEmit;

  assert.equal(suppressed, 3);
  assert.deepEqual(delivered, [
    'creds.update:{"me":{"name":"x"}}',
    'chats.update:[{"id":"live@s.whatsapp.net","unreadCount":0}]',
    'chats.update:[{"id":"after@s.whatsapp.net","unreadCount":1}]',
  ]);
});

test('replay guard on a real EventEmitter keeps `this` and listeners working', async () => {
  const emitter = new EventEmitter();
  const got: string[] = [];
  emitter.on('chats.update', (d) => got.push(JSON.stringify(d)));
  suppressHealReplay(emitter);
  await runAsHealReplay(async () => {
    emitter.emit('chats.update', [{ id: 'replayed' }]);
  });
  emitter.emit('chats.update', [{ id: 'live' }]);
  assert.deepEqual(got, ['[{"id":"live"}]']);
});

test('heal: replayed events of the snapshot are suppressed and counted in the log', async () => {
  const delivered: string[] = [];
  const ev = suppressHealReplay({ emit: (event: string) => delivered.push(event) > 0 });
  const { target } = fakeTarget({
    onResync: () => {
      ev.emit('chats.update', [{ id: 'a', unreadCount: 0 }]);
      ev.emit('chats.update', [{ id: 'b', unreadCount: -1 }]);
    },
  });
  const { h, lines } = healer(target);
  h.report({ name: 'regular_low', version: 108 });
  await h.flush();
  assert.deepEqual(delivered, []);
  assert.ok(lines.some((l) => /regular_low suppressed 2 replayed chat\/message events$/.test(l)));
  assert.ok(lines.some((l) => /regular_low OK \(snapshot restored at v215\)$/.test(l)));
});

test('healers of two instances are fully independent', async () => {
  const a = fakeTarget();
  const b = fakeTarget();
  const first = healer(a.target, { instanceName: 'Leandro' });
  const second = healer(b.target, { instanceName: 'Outra' });

  first.h.report({ name: 'regular_low', version: 108 });
  await first.h.flush();
  await second.h.flush();

  assert.deepEqual(a.calls, ['clear:regular_low', 'resync:regular_low']);
  assert.deepEqual(b.calls, []);
  assert.equal(second.lines.length, 0);
});

test('proxy + healer: a Baileys warn on the wrapped logger ends in a snapshot resync', async () => {
  const { target, calls } = fakeTarget();
  const { h } = healer(target);
  const logger = watchAppStateFailures({ warn: () => undefined }, (f) => h.report(f));
  logger.warn({ name: 'regular_low' satisfies AppStateCollection, version: 108 }, LTHASH_PATCH_FAILURE_MSG);
  await h.flush();
  assert.deepEqual(calls, ['clear:regular_low', 'resync:regular_low']);
});

test('socket target: version is cleared with null through the key store inside a transaction, then resync([name], false)', async () => {
  const events: string[] = [];
  let inTx = false;
  const socket = {
    authState: {
      creds: { me: { id: '5511999999999:12@s.whatsapp.net' } },
      keys: {
        async get() {
          return { regular_low: { version: 109 } };
        },
        async set(data: unknown) {
          events.push(`set:${JSON.stringify(data)}:tx=${inTx}`);
        },
        async transaction<T>(work: () => Promise<T>, key: string) {
          events.push(`tx:${key}`);
          inTx = true;
          try {
            return await work();
          } finally {
            inTx = false;
          }
        },
      },
    },
    async resyncAppState(collections: unknown, initial: boolean) {
      events.push(`resync:${JSON.stringify(collections)}:${initial}`);
    },
  };
  const target = createSocketHealTarget(socket as never, () => true);
  assert.equal(await target.readVersion('regular_low'), 109);
  await target.clearVersion('regular_low');
  await target.resync('regular_low');
  assert.deepEqual(events, [
    'tx:5511999999999:12@s.whatsapp.net',
    'set:{"app-state-sync-version":{"regular_low":null}}:tx=true',
    'resync:["regular_low"]:false',
  ]);
});

test('socket target: restoreIfEmpty writes back inside the same-key transaction only when nothing is stored', async () => {
  const store: Record<string, unknown> = { regular_low: { version: 109, hash: 'h' } };
  const events: string[] = [];
  const socket = {
    authState: {
      creds: { me: { id: '5511999999999:12@s.whatsapp.net' } },
      keys: {
        async get(_type: string, ids: string[]) {
          return Object.fromEntries(ids.map((id) => [id, store[id] ?? null]));
        },
        async set(data: { 'app-state-sync-version': Record<string, unknown> }) {
          Object.assign(store, data['app-state-sync-version']);
          events.push(`set:${JSON.stringify(data)}`);
        },
        async transaction<T>(work: () => Promise<T>, key: string) {
          events.push(`tx:${key}`);
          return work();
        },
      },
    },
    async resyncAppState() {},
  };
  const target = createSocketHealTarget(socket as never, () => true);
  const previous = await target.readState('regular_low');
  assert.deepEqual(previous, { version: 109, hash: 'h' });

  assert.equal(await target.restoreIfEmpty('regular_low', { version: 1 }), false); // something stored: untouched
  assert.deepEqual(store.regular_low, { version: 109, hash: 'h' });

  await target.clearVersion('regular_low');
  assert.equal(await target.readState('regular_low'), undefined);
  assert.equal(await target.restoreIfEmpty('regular_low', previous!), true);
  assert.deepEqual(store.regular_low, { version: 109, hash: 'h' });
  assert.ok(events.every((e) => !e.startsWith('tx:') || e === 'tx:5511999999999:12@s.whatsapp.net'));
});
