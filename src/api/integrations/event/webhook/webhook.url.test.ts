import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { PrismaRepository } from '@api/repository/repository.service';
import type { WAMonitoringService } from '@api/services/monitor.service';
import type { Prisma } from '@prisma/client';
import { instanceSchema } from '@validate/instance.schema';
import { validate } from 'jsonschema';

import { WebhookController } from './webhook.controller';
import { webhookSchema } from './webhook.schema';

const validUrls = [
  'https://example.com/hook',
  'http://localhost:8080/hook',
  'https://[::1]:8443/hook?token=abc',
  'HTTPS://example.com/hook',
  'hTtPs://example.com/hook',
];

const invalidUrls = [
  '  https://example.com/hook  ',
  'ftp://example.com/hook',
  'https://',
  'https://?token=abc',
  'https://#fragment',
  'https:///hook',
  'https://example.com:invalid/hook',
  'https://[invalid]/hook',
  'https://example.com/hook with spaces',
  'https://example.com/hook\n',
  'https://example.com/hook\r\n',
];

for (const [name, schema] of [
  ['webhook settings', webhookSchema],
  ['instance creation', instanceSchema],
] as const) {
  test(`${name} accepts valid HTTP(S) URLs`, () => {
    for (const url of validUrls) {
      assert.equal(validate({ webhook: { enabled: true, url } }, schema).valid, true, url);
    }
  });

  test(`${name} rejects invalid webhook URLs`, () => {
    for (const url of invalidUrls) {
      assert.equal(validate({ webhook: { enabled: true, url } }, schema).valid, false, JSON.stringify(url));
    }
  });
}

test('instance creation only requires a URL when webhook settings are supplied', () => {
  assert.equal(validate({ instanceName: 'test-instance' }, instanceSchema).valid, true);
  assert.equal(validate({ instanceName: 'test-instance', webhook: {} }, instanceSchema).valid, false);
});

test('controller persists trimmed URLs on both create and update', async () => {
  const upsert = mock.fn(async (args: Prisma.WebhookUpsertArgs) => args.create);
  const prisma = { webhook: { upsert } } as unknown as PrismaRepository;
  const monitor = {
    waInstances: { 'test-instance': { instanceId: 'test-instance-id' } },
  } as unknown as WAMonitoringService;
  const controller = new WebhookController(prisma, monitor);

  await controller.set('test-instance', {
    webhook: { enabled: true, events: [], url: '  HTTPS://example.com/hook  ' },
  });

  assert.equal(upsert.mock.callCount(), 1);
  const persisted = upsert.mock.calls[0].arguments[0];
  assert.equal(persisted.where.instanceId, 'test-instance-id');
  assert.equal(persisted.create.url, 'https://example.com/hook');
  assert.equal(persisted.update.url, 'https://example.com/hook');
});

test('controller rejects malformed URLs before persistence', async () => {
  const upsert = mock.fn();
  const controller = new WebhookController(
    { webhook: { upsert } } as unknown as PrismaRepository,
    {} as WAMonitoringService,
  );

  for (const url of ['https://?', 'https://example.com:invalid/hook', 'https://[invalid]/hook', 'ftp://example.com']) {
    await assert.rejects(controller.set('test-instance', { webhook: { enabled: true, events: [], url } }), {
      status: 400,
      error: 'Bad Request',
      message: ['The "url" must be a valid http or https URL'],
    });
  }
  assert.equal(upsert.mock.callCount(), 0);
});
