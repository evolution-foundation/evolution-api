const assert = require('node:assert/strict');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const axios = require('axios');
const express = require('express');

const filename = join(__dirname, '../src/api/integrations/channel/meta/whatsapp.business.service.ts');
const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
});
const moduleExports = {};
const dependencies = {
  '@api/integrations/storage/s3/libs/minio.server': {},
  '@api/server.module': {},
  '@api/services/channel.service': { ChannelStartupService: class {} },
  '@api/types/wa.types': { Events: { MESSAGES_UPDATE: 'messages.update', MESSAGES_DELETE: 'messages.delete' } },
  '@exceptions': { InternalServerErrorException: Error },
  '@utils/createJid': {},
  '@utils/renderStatus': {},
  '@utils/sendTelemetry': {},
  axios: {},
  'class-validator': {},
  'form-data': {},
  'mime-types': {},
  path: require('node:path'),
};

// Mock infrastructure imports so loading the service does not start application connections.
vm.runInNewContext(
  outputText,
  {
    exports: moduleExports,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  },
  { filename },
);

async function receive(statuses) {
  const events = [];
  const warnings = [];
  const errors = [];
  const forbiddenCalls = [];
  const forbid = (name) => {
    forbiddenCalls.push(name);
    throw new Error(`Unexpected status-processing dependency: ${name}`);
  };
  const service = Object.assign(Object.create(moduleExports.BusinessStartupService.prototype), {
    instanceId: 'instance-under-test',
    phoneNumber: '5511888888888@s.whatsapp.net',
    configService: { get: () => forbid('configService.get') },
    prismaRepository: new Proxy({}, { get: (_, name) => forbid(`prisma.${String(name)}`) }),
    findSettings: () => forbid('findSettings'),
    loadChatwoot: () => forbid('loadChatwoot'),
    logger: {
      log() {},
      warn(value) {
        warnings.push(value);
      },
      error(value) {
        errors.push(value);
      },
    },
    async sendDataWebhook(event, data, local, integration) {
      events.push(JSON.parse(JSON.stringify({ event, data, local, integration })));
    },
  });
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'business-phone-number-id' },
              statuses,
            },
          },
        ],
      },
    ],
  };
  const original = JSON.stringify(payload);

  await service.connectToWhatsapp(payload);

  assert.deepEqual(errors, []);
  assert.deepEqual(forbiddenCalls, [], 'Status forwarding must not depend on database operations');
  assert.equal(JSON.stringify(payload), original, 'The Meta payload must not be mutated');
  return { events, warnings };
}

const failed = {
  id: 'wamid.marketing-message',
  status: 'failed',
  timestamp: '1700000000',
  recipient_id: '5531999999999',
  errors: [
    {
      code: 131049,
      title: 'Meta chose not to deliver',
      error_data: { details: 'This message was not delivered to maintain healthy ecosystem engagement.' },
    },
  ],
};

test('forwards marketing delivery errors with their original message ID and details', async () => {
  const { events, warnings } = await receive([failed]);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'messages.update');
  assert.equal(events[0].local, true);
  assert.deepEqual(events[0].integration, ['webhook']);
  assert.equal(events[0].data.keyId, failed.id);
  assert.equal(events[0].data.status, 'FAILED');
  assert.equal(events[0].data.fromMe, true);
  assert.equal(events[0].data.instanceId, 'instance-under-test');
  assert.equal(events[0].data.remoteJid, '5531999999999@s.whatsapp.net');
  assert.deepEqual(events[0].data.errors, failed.errors);
  assert.ok(warnings.some((warning) => warning.keyId === failed.id && warning.errors?.[0]?.code === 131049));
});

for (const recipient of [undefined, null, '123456789012345@lid', 'business-scoped-user-id']) {
  test(`forwards failures without a usable phone number: ${String(recipient)}`, async () => {
    const { events } = await receive([{ ...failed, recipient_id: recipient }]);
    assert.equal(events.length, 1, 'A known message failure must not be discarded because of its recipient');
    assert.equal(events[0].data.keyId, failed.id);
    assert.equal(events[0].data.status, 'FAILED');
    assert.equal(events[0].data.remoteJid, null);
    assert.equal(events[0].data.participant, null);
    assert.equal(events[0].data.recipient_id, recipient);
    assert.deepEqual(events[0].data.errors, failed.errors);
  });
}

test('keeps valid success notifications unchanged', async () => {
  const statuses = ['sent', 'delivered', 'read'].map((status) => ({
    id: `wamid.${status}`,
    recipient_id: '5511999999999',
    status,
  }));
  const { events } = await receive(statuses);
  assert.deepEqual(
    events.map(({ data }) => data.status),
    ['SENT', 'DELIVERED', 'READ'],
  );
  assert.ok(events.every(({ data }) => data.remoteJid === '5511999999999@s.whatsapp.net'));
});

test('does not lose later failures after an invalid status in the same batch', async () => {
  const { events } = await receive([
    null,
    { status: 'failed', errors: failed.errors },
    { id: 'wamid.invalid', status: 'sent' },
    { ...failed, recipient_id: undefined },
    { ...failed, id: 'wamid.other-message', recipient_id: '15551234567' },
  ]);
  assert.deepEqual(
    events.map(({ data }) => data.keyId),
    [failed.id, 'wamid.other-message'],
  );
});

function loadService(relativePath, mocks, globals = {}) {
  const sourcePath = join(__dirname, '..', relativePath);
  const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const exports = {};
  vm.runInNewContext(
    compiled.outputText,
    {
      exports,
      require(name) {
        assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency in ${relativePath}: ${name}`);
        return mocks[name];
      },
      setTimeout,
      ...globals,
    },
    { filename: sourcePath },
  );
  return exports;
}

const examplePayload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
      changes: [
        {
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: 'PHONE_NUMBER', phone_number_id: 'PHONE_NUMBER_ID' },
            statuses: [
              {
                id: 'wamid.HBgNNTUx...',
                status: 'failed',
                timestamp: '1710000000',
                recipient_id: 'RECIPIENT_PHONE_NUMBER',
                errors: [
                  {
                    code: 131049,
                    title: 'Message undeliverable',
                    message: 'This message was not delivered to maintain healthy ecosystem engagement.',
                    error_data: { details: 'This message was not delivered to maintain healthy ecosystem engagement.' },
                  },
                ],
              },
            ],
          },
          field: 'messages',
        },
      ],
    },
  ],
};

async function receiveOverHttp(t, payload, options = {}) {
  const requests = [];
  const logs = [];
  const queries = [];
  const serverModule = {};
  const monitor = { waInstances: {} };
  const metadata = payload.entry[0].changes[0].value.metadata;
  const instance = {
    id: 'instance-under-test',
    name: 'meta-instance',
    number: options.instanceNumber ?? metadata.phone_number_id,
    token: 'test-token',
    wuid: '5511000000000@s.whatsapp.net',
  };
  let webhookUrl;
  const configService = {
    get(name) {
      const config = {
        SERVER: { URL: 'http://localhost' },
        AUTHENTICATION: { EXPOSE_IN_FETCH_INSTANCES: false },
        LOG: { LEVEL: options.logLevels ?? [] },
        WEBHOOK: {
          GLOBAL: { ENABLED: false, URL: '' },
          RETRY: { MAX_ATTEMPTS: 1 },
          REQUEST: { TIMEOUT_MS: 2000 },
        },
      };
      assert.ok(Object.hasOwn(config, name), `Unexpected configuration lookup: ${name}`);
      return config[name];
    },
  };
  const repository = new Proxy(
    {
      instance: {
        async findMany({ where }) {
          queries.push({ model: 'instance', where: JSON.parse(JSON.stringify(where)) });
          return where.number === instance.number ? [instance] : [];
        },
      },
      webhook: {
        async findUnique({ where }) {
          assert.equal(where.instanceId, instance.id);
          queries.push({ model: 'webhook', where: JSON.parse(JSON.stringify(where)) });
          return { enabled: true, events: ['MESSAGES_UPDATE'], url: webhookUrl };
        },
      },
    },
    {
      get(target, name) {
        assert.ok(Object.hasOwn(target, name), `Unexpected database access: ${String(name)}`);
        return target[name];
      },
    },
  );
  class Logger {
    webhookMeta(value) {
      logs.push({ level: 'WEBHOOKMETA', value });
    }
    log(value) {
      logs.push({ level: 'log', value });
    }
    warn(value) {
      logs.push({ level: 'warn', value });
    }
    error(value) {
      logs.push({ level: 'error', value });
    }
  }
  const { ChannelStartupService } = loadService('src/api/services/channel.service.ts', {
    '@api/integrations/chatbot/chatwoot/services/chatwoot.service': {},
    '@api/integrations/chatbot/dify/services/dify.service': {},
    '@api/integrations/chatbot/openai/services/openai.service': {},
    '@api/integrations/chatbot/typebot/services/typebot.service': {},
    '@api/server.module': serverModule,
    '@api/types/wa.types': dependencies['@api/types/wa.types'],
    '@config/logger.config': { Logger },
    '@exceptions': {},
    '@prisma/client': {},
    '@utils/createJid': {},
    'class-validator': {},
    uuid: {},
  });
  const { EventController } = loadService('src/api/integrations/event/event.controller.ts', {});
  const { WebhookController } = loadService('src/api/integrations/event/webhook/webhook.controller.ts', {
    '@config/env.config': { configService },
    '@config/logger.config': { Logger },
    '../event.controller': { EventController },
    jsonwebtoken: {},
    axios: { create: (config) => axios.create({ ...config, proxy: false }) },
  });
  class InactiveIntegration {
    async emit(event) {
      assert.deepEqual(Array.from(event.integration), ['webhook']);
    }
  }
  const { EventManager } = loadService('src/api/integrations/event/event.manager.ts', {
    '@api/integrations/event/kafka/kafka.controller': { KafkaController: InactiveIntegration },
    '@api/integrations/event/nats/nats.controller': { NatsController: InactiveIntegration },
    '@api/integrations/event/pusher/pusher.controller': { PusherController: InactiveIntegration },
    '@api/integrations/event/rabbitmq/rabbitmq.controller': { RabbitmqController: InactiveIntegration },
    '@api/integrations/event/sqs/sqs.controller': { SqsController: InactiveIntegration },
    '@api/integrations/event/webhook/webhook.controller': { WebhookController },
    '@api/integrations/event/websocket/websocket.controller': { WebsocketController: InactiveIntegration },
  });
  serverModule.eventManager = new EventManager(repository, monitor);
  const service = Object.assign(Object.create(moduleExports.BusinessStartupService.prototype), {
    instance,
    instanceId: instance.id,
    token: instance.token,
    wuid: instance.wuid,
    logger: new Logger(),
    configService,
    prismaRepository: repository,
    sendDataWebhook: ChannelStartupService.prototype.sendDataWebhook,
  });
  monitor.waInstances[instance.name] = service;
  const { ChannelController } = loadService('src/api/integrations/channel/channel.controller.ts', {
    '@api/types/wa.types': {},
    '@exceptions': {},
    './evolution/evolution.channel.service': {},
    './meta/whatsapp.business.service': {},
    './whatsapp/whatsapp.baileys.service': {},
  });
  const { MetaController } = loadService('src/api/integrations/channel/meta/meta.controller.ts', {
    '@config/logger.config': { Logger },
    '../channel.controller': { ChannelController },
    axios,
  });
  serverModule.metaController = new MetaController(repository, monitor);
  const { RouterBroker } = loadService('src/api/abstract/abstract.router.ts', {
    'express-async-errors': require('express-async-errors'),
    '@config/logger.config': { Logger },
    '@exceptions': {},
    jsonschema: {},
  });
  const { MetaRouter } = loadService('src/api/integrations/channel/meta/meta.router.ts', {
    '@api/abstract/abstract.router': { RouterBroker },
    '@api/server.module': serverModule,
    '@config/logger.config': { Logger },
    express,
  });
  const app = express();
  app.use(express.json());
  app.post('/instance-webhook', (req, res) => {
    requests.push(req.body);
    res.status(options.receiverStatus ?? 200).json({ received: true });
  });
  app.use(new MetaRouter(configService).router);
  const server = createServer(app);
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  webhookUrl = `${baseURL}/instance-webhook`;
  const response = await axios.post(`${baseURL}/webhook/meta`, payload, { proxy: false, timeout: 5000 });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { status: 'success' });
  return { requests, logs, queries };
}

test('accepts the exact reported payload and delivers its errors through the HTTP webhook', async (t) => {
  const { requests, logs, queries } = await receiveOverHttp(t, examplePayload);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].event, 'messages.update');
  assert.equal(requests[0].instance, 'meta-instance');
  assert.equal(requests[0].data.status, 'FAILED');
  assert.equal(requests[0].data.keyId, 'wamid.HBgNNTUx...');
  assert.equal(requests[0].data.remoteJid, null);
  assert.deepEqual(requests[0].data.errors, examplePayload.entry[0].changes[0].value.statuses[0].errors);
  assert.deepEqual(
    logs.filter(({ level }) => level === 'error'),
    [],
  );
  assert.deepEqual(
    queries.map(({ model }) => model),
    ['instance', 'webhook'],
  );
});

test('delivers the reported payload with a real phone-number format and preserves its WhatsApp ID', async (t) => {
  const payload = structuredClone(examplePayload);
  payload.entry[0].changes[0].value.statuses[0].recipient_id = '5531999999999';
  const { requests, logs } = await receiveOverHttp(t, payload);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].data.remoteJid, '5531999999999@s.whatsapp.net');
  assert.deepEqual(requests[0].data.errors, payload.entry[0].changes[0].value.statuses[0].errors);
  assert.deepEqual(
    logs.filter(({ level }) => level === 'error'),
    [],
  );
});

test('identifies missing instance routing even when the Meta endpoint acknowledges the payload', async (t) => {
  const { requests, logs } = await receiveOverHttp(t, examplePayload, { instanceNumber: 'ANOTHER_PHONE_NUMBER_ID' });
  assert.equal(requests.length, 0);
  assert.ok(logs.some(({ value }) => String(value).includes('instances not found for numberId: PHONE_NUMBER_ID')));
});

test('records a webhook receiver rejection even when the Meta endpoint acknowledges the payload', async (t) => {
  const { requests, logs } = await receiveOverHttp(t, examplePayload, { receiverStatus: 400 });
  assert.equal(requests.length, 1);
  assert.ok(logs.some(({ level, value }) => level === 'error' && value.statusCode === 400));
});

test('does not log the incoming Meta payload without WEBHOOKMETA', async (t) => {
  const { requests, logs } = await receiveOverHttp(t, examplePayload, { logLevels: ['LOG', 'WEBHOOKS'] });
  assert.equal(requests.length, 1);
  assert.equal(logs.filter(({ level }) => level === 'WEBHOOKMETA').length, 0);
});

test('logs the entire original Meta batch once with WEBHOOKMETA enabled', async (t) => {
  const payload = structuredClone(examplePayload);
  payload.entry.push(structuredClone(payload.entry[0]));
  payload.entry[1].id = 'SECOND_WHATSAPP_BUSINESS_ACCOUNT_ID';
  const { requests, logs } = await receiveOverHttp(t, payload, { logLevels: ['WEBHOOKMETA'] });
  const metaLogs = logs.filter(({ level }) => level === 'WEBHOOKMETA');
  assert.equal(metaLogs.length, 1);
  assert.deepEqual(JSON.parse(metaLogs[0].value), payload);
  assert.equal(requests.length, 2);
  assert.equal(logs[0].level, 'WEBHOOKMETA', 'The original payload must be logged before status processing');
});

test('logs the original Meta payload even when no matching instance exists', async (t) => {
  const { requests, logs } = await receiveOverHttp(t, examplePayload, {
    logLevels: ['WEBHOOKMETA'],
    instanceNumber: 'ANOTHER_PHONE_NUMBER_ID',
  });
  assert.equal(requests.length, 0);
  assert.equal(logs[0].level, 'WEBHOOKMETA');
  assert.deepEqual(JSON.parse(logs[0].value), examplePayload);
  assert.ok(logs.some(({ level }) => level === 'error'));
});

test('logs the original Meta payload before controller object filtering', async (t) => {
  const payload = { ...examplePayload, object: 'unsupported_object' };
  const { requests, logs, queries } = await receiveOverHttp(t, payload, { logLevels: ['WEBHOOKMETA'] });
  assert.equal(requests.length, 0);
  assert.equal(queries.length, 0);
  assert.equal(logs[0].level, 'WEBHOOKMETA');
  assert.deepEqual(JSON.parse(logs[0].value), payload);
});

for (const color of [false, true]) {
  test(`WEBHOOKMETA logger works without LOG and respects its own flag (color: ${color})`, () => {
    const output = [];
    const logConfig = { LEVEL: ['WEBHOOKMETA'], COLOR: color };
    const { Logger } = loadService(
      'src/config/logger.config.ts',
      {
        './env.config': { configService: { get: () => logConfig } },
        dayjs: require('dayjs'),
        fs: { readFileSync: () => JSON.stringify({ version: 'test' }) },
      },
      { process: { pid: 1 }, console: { log: (...args) => output.push(args) } },
    );
    const logger = new Logger('MetaRouter');
    const payload = JSON.stringify(examplePayload);
    logger.webhookMeta(payload);
    logger.log('This level is disabled');
    assert.equal(output.length, 1);
    assert.ok(output[0].includes(payload), 'Nested errors must not be truncated by object inspection');
    assert.ok(output[0].some((part) => part.includes('WEBHOOKMETA')));
    assert.ok(output[0].some((part) => part.includes('[MetaRouter]')));
    assert.ok(output[0].every((part) => !part.includes('undefined')));

    logConfig.LEVEL = ['LOG', 'WEBHOOKS'];
    logger.webhookMeta(payload);
    assert.equal(output.length, 1, 'WEBHOOKMETA must not log when only other levels are enabled');
  });
}
