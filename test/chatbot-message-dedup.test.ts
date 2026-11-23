import '@api/server.module';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BaseChatbotController } from '../src/api/integrations/chatbot/base-chatbot.controller';
import { ChatbotMessageDeduplicator } from '../src/api/integrations/chatbot/chatbot-message-dedup';

describe('ChatbotMessageDeduplicator', () => {
  it('suppresses duplicate messageId for the same instance, remoteJid, and integration', async () => {
    const dedup = new ChatbotMessageDeduplicator();
    const params = {
      integrationName: 'Typebot',
      instanceId: 'inst-1',
      remoteJid: '5511999999999@s.whatsapp.net',
      messageId: 'BAE594145F4C59B4',
    };

    assert.equal(await dedup.isDuplicate(params), false);
    assert.equal(await dedup.isDuplicate(params), true);
    assert.equal(await dedup.isDuplicate(params), true);
  });

  it('allows different messageIds for the same instance and remoteJid', async () => {
    const dedup = new ChatbotMessageDeduplicator();
    const base = {
      integrationName: 'Openai',
      instanceId: 'inst-1',
      remoteJid: '5511999999999@s.whatsapp.net',
    };

    assert.equal(await dedup.isDuplicate({ ...base, messageId: 'msg-1' }), false);
    assert.equal(await dedup.isDuplicate({ ...base, messageId: 'msg-2' }), false);
    assert.equal(await dedup.isDuplicate({ ...base, messageId: 'msg-1' }), true);
    assert.equal(await dedup.isDuplicate({ ...base, messageId: 'msg-2' }), true);
  });

  it('allows the same messageId across different instances', async () => {
    const dedup = new ChatbotMessageDeduplicator();
    const base = {
      integrationName: 'Dify',
      remoteJid: '5511999999999@s.whatsapp.net',
      messageId: 'msg-shared',
    };

    assert.equal(await dedup.isDuplicate({ ...base, instanceId: 'inst-1' }), false);
    assert.equal(await dedup.isDuplicate({ ...base, instanceId: 'inst-2' }), false);
    assert.equal(await dedup.isDuplicate({ ...base, instanceId: 'inst-1' }), true);
  });

  it('allows the same messageId across different chatbot integrations', async () => {
    const dedup = new ChatbotMessageDeduplicator();
    const base = {
      instanceId: 'inst-1',
      remoteJid: '5511999999999@s.whatsapp.net',
      messageId: 'msg-1',
    };

    assert.equal(await dedup.isDuplicate({ ...base, integrationName: 'Typebot' }), false);
    assert.equal(await dedup.isDuplicate({ ...base, integrationName: 'Openai' }), false);
  });

  it('allows the same messageId across different remoteJids', async () => {
    const dedup = new ChatbotMessageDeduplicator();
    const base = {
      integrationName: 'N8n',
      instanceId: 'inst-1',
      messageId: 'msg-1',
    };

    assert.equal(await dedup.isDuplicate({ ...base, remoteJid: '5511111111111@s.whatsapp.net' }), false);
    assert.equal(await dedup.isDuplicate({ ...base, remoteJid: '5511222222222@s.whatsapp.net' }), false);
  });

  it('expires entries after TTL so redelivery outside the window is allowed', async () => {
    let currentTime = 1_000;
    const dedup = new ChatbotMessageDeduplicator({
      ttlMs: 1_000,
      now: () => currentTime,
    });
    const params = {
      integrationName: 'Flowise',
      instanceId: 'inst-1',
      remoteJid: '5511999999999@s.whatsapp.net',
      messageId: 'msg-ttl',
    };

    assert.equal(await dedup.isDuplicate(params), false);

    currentTime = 1_500;
    assert.equal(await dedup.isDuplicate(params), true);

    currentTime = 2_000;
    assert.equal(await dedup.isDuplicate(params), false);
  });

  it('bounds in-memory map size and evicts oldest entries when capacity is reached', async () => {
    let currentTime = 1_000;
    const dedup = new ChatbotMessageDeduplicator({
      ttlMs: 60_000,
      maxSize: 3,
      now: () => currentTime,
    });

    const makeParams = (id: string) => ({
      integrationName: 'Evoai',
      instanceId: 'inst-1',
      remoteJid: '5511999999999@s.whatsapp.net',
      messageId: id,
    });

    assert.equal(await dedup.isDuplicate(makeParams('msg-1')), false);
    assert.equal(await dedup.isDuplicate(makeParams('msg-2')), false);
    assert.equal(await dedup.isDuplicate(makeParams('msg-3')), false);
    assert.equal(dedup.size, 3);

    // Inserting msg-4 must evict msg-1 (oldest) to stay bounded at maxSize=3
    assert.equal(await dedup.isDuplicate(makeParams('msg-4')), false);
    assert.equal(dedup.size, 3);

    assert.equal(await dedup.isDuplicate(makeParams('msg-2')), true);
    assert.equal(await dedup.isDuplicate(makeParams('msg-3')), true);
    assert.equal(await dedup.isDuplicate(makeParams('msg-4')), true);

    // msg-1 was evicted so it is treated as new again
    assert.equal(await dedup.isDuplicate(makeParams('msg-1')), false);
    assert.equal(dedup.size, 3);
  });

  it('prunes expired entries before evicting live entries at capacity', async () => {
    let currentTime = 1_000;
    const dedup = new ChatbotMessageDeduplicator({
      ttlMs: 500,
      maxSize: 2,
      now: () => currentTime,
    });

    const makeParams = (id: string) => ({
      integrationName: 'Typebot',
      instanceId: 'inst-1',
      remoteJid: '5511999999999@s.whatsapp.net',
      messageId: id,
    });

    assert.equal(await dedup.isDuplicate(makeParams('expired-1')), false);
    currentTime = 1_400;
    assert.equal(await dedup.isDuplicate(makeParams('live-2')), false);

    // Advance so expired-1 is expired (1600 >= 1500) while live-2 is still valid (1600 < 1900)
    currentTime = 1_600;
    assert.equal(await dedup.isDuplicate(makeParams('new-3')), false);
    assert.equal(dedup.size, 2);
    assert.equal(await dedup.isDuplicate(makeParams('live-2')), true);
  });

  it('never suppresses messages with missing or empty key.id', async () => {
    const dedup = new ChatbotMessageDeduplicator();

    assert.equal(await dedup.isDuplicate({ instanceId: 'inst-1', remoteJid: 'jid', messageId: undefined }), false);
    assert.equal(await dedup.isDuplicate({ instanceId: 'inst-1', remoteJid: 'jid', messageId: '' }), false);
    assert.equal(await dedup.isDuplicate({ instanceId: 'inst-1', remoteJid: 'jid', messageId: null as any }), false);
    assert.equal(dedup.size, 0);
  });

  it('prevents concurrent redelivery race even when async cache is slow', async () => {
    const slowCache = {
      async has() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return false;
      },
      async set() {
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    };

    const dedup = new ChatbotMessageDeduplicator({ cache: slowCache });
    const params = {
      integrationName: 'Typebot',
      instanceId: 'inst-1',
      remoteJid: '5511999999999@s.whatsapp.net',
      messageId: 'concurrent-msg',
    };

    const results = await Promise.all([
      dedup.isDuplicate(params),
      dedup.isDuplicate(params),
      dedup.isDuplicate(params),
    ]);

    assert.deepEqual(results, [false, true, true]);
  });

  it('supports shared cache hit and falls back gracefully when cache is disabled or throws', async () => {
    const remoteHitCache = {
      async has() {
        return true;
      },
      async set() {},
    };
    const dedupRemote = new ChatbotMessageDeduplicator({ cache: remoteHitCache });
    assert.equal(
      await dedupRemote.isDuplicate({
        integrationName: 'Typebot',
        instanceId: 'inst-1',
        remoteJid: 'jid',
        messageId: 'remote-seen',
      }),
      true,
    );

    const warnings: any[] = [];
    const failingCache = {
      async has() {
        throw new Error('Redis connection refused');
      },
      async set() {
        throw new Error('Redis connection refused');
      },
    };

    const dedupFallback = new ChatbotMessageDeduplicator({
      cache: failingCache,
      logger: { warn: (msg) => warnings.push(msg) },
    });
    const params = {
      integrationName: 'Typebot',
      instanceId: 'inst-1',
      remoteJid: 'jid',
      messageId: 'fallback-msg',
    };

    assert.equal(await dedupFallback.isDuplicate(params), false);
    assert.equal(warnings.length, 1);
    assert.equal(await dedupFallback.isDuplicate(params), true);
  });

  it('release() removes the in-memory claim and deletes from shared cache so redelivery is allowed', async () => {
    const store = new Map<string, boolean>();
    const cache = {
      async has(key: string) {
        return store.has(key);
      },
      async set(key: string, value: boolean) {
        store.set(key, value);
      },
      async delete(key: string) {
        store.delete(key);
      },
    };

    const dedup = new ChatbotMessageDeduplicator({ cache });
    const params = {
      integrationName: 'Typebot',
      instanceId: 'inst-1',
      remoteJid: '5511999999999@s.whatsapp.net',
      messageId: 'retry-msg',
    };

    assert.equal(await dedup.isDuplicate(params), false);
    assert.equal(dedup.size, 1);
    assert.equal(store.size, 1);

    // Duplicate before release is suppressed
    assert.equal(await dedup.isDuplicate(params), true);

    // Release clears both in-memory and shared cache entries
    await dedup.release(params);
    assert.equal(dedup.size, 0);
    assert.equal(store.size, 0);

    // Redelivery after release is allowed
    assert.equal(await dedup.isDuplicate(params), false);
  });

  it('release() handles cache.delete errors and missing messageId gracefully', async () => {
    const warnings: unknown[] = [];
    const dedup = new ChatbotMessageDeduplicator({
      cache: {
        async has() {
          return false;
        },
        async set() {},
        async delete() {
          throw new Error('Redis delete failed');
        },
      },
      logger: { warn: (msg) => warnings.push(msg) },
    });

    const params = {
      integrationName: 'Typebot',
      instanceId: 'inst-1',
      remoteJid: 'jid',
      messageId: 'err-release',
    };

    assert.equal(await dedup.isDuplicate(params), false);
    await dedup.release(params);
    assert.equal(dedup.size, 0);
    assert.equal(warnings.length, 1);
    // In-memory entry was removed despite cache.delete failure
    assert.equal(await dedup.isDuplicate(params), false);

    // Missing messageId is a safe no-op
    await dedup.release({ instanceId: 'inst-1', remoteJid: 'jid', messageId: undefined });
  });
});

describe('BaseChatbotController.emit deduplication integration', () => {
  class TestChatbotController extends BaseChatbotController {
    protected readonly integrationName = 'TestBot';
    public processBotCalls = 0;
    public settingsLookups = 0;

    constructor() {
      const mockPrismaRepository = {
        integrationSession: {
          findFirst: async () => ({
            id: 'session-1',
            botId: 'bot-1',
            status: 'opened',
          }),
        },
      } as any;

      const mockWaMonitor = {
        waInstances: {
          'test-instance': {},
        },
      } as any;

      super(mockPrismaRepository, mockWaMonitor);

      this.integrationEnabled = true;
      this.settingsRepository = {
        findFirst: async () => {
          this.settingsLookups += 1;
          return {
            expire: 0,
            keywordFinish: '',
            delayMessage: 0,
            unknownMessage: '',
            listeningFromMe: false,
            stopBotFromMe: false,
            keepOpen: false,
            debounceTime: 0,
            ignoreJids: [],
            splitMessages: false,
            timePerChar: 0,
          };
        },
      };
      this.botRepository = {
        findFirst: async () => ({
          id: 'bot-1',
          enabled: true,
        }),
      };
    }

    protected async processBot(): Promise<void> {
      this.processBotCalls += 1;
    }

    protected getFallbackBotId(): string | undefined {
      return undefined;
    }
  }

  it('invokes settings lookup and processBot only once when emit() is called twice with the same msg.key.id', async () => {
    const controller = new TestChatbotController();
    const instance = { instanceId: 'inst-1', instanceName: 'test-instance' } as any;
    const remoteJid = '5511999999999@s.whatsapp.net';
    const msg = {
      key: {
        id: 'BAE594145F4C59B4',
        remoteJid,
        fromMe: false,
      },
      message: {
        conversation: 'hello',
      },
    };

    await controller.emit({ instance, remoteJid, msg });
    await controller.emit({ instance, remoteJid, msg });

    assert.equal(controller.settingsLookups, 1);
    assert.equal(controller.processBotCalls, 1);

    // A distinct msg.key.id is processed normally
    await controller.emit({
      instance,
      remoteJid,
      msg: {
        ...msg,
        key: { ...msg.key, id: 'BAE594145F4C59B5' },
      },
    });

    assert.equal(controller.settingsLookups, 2);
    assert.equal(controller.processBotCalls, 2);
  });

  it('releases deduplication claim when processBot throws so a subsequent retry succeeds', async () => {
    class FlakyProcessBotController extends TestChatbotController {
      public shouldFail = true;

      protected override async processBot(): Promise<void> {
        this.processBotCalls += 1;
        if (this.shouldFail) {
          throw new Error('Downstream bot error');
        }
      }
    }

    const controller = new FlakyProcessBotController();
    const instance = { instanceId: 'inst-1', instanceName: 'test-instance' } as any;
    const remoteJid = '5511999999999@s.whatsapp.net';
    const msg = {
      key: {
        id: 'BAE594145F4C59B6',
        remoteJid,
        fromMe: false,
      },
      message: {
        conversation: 'hello',
      },
    };

    // First delivery fails in processBot -> claim is released
    await controller.emit({ instance, remoteJid, msg });
    assert.equal(controller.processBotCalls, 1);

    // Retry succeeds because the claim was released
    controller.shouldFail = false;
    await controller.emit({ instance, remoteJid, msg });
    assert.equal(controller.processBotCalls, 2);

    // Subsequent duplicate after success is suppressed
    await controller.emit({ instance, remoteJid, msg });
    assert.equal(controller.processBotCalls, 2);
  });

  it('releases deduplication claim when settingsRepository throws so a subsequent retry succeeds', async () => {
    const controller = new TestChatbotController();
    let shouldFailSettings = true;
    const originalFindFirst = controller.settingsRepository.findFirst;
    controller.settingsRepository = {
      findFirst: async () => {
        if (shouldFailSettings) {
          controller.settingsLookups += 1;
          throw new Error('DB connection lost');
        }
        return originalFindFirst();
      },
    };

    const instance = { instanceId: 'inst-1', instanceName: 'test-instance' } as any;
    const remoteJid = '5511999999999@s.whatsapp.net';
    const msg = {
      key: {
        id: 'BAE594145F4C59B7',
        remoteJid,
        fromMe: false,
      },
      message: {
        conversation: 'hello',
      },
    };

    // First delivery fails in settingsRepository -> claim is released
    await controller.emit({ instance, remoteJid, msg });
    assert.equal(controller.settingsLookups, 1);
    assert.equal(controller.processBotCalls, 0);

    // Retry succeeds
    shouldFailSettings = false;
    await controller.emit({ instance, remoteJid, msg });
    assert.equal(controller.settingsLookups, 2);
    assert.equal(controller.processBotCalls, 1);

    // Subsequent duplicate after success is suppressed
    await controller.emit({ instance, remoteJid, msg });
    assert.equal(controller.settingsLookups, 2);
    assert.equal(controller.processBotCalls, 1);
  });
});
