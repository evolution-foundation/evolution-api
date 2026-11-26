import assert from 'node:assert/strict';
import test from 'node:test';

import { BaileysStartupService } from '../src/api/integrations/channel/whatsapp/whatsapp.baileys.service';

type SnapshotCollector = {
  observedLabelState: boolean;
  labelsByChatId: Map<string, Set<string>>;
};

type TestableBaileysStartupService = {
  labelAssociationSnapshotCollector?: SnapshotCollector;
  eventProcessingQueue: Promise<void>;
  syncLabels(): Promise<unknown>;
};

function immediateTimeouts() {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => {
    callback(...args);
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  return () => {
    globalThis.setTimeout = original;
  };
}

test('syncLabels replaces stale chat labels with the full app-state snapshot', async () => {
  const updateManyCalls: unknown[] = [];
  const upsertCalls: unknown[] = [];
  const keyWrites: unknown[] = [];
  const transaction = {
    chat: {
      updateMany: async (input: unknown) => updateManyCalls.push(input),
      upsert: async (input: unknown) => upsertCalls.push(input),
    },
  };
  const service = Object.create(BaileysStartupService.prototype) as TestableBaileysStartupService;
  Object.assign(service, {
    instance: {
      id: 'instance-1',
      name: 'test-instance',
      authState: {
        state: {
          keys: {
            set: async (input: unknown) => keyWrites.push(input),
          },
        },
      },
    },
    eventProcessingQueue: Promise.resolve(),
    logger: { warn: () => undefined },
    prismaRepository: {
      label: { findMany: async () => [] },
      $transaction: async (callback: (client: typeof transaction) => Promise<void>) => callback(transaction),
    },
    client: {
      resyncAppState: async () => {
        const collector = service.labelAssociationSnapshotCollector;
        assert.ok(collector, 'syncLabels must collect the forced app-state snapshot');
        collector.observedLabelState = true;
        collector.labelsByChatId.set('chat-1@s.whatsapp.net', new Set(['label-2', 'label-1']));
      },
    },
  });
  const restoreTimeouts = immediateTimeouts();

  try {
    await service.syncLabels();
  } finally {
    restoreTimeouts();
  }

  assert.deepEqual(keyWrites, [{ 'app-state-sync-version': { regular: null } }]);
  assert.deepEqual(updateManyCalls, [
    {
      where: { instanceId: 'instance-1' },
      data: { labels: [] },
    },
  ]);
  assert.equal(upsertCalls.length, 1);
  const [upsert] = upsertCalls as Array<{
    where: unknown;
    update: unknown;
    create: { id: string; instanceId: string; remoteJid: string; labels: string[] };
  }>;
  assert.match(upsert.create.id, /^[a-z0-9]+$/);
  assert.deepEqual(
    {
      ...upsert,
      create: { ...upsert.create, id: '<generated>' },
    },
    {
      where: {
        instanceId_remoteJid: {
          instanceId: 'instance-1',
          remoteJid: 'chat-1@s.whatsapp.net',
        },
      },
      update: { labels: ['label-1', 'label-2'] },
      create: {
        id: '<generated>',
        instanceId: 'instance-1',
        remoteJid: 'chat-1@s.whatsapp.net',
        labels: ['label-1', 'label-2'],
      },
    },
  );
  assert.equal(service.labelAssociationSnapshotCollector, undefined);
});

test('syncLabels keeps existing chat labels when the forced sync returns no label state', async () => {
  let transactionCalls = 0;
  let warnings = 0;
  const service = Object.create(BaileysStartupService.prototype) as TestableBaileysStartupService;
  Object.assign(service, {
    instance: {
      id: 'instance-1',
      name: 'test-instance',
      authState: {
        state: {
          keys: {
            set: async () => undefined,
          },
        },
      },
    },
    eventProcessingQueue: Promise.resolve(),
    logger: { warn: () => warnings++ },
    prismaRepository: {
      label: { findMany: async () => [] },
      $transaction: async () => transactionCalls++,
    },
    client: {
      resyncAppState: async () => undefined,
    },
  });
  const restoreTimeouts = immediateTimeouts();

  try {
    await service.syncLabels();
  } finally {
    restoreTimeouts();
  }

  assert.equal(transactionCalls, 0);
  assert.equal(warnings, 1);
});
