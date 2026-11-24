/**
 * Self-heal for a corrupted WhatsApp app-state (LTHash) collection.
 *
 * Baileys (decodePatches, Utils/chat-utils.js) reacts to an LTHash mismatch by
 * logging a warning, `break`ing out of the patch loop and returning the state it
 * had already advanced (new version + the hash of the mismatching patch). The
 * caller persists that state. Nothing throws, so resyncAppState never forces a
 * snapshot: every later patch starts from a wrong hash and fails the same way,
 * forever, while the stored version keeps advancing. Symptom: read/unread
 * changes made on the phone (regular_low) stop producing `chats.update`.
 *
 * The cure is the one we applied by hand: drop `app-state-sync-version-<name>`
 * so the next resync starts at v0 and asks the server for a full snapshot.
 *
 * A resync from v0 has no minimum version, so Baileys (processSyncAction, not an
 * initial sync) re-emits EVERY record of the snapshot as a live event: stale
 * read/unread markers become chats.update unreadCount 0/-1 "observed now",
 * regular_high replays chats.delete / messages.delete for every chat or message
 * ever deleted. Those replayed chat/message events are dropped (see
 * suppressHealReplay); the state itself is still rebuilt.
 *
 * This module has no Baileys runtime import so it can be unit-tested alone.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const APP_STATE_COLLECTIONS = [
  'critical_block',
  'critical_unblock_low',
  'regular_high',
  'regular_low',
  'regular',
] as const;
export type AppStateCollection = (typeof APP_STATE_COLLECTIONS)[number];

/**
 * The exact Baileys warning for a patch mismatch. The snapshot variant
 * ("LTHash verification failed on snapshot, continuing with partial state") is
 * deliberately NOT matched: a snapshot is already the full resync, so retrying it
 * could only loop.
 */
export const LTHASH_PATCH_FAILURE_MSG = 'LTHash verification failed, skipping remaining patches';

export type LtHashFailure = { name: AppStateCollection; version?: number };

/** Recognises pino-style `warn({ name, version }, msg)` calls carrying the patch failure. */
export function parseLtHashPatchFailure(args: unknown[]): LtHashFailure | null {
  const [obj, msg] = args;
  if (msg !== LTHASH_PATCH_FAILURE_MSG || !obj || typeof obj !== 'object') return null;
  const { name, version } = obj as { name?: unknown; version?: unknown };
  if (typeof name !== 'string' || !(APP_STATE_COLLECTIONS as readonly string[]).includes(name)) return null;
  return { name: name as AppStateCollection, version: typeof version === 'number' ? version : undefined };
}

/**
 * Wraps a pino logger so `warn` calls are inspected before being forwarded
 * untouched. A Proxy (instead of a pino `logMethod` hook) keeps working when the
 * configured level is above `warn`, where pino replaces the method with a no-op
 * and hooks never run. `child()` loggers are wrapped too.
 */
export function watchAppStateFailures<T extends object>(logger: T, onFailure: (failure: LtHashFailure) => void): T {
  return new Proxy(logger, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'warn') {
        return (...args: unknown[]) => {
          try {
            const failure = parseLtHashPatchFailure(args);
            if (failure) onFailure(failure);
          } catch {
            // Detection must never break Baileys' own logging.
          }
          return value.apply(target, args);
        };
      }
      if (prop === 'child') {
        return (...args: unknown[]) => watchAppStateFailures(value.apply(target, args), onFailure);
      }
      return value.bind(target);
    },
    set(target, prop, value) {
      (target as Record<PropertyKey, unknown>)[prop] = value;
      return true;
    },
  });
}

/** Stored LTHash state of a collection (opaque here: only `version` is read, the rest is written back as is). */
export type StoredAppState = { version?: number };

export interface AppStateHealTarget {
  /** True only while the socket is open; the heal never runs otherwise. */
  isOpen(): boolean;
  /** Stored version of the collection, undefined when nothing is stored. */
  readVersion(name: AppStateCollection): Promise<number | undefined>;
  /** Stored state of the collection, undefined when nothing is stored. */
  readState(name: AppStateCollection): Promise<StoredAppState | undefined>;
  /** Removes the stored version (through the socket's key store, so its in-memory cache is cleared too). */
  clearVersion(name: AppStateCollection): Promise<void>;
  /** Puts `state` back only if nothing is stored now; true when it did. */
  restoreIfEmpty(name: AppStateCollection, state: StoredAppState): Promise<boolean>;
  /** Runs Baileys' resyncAppState([name], false). */
  resync(name: AppStateCollection): Promise<void>;
}

/** Structural subset of a Baileys socket, so this file needs no Baileys import. */
export interface AppStateSocketLike {
  authState: {
    creds?: { me?: { id?: string } };
    keys: {
      get(
        type: 'app-state-sync-version',
        ids: string[],
      ): MaybePromise<Record<string, StoredAppState | null | undefined>>;
      set(data: { 'app-state-sync-version'?: Record<string, StoredAppState | null> }): MaybePromise<void>;
      transaction<T>(work: () => Promise<T>, key: string): Promise<T>;
    };
  };
  resyncAppState(collections: AppStateCollection[], isInitialSync: boolean): Promise<void>;
}

type MaybePromise<T> = T | PromiseLike<T>;

/**
 * Bridges the healer to a socket. Clearing goes through the socket's own key
 * store (not Redis directly) so the in-memory makeCacheableSignalKeyStore cache
 * is cleared too, inside a transaction on the same mutex key resyncAppState
 * uses, so it queues behind a sync that is still running.
 */
export function createSocketHealTarget(socket: AppStateSocketLike, isOpen: () => boolean): AppStateHealTarget {
  const { keys, creds } = socket.authState;
  const txKey = () => creds?.me?.id || 'resync-app-state';
  const read = async (name: AppStateCollection) =>
    (await keys.get('app-state-sync-version', [name]))?.[name] ?? undefined;
  return {
    isOpen,
    readVersion: async (name) => (await read(name))?.version,
    readState: read,
    clearVersion: async (name) => {
      await keys.transaction(async () => {
        await keys.set({ 'app-state-sync-version': { [name]: null } });
      }, txKey());
    },
    restoreIfEmpty: (name, state) =>
      keys.transaction(async () => {
        if (await read(name)) return false;
        await keys.set({ 'app-state-sync-version': { [name]: state } });
        return true;
      }, txKey()),
    resync: (name) => socket.resyncAppState([name], false),
  };
}

/**
 * Chat/message events a snapshot replay would re-emit as if they were new.
 * creds.update, contacts, labels and settings are left alone (current state,
 * idempotent for consumers).
 */
export const HEAL_REPLAY_SUPPRESSED_EVENTS: ReadonlySet<string> = new Set([
  'chats.update',
  'chats.delete',
  'chats.lock',
  'messages.update',
  'messages.delete',
]);

type HealReplayScope = { active: boolean; suppressed: number };
const healReplayScope = new AsyncLocalStorage<HealReplayScope>();
const REPLAY_GUARD = Symbol.for('evolution.appStateHealReplayGuard');

type EmitterLike = { emit: (event: any, ...args: any[]) => any };

/**
 * Drops the events listed above when they are emitted from inside a self-heal
 * resync (tracked with AsyncLocalStorage, so live events emitted concurrently by
 * other nodes pass untouched). Install once per socket on `socket.ev`: Baileys'
 * processSyncAction emits through that same object.
 */
export function suppressHealReplay<T extends EmitterLike>(ev: T): T {
  const marked = ev as T & { [REPLAY_GUARD]?: boolean };
  if (marked[REPLAY_GUARD]) return ev;
  const emit = ev.emit;
  ev.emit = function (this: unknown, event: unknown, ...args: unknown[]) {
    const scope = healReplayScope.getStore();
    if (scope?.active && typeof event === 'string' && HEAL_REPLAY_SUPPRESSED_EVENTS.has(event)) {
      scope.suppressed += 1;
      return false;
    }
    return emit.call(this ?? ev, event, ...args);
  } as T['emit'];
  marked[REPLAY_GUARD] = true;
  return ev;
}

/** Runs `work` as a self-heal replay; returns how many events were suppressed. */
export async function runAsHealReplay(work: () => Promise<void>): Promise<number> {
  const scope: HealReplayScope = { active: true, suppressed: 0 };
  try {
    await healReplayScope.run(scope, work);
  } finally {
    // Timers created inside (Baileys' buffer flush) inherit the store; they must not suppress anything.
    scope.active = false;
  }
  return scope.suppressed;
}

type HealLog = { warn: (msg: string) => void; error: (msg: string) => void };

export interface AppStateHealerOptions {
  instanceName: string;
  /** Resolved on every attempt: the socket changes on each reconnect. */
  getTarget: () => AppStateHealTarget | undefined;
  log: HealLog;
  cooldownMs?: number;
  maxAttemptsPerHour?: number;
  pollMs?: number;
  now?: () => number;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * One healer per instance: it only ever acts through that instance's target.
 *
 * Detection happens synchronously inside Baileys' sync transaction, and the
 * failing state is committed when that transaction ends. Healing therefore never
 * runs from the log callback: it is queued and executed later by a poller that
 * is not part of the transaction (a timer started from inside it would inherit
 * its AsyncLocalStorage context and write into an already-closed transaction).
 */
export class AppStateSelfHealer {
  private readonly pending = new Map<AppStateCollection, number | undefined>();
  private readonly attempts = new Map<AppStateCollection, number[]>();
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  private readonly cooldownMs: number;
  private readonly maxAttemptsPerHour: number;
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(private readonly options: AppStateHealerOptions) {
    this.cooldownMs = options.cooldownMs ?? 10 * 60 * 1000;
    this.maxAttemptsPerHour = options.maxAttemptsPerHour ?? 3;
    this.pollMs = options.pollMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  /** Synchronous and side-effect free beyond queueing: safe to call from a logger. */
  report(failure: LtHashFailure): void {
    this.pending.set(failure.name, failure.version);
  }

  get pendingCollections(): AppStateCollection[] {
    return [...this.pending.keys()];
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Processes the queue once. Collections stay queued while the socket is not open. */
  async flush(): Promise<void> {
    if (this.busy || this.pending.size === 0) return;
    const target = this.options.getTarget();
    if (!target || !target.isOpen()) return;

    this.busy = true;
    try {
      for (const [name, reportedVersion] of [...this.pending]) {
        this.pending.delete(name);
        await this.heal(target, name, reportedVersion);
      }
    } finally {
      this.busy = false;
    }
  }

  private async heal(target: AppStateHealTarget, name: AppStateCollection, reportedVersion?: number): Promise<void> {
    const { instanceName, log } = this.options;
    const now = this.now();
    const recent = (this.attempts.get(name) ?? []).filter((at) => now - at < HOUR_MS);
    const last = recent[recent.length - 1];

    if (last !== undefined && now - last < this.cooldownMs) {
      log.warn(
        `app-state self-heal: ${instanceName} ${name} skipped (cooldown, last attempt ${Math.round((now - last) / 1000)}s ago)`,
      );
      this.attempts.set(name, recent);
      return;
    }
    if (recent.length >= this.maxAttemptsPerHour) {
      log.warn(`app-state self-heal: ${instanceName} ${name} skipped (${recent.length} attempts in the last hour)`);
      this.attempts.set(name, recent);
      return;
    }
    recent.push(now);
    this.attempts.set(name, recent);

    let previous: StoredAppState | undefined;
    let cleared = false;
    let failure: string | undefined;
    try {
      previous = await target.readState(name);
      const oldVersion = previous?.version ?? reportedVersion;
      log.warn(`app-state self-heal: ${instanceName} ${name} v${oldVersion ?? '?'} → snapshot`);
      await target.clearVersion(name);
      cleared = true;
      const suppressed = await runAsHealReplay(() => target.resync(name));
      if (suppressed > 0) {
        log.warn(`app-state self-heal: ${instanceName} ${name} suppressed ${suppressed} replayed chat/message events`);
      }
      const newVersion = await target.readVersion(name);
      if (newVersion !== undefined) {
        log.warn(`app-state self-heal: ${instanceName} ${name} OK (snapshot restored at v${newVersion})`);
        return;
      }
      failure = 'no state stored after resync';
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    // Leaving the collection cleared would let the next ordinary resync replay the
    // whole snapshot unguarded; the previous (mismatching) state is the lesser evil.
    let restored = false;
    if (cleared && previous) {
      try {
        restored = await target.restoreIfEmpty(name, previous);
      } catch {
        // reported below as not restored
      }
    }
    log.error(
      `app-state self-heal: ${instanceName} ${name} FAILED (${failure})` +
        (restored ? `; previous state v${previous?.version ?? '?'} restored` : ''),
    );
  }
}
