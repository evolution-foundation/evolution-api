import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test, TestContext } from 'node:test';

import { build } from 'esbuild';
import express from 'express';

// Bundle the production controller and service, replacing only infrastructure boundaries.
const root = resolve(__dirname, '..');
const productionClasses = build({
  stdin: {
    contents: `export { BusinessStartupService } from ${JSON.stringify(process.env.COEX_SERVICE_SOURCE ?? './src/api/integrations/channel/meta/whatsapp.business.service')};
export { MetaController } from ${JSON.stringify(process.env.COEX_CONTROLLER_SOURCE ?? './src/api/integrations/channel/meta/meta.controller')};
export { MetaRouter } from './src/api/integrations/channel/meta/meta.router';
export { EvoHubController } from './src/api/integrations/channel/evohub/evohub.controller';
export { BaseChatbotController } from './src/api/integrations/chatbot/base-chatbot.controller';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  tsconfig: resolve(root, 'tsconfig.json'),
  plugins: [
    {
      name: 'mock-infrastructure',
      setup(builder) {
        const modules = {
          '@api/services/channel.service': `export class ChannelStartupService {
            get instanceId() { return this.instance.id; }
          }`,
          '@api/server.module': `export const chatbotController = {
            emit: async (data) => globalThis.__metaTestEmit(data),
          };
          export const metaController = { receiveWebhook: (data) => globalThis.__metaTestReceive(data) };`,
          '@utils/sendTelemetry': 'export const sendTelemetry = () => {};',
          '@api/integrations/storage/s3/libs/minio.server':
            'export const uploadFile = () => {}; export const getObjectUrl = () => {};',
          '@exceptions':
            'export class InternalServerErrorException extends Error {} export class BadRequestException extends Error {}',
          '@config/logger.config': 'export class Logger { error() {} warn() {} log() {} }',
          '../channel.controller': `export class ChannelController {
            constructor(prismaRepository, waMonitor) { Object.assign(this, { prismaRepository, waMonitor }); }
          }`,
          './chatbot.controller': `export class ChatbotController {
            constructor(prismaRepository, waMonitor) { Object.assign(this, { prismaRepository, waMonitor }); }
          }`,
          '@config/env.config': 'export const configService = { get: () => ({ ENABLE: false }) };',
        };
        builder.onResolve({ filter: /.*/ }, (args) =>
          Object.hasOwn(modules, args.path) ? { path: args.path, namespace: 'test-boundary' } : undefined,
        );
        builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, (args) => ({
          contents: modules[args.path],
          loader: 'js',
        }));
      },
    },
  ],
}).then((result) => {
  const compiled = { exports: {} as any };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(
    createRequire(resolve(root, 'package.json')),
    compiled,
    compiled.exports,
  );
  return compiled.exports;
});

const metadata = { display_phone_number: '15550783881', phone_number_id: '106540352242922' };
const customer = '16505551234';
const customerJid = `${customer}@s.whatsapp.net`;
const message = (id = 'wamid.phone-1', to = customer) => ({
  id,
  from: metadata.display_phone_number,
  to,
  timestamp: '1739321024',
  type: 'text',
  text: { body: 'A colleague replied from the Business app' },
});
const envelope = (value: any, field = 'smb_message_echoes') => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'test-waba', changes: [{ field, value }] }],
});

async function harness(instanceId = 'tenant-a') {
  const { BusinessStartupService, MetaController } = await productionClasses;
  const events: any[] = [];
  const emitted: any[] = [];
  const stored: any[] = [];
  const updates: any[] = [];
  const errors: any[] = [];
  const service = Object.create(BusinessStartupService.prototype);
  Object.assign(service, {
    instance: { id: instanceId, name: instanceId },
    localSettings: {},
    localWebhook: {},
    localChatwoot: {},
    logger: { log() {}, warn() {}, error: (error: any) => errors.push(error) },
    configService: { get: () => ({ ENABLED: false, ENABLE: false, SAVE_DATA: {} }) },
    findSettings: async () => ({}),
    loadChatwoot: async () => {},
    sendDataWebhook: async (event: string, data: any) => events.push({ event, data }),
    prismaRepository: {
      message: {
        create: async ({ data }: any) => {
          stored.push(data);
          return { ...data, id: 'db-id' };
        },
        findFirst: async () => null,
      },
      messageUpdate: { create: async ({ data }: any) => updates.push(data) },
      contact: {
        findFirst: async () => null,
        create: async () => {},
        updateMany: async (query: any) => updates.push(query),
      },
    },
  });
  (globalThis as any).__metaTestEmit = async (data: any) => emitted.push(data);
  const controller = new MetaController(
    {
      instance: {
        findFirst: async ({ where }: any) =>
          where.number === metadata.phone_number_id ? { id: instanceId, name: instanceId } : null,
      },
    },
    { waInstances: { [instanceId]: service } },
  );
  return { service, controller, events, emitted, stored, updates, errors };
}

const appSecret = 'synthetic-test-app-secret';
const signBody = (body: string, secret = appSecret) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

async function routerHarness(t: TestContext, secret = appSecret, captureRaw = true) {
  const h = await harness();
  const { MetaRouter } = await productionClasses;
  let dispatches = 0;
  (globalThis as any).__metaTestReceive = (body: any) => {
    dispatches++;
    return h.controller.receiveWebhook(body);
  };
  const app = express();
  app.use(
    express.json({
      verify: (req: any, _res, buffer) => {
        if (captureRaw) req.rawBody = buffer;
      },
    }),
  );
  app.use(new MetaRouter({ get: () => ({ APP_SECRET: secret, TOKEN_WEBHOOK: 'test-verify-token' }) }).router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/webhook/meta`;
  const post = (body: string, signature?: string) =>
    fetch(url, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        ...(signature === undefined ? {} : { 'X-Hub-Signature-256': signature }),
      },
    });
  return { ...h, url, post, dispatches: () => dispatches };
}

test('the Meta POST route rejects missing, invalid and tampered signatures before dispatch', async (t) => {
  const h = await routerHarness(t);
  const body = JSON.stringify(envelope({ metadata, message_echoes: [message()] }), null, 2);
  for (const signature of [
    undefined,
    '',
    'sha1=' + 'a'.repeat(40),
    'sha256=invalid',
    'sha256=' + 'f'.repeat(64),
    signBody(body, 'wrong-secret'),
  ]) {
    const response = await h.post(body, signature);
    assert.equal(response.status, 401);
    await response.text();
  }
  for (const tampered of [body.replace(customer, '16505550000'), JSON.stringify(JSON.parse(body))]) {
    const response = await h.post(tampered, signBody(body));
    assert.equal(response.status, 401);
    await response.text();
  }
  assert.equal(h.dispatches(), 0);
  assert.equal(h.stored.length, 0);
  assert.equal(h.events.length, 0);
});

test('a valid signature over the original UTF-8 bytes reaches the Meta controller and service', async (t) => {
  const h = await routerHarness(t);
  const body = JSON.stringify(
    envelope({ metadata, message_echoes: [{ ...message(), text: { body: 'Olá 👋' } }] }),
    null,
    2,
  );
  const response = await h.post(body, signBody(body));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'success' });
  assert.equal(h.dispatches(), 1);
  assert.equal(h.stored.length, 1);
  assert.deepEqual(h.emitted[0].msg.key, { id: 'wamid.phone-1', remoteJid: customerJid, fromMe: true });
});

test('the Meta POST route fails closed when its App Secret is missing', async (t) => {
  const h = await routerHarness(t, '');
  const body = JSON.stringify(envelope({ metadata, message_echoes: [message()] }));
  const response = await h.post(body, signBody(body));
  assert.equal(response.status, 503);
  await response.text();
  assert.equal(h.dispatches(), 0);
});

test('the Meta POST route rejects a signature when raw request bytes are unavailable', async (t) => {
  const h = await routerHarness(t, appSecret, false);
  const body = JSON.stringify(envelope({ metadata, message_echoes: [message()] }));
  const response = await h.post(body, signBody(body));
  assert.equal(response.status, 401);
  await response.text();
  assert.equal(h.dispatches(), 0);
});

test('the Meta GET verification handshake still uses the verification token', async (t) => {
  const h = await routerHarness(t, '');
  const response = await fetch(`${h.url}?hub.verify_token=test-verify-token&hub.challenge=12345`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '12345');
  assert.equal(h.dispatches(), 0);
});

test('a Business app echo reaches the agent and webhook as an outgoing message in the customer conversation', async () => {
  const h = await harness();
  await h.service.connectToWhatsapp(envelope({ metadata, message_echoes: [message()] }));
  const upserts = h.events.filter((item) => item.event === 'messages.upsert');
  assert.equal(upserts.length, 1, 'the phone message must reach MESSAGES_UPSERT before the handler resolves');
  assert.deepEqual(upserts[0].data.key, { id: 'wamid.phone-1', remoteJid: customerJid, fromMe: true });
  assert.equal(h.emitted.length, 1, 'the agent must receive the colleague message');
  assert.equal(h.emitted[0].msg.key.fromMe, true);
  assert.equal(h.stored.length, 1);
  assert.deepEqual(h.errors, []);
});

test('the HTTP controller waits for echo delivery before acknowledging it', async () => {
  const h = await harness();
  await h.controller.receiveWebhook(envelope({ metadata, message_echoes: [message()] }));
  assert.equal(h.emitted.length, 1);
  assert.equal(h.stored.length, 1);
});

test('Chatwoot runs before webhook/bot and preserves distinct Chatwoot identifiers', async () => {
  const h = await harness();
  const order: string[] = [];
  h.service.configService.get = (key: string) => ({ ENABLED: key === 'CHATWOOT', ENABLE: false, SAVE_DATA: {} });
  h.service.localChatwoot.enabled = true;
  h.service.chatwootService = {
    eventWhatsapp: async (event: string) => {
      if (event === 'messages.upsert') {
        order.push('chatwoot');
        return { id: 10, inbox_id: 20, conversation_id: 30 };
      }
    },
  };
  h.service.sendDataWebhook = async (event: string, data: any) => {
    if (event === 'messages.upsert') {
      order.push('webhook');
      assert.equal(data.chatwootMessageId, 10);
      assert.equal(data.chatwootInboxId, 20);
      assert.equal(data.chatwootConversationId, 30);
    }
  };
  (globalThis as any).__metaTestEmit = async () => order.push('bot');
  await h.service.connectToWhatsapp(envelope({ metadata, message_echoes: [message()] }));
  assert.deepEqual(order, ['chatwoot', 'webhook', 'bot']);
  assert.deepEqual(h.errors, []);
});

test('classic inbound messages still reach the customer conversation with fromMe false and no contacts', async () => {
  const h = await harness();
  const inbound = { ...message('wamid.customer'), from: customer, to: metadata.display_phone_number };
  await h.service.connectToWhatsapp(envelope({ metadata, messages: [inbound] }, 'messages'));
  assert.equal(h.emitted.length, 1);
  assert.deepEqual(h.emitted[0].msg.key, { id: inbound.id, remoteJid: customerJid, fromMe: false });
  assert.deepEqual(h.errors, []);
});

test('business messages identified by phone_number_id remain outgoing outside echo arrays', async () => {
  const h = await harness();
  const outgoing = { ...message('wamid.business-id'), from: metadata.phone_number_id };
  await h.controller.receiveWebhook(envelope({ metadata, messages: [outgoing] }, 'messages'));
  assert.deepEqual(h.stored[0].key, { id: outgoing.id, remoteJid: customerJid, fromMe: true });
  assert.equal(h.emitted[0].remoteJid, customerJid);
  assert.equal(h.emitted[0].msg.key.fromMe, true);
});

for (const isEcho of [false, true]) {
  test(`${isEcho ? 'echo' : 'inbound'} batches match each customer to its own contact profile`, async () => {
    const h = await harness();
    const secondCustomer = '16505559999';
    const customers = [customer, secondCustomer];
    h.service.prismaRepository.contact.findFirst = async ({ where }: any) => ({
      remoteJid: where.remoteJid,
      pushName: 'Previously saved name',
    });
    const messages = customers.map((number, index) => ({
      ...message(`wamid.profile-${index}`, isEcho ? number : metadata.display_phone_number),
      from: isEcho ? metadata.display_phone_number : number,
    }));
    await h.controller.receiveWebhook(
      envelope({
        metadata,
        contacts: [
          { wa_id: secondCustomer, profile: { name: 'Bob' } },
          { wa_id: metadata.display_phone_number, profile: { name: 'Business' } },
          { wa_id: customer, profile: { name: 'Alice' } },
        ],
        [isEcho ? 'message_echoes' : 'messages']: messages,
      }),
    );
    assert.deepEqual(
      h.stored.map((item) => [item.key.remoteJid, item.pushName]),
      [
        [customerJid, 'Alice'],
        [secondCustomer + '@s.whatsapp.net', 'Bob'],
      ],
    );
    assert.deepEqual(
      h.emitted.map((item) => item.pushName),
      ['Alice', 'Bob'],
    );
    assert.deepEqual(
      h.updates.map((item) => [item.where.remoteJid, item.data.pushName]),
      [
        [customerJid, 'Alice'],
        [secondCustomer + '@s.whatsapp.net', 'Bob'],
      ],
    );
    assert.deepEqual(
      h.events.filter((item) => item.event === 'contacts.update').map((item) => item.data.pushName),
      ['Alice', 'Bob'],
    );
  });
}

test('unmatched contact profiles never replace the saved customer name', async () => {
  const h = await harness();
  h.service.prismaRepository.contact.findFirst = async () => ({ remoteJid: customerJid, pushName: 'Saved customer' });
  await h.controller.receiveWebhook(
    envelope({
      metadata,
      contacts: [{ wa_id: '16505559999', profile: { name: 'Unrelated customer' } }],
      message_echoes: [message()],
    }),
  );
  assert.equal(h.stored[0].pushName, 'Saved customer');
  assert.equal(h.updates[0].data.pushName, 'Saved customer');
});

test('empty messages and message_echoes do not hide the alternate smb_message_echoes array', async () => {
  const h = await harness();
  await h.service.connectToWhatsapp(
    envelope({ metadata, messages: [], message_echoes: [], smb_message_echoes: [message()] }),
  );
  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0].msg.key.fromMe, true);
});

test('every message in an echo batch is delivered with its own recipient', async () => {
  const h = await harness();
  await h.service.connectToWhatsapp(
    envelope({ metadata, message_echoes: [message(), message('wamid.phone-2', '16505559999')] }),
  );
  assert.deepEqual(
    h.emitted.map((item) => item.remoteJid),
    [customerJid, '16505559999@s.whatsapp.net'],
  );
});

test('the controller routes every change to the correct tenant', async () => {
  const { MetaController } = await productionClasses;
  const calls: any[] = [];
  const controller = new MetaController(
    { instance: { findFirst: async ({ where }: any) => ({ name: where.number }) } },
    {
      waInstances: Object.fromEntries(
        ['number-a', 'number-b', 'number-c'].map((name) => [
          name,
          {
            connectToWhatsapp: async (data: any) => calls.push({ name, data }),
          },
        ]),
      ),
    },
  );
  const values = ['number-a', 'number-b', 'number-c'].map((number) => ({
    metadata: { phone_number_id: number },
    message_echoes: [message()],
  }));
  const data = envelope(values[0]);
  data.entry[0].changes.push({ field: 'smb_message_echoes', value: values[1] });
  data.entry.push({ id: 'second-waba', changes: [{ field: 'smb_message_echoes', value: values[2] }] });
  await controller.receiveWebhook(data);
  assert.deepEqual(
    calls.map((item) => item.name),
    ['number-a', 'number-b', 'number-c'],
  );
  assert.equal(calls[1].data.entry[0].changes.length, 1);
  assert.equal(calls[1].data.entry[0].changes[0].value.metadata.phone_number_id, 'number-b');
  assert.equal(calls[2].data.entry.length, 1);
  assert.equal(calls[2].data.entry[0].id, 'second-waba');
});

test('Meta and EvoHub route the same phone number ID only to their own integration', async () => {
  const { MetaController, EvoHubController } = await productionClasses;
  const calls: string[] = [];
  const integrations = ['WHATSAPP-BUSINESS', 'EVOHUB'];
  const repository = {
    instance: {
      findFirst: async ({ where }: any) => {
        assert.equal(where.number, metadata.phone_number_id);
        assert.ok(integrations.includes(where.integration));
        return { name: where.integration };
      },
    },
  };
  const monitor = {
    waInstances: Object.fromEntries(
      integrations.map((name) => [
        name,
        {
          connectToWhatsapp: async () => calls.push(name),
        },
      ]),
    ),
  };
  await new MetaController(repository, monitor).receiveWebhook(envelope({ metadata, message_echoes: [message()] }));
  await new EvoHubController(repository, monitor, {}).receiveWebhook(
    envelope({ metadata, message_echoes: [message()] }),
  );
  assert.deepEqual(calls, integrations);
});

test('the controller rejects unavailable channels and failed processing', async () => {
  const h = await harness();
  h.service.connectToWhatsapp = async () => {
    throw new Error('processing failed');
  };
  const payload = envelope({ metadata, message_echoes: [message()] });
  await assert.rejects(() => h.controller.receiveWebhook(payload), /processing failed/);
  delete h.controller.waMonitor.waInstances['tenant-a'];
  await assert.rejects(() => h.controller.receiveWebhook(payload), /indisponível/);
});

test('contact updates stay within the originating tenant', async () => {
  const h = await harness();
  h.service.prismaRepository.contact.findFirst = async () => ({ remoteJid: customerJid, pushName: 'Customer' });
  await h.service.connectToWhatsapp(envelope({ metadata, message_echoes: [message()] }));
  assert.equal(h.updates.length, 1);
  assert.deepEqual(h.updates[0].where, { instanceId: 'tenant-a', remoteJid: customerJid });
});

test('persistence failure rejects processing so the upstream can retry', async () => {
  const h = await harness();
  h.service.prismaRepository.message.create = async () => {
    throw new Error('database unavailable');
  };
  await assert.rejects(
    () => h.service.connectToWhatsapp(envelope({ metadata, message_echoes: [message()] })),
    /database unavailable/,
  );
});

test('media and stickers sent from the app are emitted and persisted without S3', async () => {
  for (const type of ['audio', 'image', 'video', 'document', 'sticker']) {
    const h = await harness();
    const media = { ...message(`wamid.${type}`), type, [type]: { id: 'synthetic-media', mime_type: `${type}/test` } };
    await h.service.connectToWhatsapp(envelope({ metadata, message_echoes: [media] }));
    assert.equal(h.emitted.length, 1, type);
    assert.equal(h.emitted[0].msg.key.fromMe, true, type);
    assert.equal(h.stored.length, 1, `${type} must be persisted`);
  }
});

test('media already persisted by the S3 path is not inserted again', async () => {
  const h = await harness();
  const mediaRows: any[] = [];
  h.service.configService.get = (key: string) => ({ ENABLE: key === 'S3', ENABLED: false, SAVE_DATA: {} });
  h.service.hasValidMediaContent = () => true;
  h.service.fetchMediaFromGraph = async (id: string) => {
    assert.equal(id, 'synthetic-image');
    return {
      result: { data: { mime_type: 'image/png' }, headers: {} },
      buffer: { data: Buffer.from('synthetic image bytes') },
    };
  };
  h.service.prismaRepository.media = { create: async ({ data }: any) => mediaRows.push(data) };
  const image = { ...message('wamid.image'), type: 'image', image: { id: 'synthetic-image' } };
  await h.service.connectToWhatsapp(envelope({ metadata, message_echoes: [image] }));
  assert.equal(h.stored.length, 1);
  assert.equal(mediaRows.length, 1);
  assert.equal(h.emitted.length, 1);
  assert.deepEqual(h.errors, []);
});

test('concurrent echoes never reuse another customer recipient', async () => {
  const h = await harness();
  h.service.findSettings = async () => {
    await new Promise((done) => setTimeout(done, 5));
    return {};
  };
  await Promise.all([
    h.service.connectToWhatsapp(envelope({ metadata, message_echoes: [message('wamid.a')] })),
    h.service.connectToWhatsapp(envelope({ metadata, message_echoes: [message('wamid.b', '16505559999')] })),
  ]);
  assert.deepEqual(
    h.emitted.map((item) => [item.msg.key.id, item.remoteJid]),
    [
      ['wamid.a', customerJid],
      ['wamid.b', '16505559999@s.whatsapp.net'],
    ],
  );
});

test('co-located inbound and echo arrays preserve distinct message directions', async () => {
  const h = await harness();
  await h.service.connectToWhatsapp(
    envelope({ metadata, messages: [{ ...message('wamid.in'), from: customer }], message_echoes: [message()] }),
  );
  assert.deepEqual(
    h.emitted.map((item) => item.msg.key.fromMe),
    [false, true],
  );
});

test('unknown and deleted status items do not discard later updates and saved direction is retained', async () => {
  const h = await harness();
  h.service.prismaRepository.message.findFirst = async ({ where }: any) =>
    ['wamid.deleted', 'wamid.known'].includes(where.key.equals)
      ? { id: where.key.equals, key: { fromMe: false, remoteJid: customerJid } }
      : null;
  await h.service.connectToWhatsapp(
    envelope(
      {
        metadata,
        statuses: [
          { id: 'wamid.unknown', recipient_id: customer, status: 'delivered' },
          { id: 'wamid.deleted', recipient_id: customer, message: null },
          { id: 'wamid.known', recipient_id: customer, status: 'read' },
        ],
      },
      'messages',
    ),
  );
  assert.deepEqual(
    h.updates.map((item) => item.status),
    ['DELETED', 'READ'],
  );
  assert.equal(h.updates[1].fromMe, false);
  assert.equal(h.updates[1].remoteJid, customerJid);
});

for (const dispatch of ['update webhook', 'delete webhook', 'delete Chatwoot']) {
  async function statusHarness() {
    const h = await harness();
    h.service.prismaRepository.message.findFirst = async () => ({
      id: 'db-status',
      key: { fromMe: true, remoteJid: customerJid },
    });
    h.service.configService.get = (key: string) => ({ ENABLED: key === 'CHATWOOT' });
    h.service.localChatwoot.enabled = true;
    h.service.chatwootService = { eventWhatsapp: async () => {} };
    const status = {
      id: 'wamid.status',
      recipient_id: customer,
      ...(dispatch.startsWith('update') ? { status: 'read' } : { message: null }),
    };
    return { ...h, payload: envelope({ metadata, statuses: [status] }, 'messages') };
  }

  test(`the controller waits for ${dispatch} delivery before acknowledging a status`, async () => {
    const h = await statusHarness();
    let release: () => void;
    let started: () => void;
    const delivery = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const handler = () => {
      started();
      return delivery;
    };
    if (dispatch.endsWith('Chatwoot')) h.service.chatwootService.eventWhatsapp = handler;
    else h.service.sendDataWebhook = handler;
    let acknowledged = false;
    const processing = h.controller.receiveWebhook(h.payload).then(() => {
      acknowledged = true;
    });
    try {
      await entered;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(acknowledged, false);
    } finally {
      release();
      await processing;
    }
    assert.equal(acknowledged, true);
  });

  test(`a rejected ${dispatch} delivery rejects the webhook request`, async () => {
    const h = await statusHarness();
    const handler = () => {
      const failure = Promise.reject(new Error('status delivery failed'));
      // Keep the negative control safe even when the old handler discards this promise.
      void failure.catch(() => {});
      return failure;
    };
    if (dispatch.endsWith('Chatwoot')) h.service.chatwootService.eventWhatsapp = handler;
    else h.service.sendDataWebhook = handler;
    await assert.rejects(() => h.controller.receiveWebhook(h.payload), /status delivery failed/);
  });
}

for (const pause of [false, true]) {
  test(`the native bot ${pause ? 'pauses an active session' : 'ignores the app echo'} without generating a reply`, async () => {
    const h = await harness();
    const { BaseChatbotController } = await productionClasses;
    const bot = Object.create(BaseChatbotController.prototype);
    const responses: any[] = [];
    const pauses: any[] = [];
    Object.assign(bot, {
      integrationEnabled: true,
      integrationName: 'N8n',
      settingsRepository: { findFirst: async () => ({ listeningFromMe: false, stopBotFromMe: pause }) },
      getSession: async () => (pause ? { id: 'session-a', status: 'opened' } : null),
      checkIgnoreJids: () => false,
      findBotTrigger: async () => ({ listeningFromMe: false, stopBotFromMe: pause }),
      processBot: async (...args: any[]) => responses.push(args),
      prismaRepository: { integrationSession: { update: async (query: any) => pauses.push(query) } },
      waMonitor: { waInstances: {} },
      logger: h.service.logger,
    });
    (globalThis as any).__metaTestEmit = (data: any) => bot.emit(data);
    await h.service.connectToWhatsapp(envelope({ metadata, message_echoes: [message()] }));
    assert.equal(responses.length, 0);
    assert.equal(pauses.length, pause ? 1 : 0);
    if (pause) assert.deepEqual(pauses[0], { where: { id: 'session-a' }, data: { status: 'paused' } });
    assert.deepEqual(h.errors, []);
  });
}
