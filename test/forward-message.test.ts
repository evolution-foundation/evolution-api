import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import Long from 'long';
import ts from 'typescript';

import { OnWhatsAppDto } from '../src/api/dto/chat.dto';
import { createJid } from '../src/utils/createJid';

// Execute the actual service methods without booting integrations, caches or network clients.
const source = ts.createSourceFile(
  'whatsapp.baileys.service.ts',
  readFileSync('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const service = source.statements.find(
  (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'BaileysStartupService',
)!;
const names = [
  'getMessage',
  'forwardMessage',
  'sendMessage',
  'sendMessageWithTyping',
  'prepareMessage',
  'whatsappNumber',
];
const methods = names.map((name) => {
  const method = service.members.find((node) => node.name?.getText(source) === name);
  assert.ok(method, `production method ${name} exists`);
  return method.getText(source);
});
const code = ts.transpileModule(`class ForwardHarness { ${methods.join('\n')} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

class BadRequestException extends Error {}
const ForwardHarness = new Function(
  'BadRequestException',
  'isJidGroup',
  'Long',
  'getContentType',
  'getDevice',
  'status',
  'Events',
  'createJid',
  'OnWhatsAppDto',
  'getOnWhatsappCache',
  'saveOnWhatsappCache',
  `${code}; return ForwardHarness;`,
)(
  BadRequestException,
  (jid: string) => jid.endsWith('@g.us'),
  Long,
  (message: object) => Object.keys(message)[0],
  () => 'web',
  { 1: 'PENDING', 3: 'DELIVERY_ACK' },
  { SEND_MESSAGE: 'send.message' },
  createJid,
  OnWhatsAppDto,
  async () => [],
  async () => undefined,
);

const pn = '5548991554955@s.whatsapp.net';
const confirmed = '554891554955@s.whatsapp.net';
const group = '120363000000000000@g.us';
const lid = '101679072596057@lid';

function harness(content: object = { conversation: 'Synthetic forwarding QA' }, fail?: string) {
  const calls: Array<{ kind: string; value: any }> = [];
  const original = {
    key: { id: 'source-id', remoteJid: group, fromMe: true },
    message: content,
    messageTimestamp: 1793313205,
  };
  const h = new ForwardHarness();
  Object.assign(h, {
    instanceId: 'instance-a',
    instance: { id: 'instance-a', name: 'QA', wuid: pn },
    logger: { verbose() {}, error() {} },
    localWebhook: { enabled: false },
    configService: {
      get: (key: string) =>
        key === 'DATABASE'
          ? { SAVE_DATA: { NEW_MESSAGE: true } }
          : key === 'CACHE'
            ? { REDIS: { ENABLED: false }, LOCAL: { ENABLED: false } }
            : { ENABLED: false, ENABLE: false },
    },
    prismaRepository: {
      $queryRaw: async (_query: unknown, instanceId: string, id: string) => {
        calls.push({ kind: 'load', value: { instanceId, id } });
        return fail === 'missing' ? [] : [original];
      },
      message: {
        create: async ({ data }: any) => {
          calls.push({ kind: 'persist', value: data });
          if (fail === 'persist') throw new Error('database unavailable');
          return { ...data, id: 'stored-id' };
        },
      },
    },
    whatsappNumber: async ({ numbers }: { numbers: string[] }) => {
      calls.push({ kind: 'resolve', value: numbers });
      const jid = numbers[0].includes('@') ? numbers[0] : confirmed;
      return [{ jid, exists: fail !== 'unknown' }];
    },
    findGroup: async ({ groupJid }: { groupJid: string }) => ({ id: groupJid, participants: [] }),
    deserializeMessageBuffers: (value: unknown) => value,
    client: {
      sendMessage: async (jid: string, envelope: any, options: object) => {
        calls.push({ kind: 'send', value: { jid, envelope, options } });
        if (fail === 'send') throw new Error('delivery uncertain');
        return {
          key: { id: 'forward-id', remoteJid: jid, fromMe: true },
          message: structuredClone(original.message),
          messageTimestamp: Long.fromNumber(1793313206),
          status: 1,
        };
      },
    },
    sendDataWebhook: (event: string, value: unknown) => calls.push({ kind: 'event', value: { event, data: value } }),
  });
  return { h, calls, original };
}

test('PN JID resolves through the normal lookup, then persists and emits the confirmed destination', async () => {
  const { h, calls, original } = harness();
  const result = await h.forwardMessage({ number: pn, messageId: 'source-id' });
  assert.deepEqual(
    calls.map((c) => c.kind),
    ['load', 'resolve', 'send', 'persist', 'event'],
  );
  assert.deepEqual(calls[0].value, { instanceId: 'instance-a', id: 'source-id' });
  assert.deepEqual(calls[1].value, ['5548991554955']);
  assert.equal(calls[2].value.jid, confirmed);
  assert.deepEqual(calls[2].value.envelope, { forward: original, force: true });
  assert.equal(calls[2].value.envelope.forward.message.forward, undefined, 'no second forward envelope');
  assert.equal(result.key.remoteJid, confirmed);
  assert.equal(result.instanceId, 'instance-a');
  assert.equal(result.messageTimestamp, 1793313206);
  assert.deepEqual(calls[3].value, result);
  assert.deepEqual(calls[4].value, { event: 'send.message', data: result });
});

test('actual whatsappNumber uses the provider-confirmed PN instead of the requested ninth-digit JID', async () => {
  const { h, calls } = harness();
  h.whatsappNumber = ForwardHarness.prototype.whatsappNumber;
  h.prismaRepository.contact = { findMany: async () => [] };
  h.client.onWhatsApp = async (...jids: string[]) => {
    calls.push({ kind: 'provider-lookup', value: jids });
    return [{ jid: confirmed, exists: true }];
  };
  const result = await h.forwardMessage({ number: pn, messageId: 'source-id' });
  assert.deepEqual(calls.find((c) => c.kind === 'provider-lookup')!.value, [confirmed]);
  assert.equal(calls.find((c) => c.kind === 'send')!.value.jid, confirmed);
  assert.equal(result.key.remoteJid, confirmed);
});

for (const number of ['5548991554955', group, lid]) {
  test(`normal lookup preserves the input address ${number}`, async () => {
    const { h, calls } = harness();
    await h.forwardMessage({ number, messageId: 'source-id' });
    assert.deepEqual(calls.find((c) => c.kind === 'resolve')!.value, [number]);
    if (number.includes('@')) assert.equal(calls.find((c) => c.kind === 'send')!.value.jid, number);
  });
}

test('native audio forward retains media keys and original context without wrapping or rebuilding media', async () => {
  const media = {
    audioMessage: {
      url: 'https://example.invalid/synthetic-media',
      mediaKey: Buffer.from('synthetic-key'),
      directPath: '/synthetic',
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true,
      contextInfo: { stanzaId: 'quoted-id', forwardingScore: 2, isForwarded: true },
    },
  };
  const { h, calls, original } = harness(media);
  await h.forwardMessage({ number: pn, messageId: 'source-id' });
  const envelope = calls.find((c) => c.kind === 'send')!.value.envelope;
  assert.equal(envelope.forward, original);
  assert.deepEqual(envelope, { forward: original, force: true });
  assert.deepEqual(original.message, media);
  assert.equal(
    'contextInfo' in envelope,
    false,
    'normal direct-message defaults must not override native forward context',
  );
  assert.equal(calls.filter((c) => c.kind === 'persist').length, 1);
  assert.equal(calls.filter((c) => c.kind === 'event').length, 1);
});

for (const failure of ['missing', 'unknown', 'send', 'persist']) {
  test(`${failure} error propagates without retry or false successful event`, async () => {
    const { h, calls } = harness(undefined, failure);
    await assert.rejects(h.forwardMessage({ number: pn, messageId: 'source-id' }), /Error forwarding message/);
    assert.equal(calls.filter((c) => c.kind === 'send').length, failure === 'missing' || failure === 'unknown' ? 0 : 1);
    assert.equal(calls.filter((c) => c.kind === 'event').length, 0);
    assert.equal(calls.filter((c) => c.kind === 'persist').length, failure === 'persist' ? 1 : 0);
  });
}

test('ordinary conversation and audio sends keep their existing envelopes', async () => {
  const { h, calls } = harness();
  await h.sendMessage(confirmed, { conversation: 'plain QA' }, undefined, false, undefined);
  await h.sendMessage(confirmed, { audio: Buffer.from('QA'), ptt: true }, undefined, false, undefined);
  assert.deepEqual(calls[0].value.envelope, {
    text: 'plain QA',
    mentions: undefined,
    linkPreview: false,
    contextInfo: undefined,
  });
  assert.deepEqual(calls[1].value.envelope, { audio: Buffer.from('QA'), ptt: true });
});

test('installed Baileys marks own text/media as forwarded when force=true and preserves media references', async () => {
  const { generateForwardMessageContent } = await import('baileys');
  const text = generateForwardMessageContent(
    { key: { fromMe: true }, message: { conversation: 'Synthetic QA' } },
    true,
  );
  assert.equal(text.extendedTextMessage?.text, 'Synthetic QA');
  assert.equal(text.extendedTextMessage?.contextInfo?.isForwarded, true);
  assert.equal(text.extendedTextMessage?.contextInfo?.forwardingScore, 1);
  const audio = {
    url: 'https://example.invalid/QA',
    mediaKey: Buffer.from('QA'),
    ptt: true,
    contextInfo: { forwardingScore: 2, isForwarded: true },
  };
  const result = generateForwardMessageContent({ key: { fromMe: true }, message: { audioMessage: audio } }, true);
  assert.equal(result.audioMessage?.url, audio.url);
  assert.deepEqual(Buffer.from(result.audioMessage!.mediaKey!), audio.mediaKey);
  assert.equal(result.audioMessage?.contextInfo?.forwardingScore, 3);
  assert.equal(result.audioMessage?.contextInfo?.isForwarded, true);
  assert.equal(audio.contextInfo.forwardingScore, 2, 'source remains unchanged');
});
