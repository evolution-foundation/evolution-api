import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReadMessageDto } from '../src/api/dto/chat.dto';
import {
  buildGroupReadSelfPayload,
  chatReadStateUpdates,
  collectGroupReadSelf,
  normalizeAccountJid,
  ownAccountJids,
  pickLatestMessageId,
  fillRemoteJidAlt,
  ReadStateValidationError,
  readRequestToChatAddressing,
  resolveReadStateLids,
  toChatAddressingJid,
  syncMessageReadState,
} from '../src/api/integrations/channel/whatsapp/read-state';
import { readMessageSchema } from '../src/validate/chat.schema';
import { Validator } from 'jsonschema';

const jid = '5511999999999@s.whatsapp.net';
const otherJid = '5511888888888@s.whatsapp.net';
const lastMessage = { key: { remoteJid: jid, fromMe: true, id: 'outbound-1' }, messageTimestamp: 1_790_000_000 };
const receipt = { remoteJid: jid, fromMe: false, id: 'inbound-1' };

function mockClient(options: { failModify?: boolean; failReceipts?: boolean } = {}) {
  const calls: Array<{ command: string; payload: unknown; jid?: string }> = [];
  const client = {
    async chatModify(payload: unknown, chatJid: string) {
      calls.push({ command: 'chatModify', payload, jid: chatJid });
      if (options.failModify) throw new Error('modify failed');
    },
    async readMessages(keys: unknown) {
      calls.push({ command: 'readMessages', payload: keys });
      if (options.failReceipts) throw new Error('receipts failed');
    },
  } as Parameters<typeof syncMessageReadState>[0];
  return { client, calls };
}

test('legacy readMessages sends receipts without modifying chat state', async () => {
  const { client, calls } = mockClient();
  const result = await syncMessageReadState(client, { readMessages: [receipt] });
  assert.deepEqual(result, { message: 'Read messages', read: 'success' });
  assert.deepEqual(calls, [{ command: 'readMessages', payload: [receipt] }]);
});

test('lastMessage synchronizes linked-device read state and sends inbound receipts', async () => {
  const { client, calls } = mockClient();
  await syncMessageReadState(client, { readMessages: [receipt], lastMessage });
  assert.deepEqual(calls, [
    { command: 'chatModify', payload: { markRead: true, lastMessages: [lastMessage] }, jid },
    { command: 'readMessages', payload: [receipt] },
  ]);
});

test('outbound lastMessage can clear a manually unread chat without inbound receipts', async () => {
  const { client, calls } = mockClient();
  await syncMessageReadState(client, { readMessages: [], lastMessage });
  assert.deepEqual(calls, [{ command: 'chatModify', payload: { markRead: true, lastMessages: [lastMessage] }, jid }]);
});

test('mixed chats and missing timestamps fail before SDK effects', async () => {
  const { client, calls } = mockClient();
  await assert.rejects(
    syncMessageReadState(client, { readMessages: [{ ...receipt, remoteJid: otherJid }], lastMessage }),
    ReadStateValidationError,
  );
  await assert.rejects(
    syncMessageReadState(client, { readMessages: [receipt], lastMessage: { key: lastMessage.key } } as ReadMessageDto),
    ReadStateValidationError,
  );
  assert.deepEqual(calls, []);
});

test('request schema requires an epoch-seconds timestamp and allows empty receipts only with lastMessage', () => {
  const validator = new Validator();
  const valid = (value: unknown) => validator.validate(value, readMessageSchema).valid;
  assert.equal(valid({ readMessages: [receipt] }), true);
  assert.equal(valid({ readMessages: [], lastMessage }), true);
  assert.equal(valid({ readMessages: [] }), false);
  assert.equal(valid({ readMessages: [receipt], lastMessage: { key: lastMessage.key } }), false);
  assert.equal(valid({ readMessages: [receipt], lastMessage: { ...lastMessage, messageTimestamp: 0 } }), false);
});

test('LID chats are accepted by the same JID suffix contract', async () => {
  const lid = '123456789@lid';
  const { client, calls } = mockClient();
  await syncMessageReadState(client, {
    readMessages: [{ remoteJid: lid, fromMe: false, id: 'lid-inbound' }],
    lastMessage: { key: { remoteJid: lid, fromMe: false, id: 'lid-inbound' }, messageTimestamp: 1_790_000_001 },
  });
  assert.equal(calls[0].command, 'chatModify');
  assert.equal(calls[0].jid, lid);
  assert.equal(calls[1].command, 'readMessages');
});

test('partial SDK failure never reports success', async () => {
  const modify = mockClient({ failModify: true });
  await assert.rejects(syncMessageReadState(modify.client, { readMessages: [receipt], lastMessage }), /modify failed/);
  assert.deepEqual(modify.calls.map((call) => call.command), ['chatModify']);

  const receipts = mockClient({ failReceipts: true });
  await assert.rejects(syncMessageReadState(receipts.client, { readMessages: [receipt], lastMessage }), /receipts failed/);
  assert.deepEqual(receipts.calls.map((call) => call.command), ['chatModify', 'readMessages']);
});

test('chats.update retains zero, manual-unread marker, and positive delta with observation time', () => {
  const observedAt = '2026-09-28T12:34:56.000Z';
  const updates = chatReadStateUpdates(
    [
      { id: jid, unreadCount: 0 },
      { id: otherJid, unreadCount: -1 },
      { id: '123@g.us', unreadCount: 3 },
      { id: '456@g.us', unreadCount: 1.5 },
    ],
    'instance-1',
    observedAt,
  );
  assert.deepEqual(updates, [
    { remoteJid: jid, instanceId: 'instance-1', readStateObservedAt: observedAt, unreadCount: 0 },
    { remoteJid: otherJid, instanceId: 'instance-1', readStateObservedAt: observedAt, unreadCount: -1 },
    { remoteJid: '123@g.us', instanceId: 'instance-1', readStateObservedAt: observedAt, unreadCount: 3 },
    { remoteJid: '456@g.us', instanceId: 'instance-1', readStateObservedAt: observedAt },
  ]);
});

test('chats.update keyed by LID is re-keyed to the phone JID, keeping the LID', async () => {
  const observedAt = '2026-10-08T12:00:00.000Z';
  const resolved = await resolveReadStateLids(
    chatReadStateUpdates(
      [
        { id: '123456789012345@lid', unreadCount: 0 },
        { id: '999999999999999@lid', unreadCount: -1 },
        { id: '888888888888888@lid', unreadCount: 0 },
        { id: jid, unreadCount: 0 },
      ],
      'instance-1',
      observedAt,
    ),
    async (lid) => {
      if (lid === '123456789012345@lid') return '5548991554955:12@s.whatsapp.net';
      if (lid === '888888888888888@lid') throw new Error('mapping store down');
      return null;
    },
  );
  assert.deepEqual(resolved, [
    {
      remoteJid: '5548991554955@s.whatsapp.net',
      lid: '123456789012345@lid',
      instanceId: 'instance-1',
      readStateObservedAt: observedAt,
      unreadCount: 0,
    },
    { remoteJid: '999999999999999@lid', instanceId: 'instance-1', readStateObservedAt: observedAt, unreadCount: -1 },
    { remoteJid: '888888888888888@lid', instanceId: 'instance-1', readStateObservedAt: observedAt, unreadCount: 0 },
    { remoteJid: jid, instanceId: 'instance-1', readStateObservedAt: observedAt, unreadCount: 0 },
  ]);
});

test('commands from webhook consumers are re-addressed to the LID the phone uses', async () => {
  const resolveLid = async (pn: string) => (pn === jid ? '55761694654630:3@lid' : null);
  assert.equal(await toChatAddressingJid(jid, resolveLid), '55761694654630@lid');
  assert.equal(await toChatAddressingJid(otherJid, resolveLid), otherJid);
  assert.equal(await toChatAddressingJid('123@g.us', resolveLid), '123@g.us');
  assert.equal(await toChatAddressingJid(jid, async () => { throw new Error('down'); }), jid);

  const addressed = await readRequestToChatAddressing(
    { readMessages: [receipt], lastMessage } as unknown as ReadMessageDto,
    resolveLid,
  );
  assert.equal(addressed.readMessages[0].remoteJid, '55761694654630@lid');
  assert.equal(addressed.lastMessage?.key.remoteJid, '55761694654630@lid');
  assert.equal(addressed.lastMessage?.key.id, 'outbound-1');
  const { client, calls } = mockClient();
  await syncMessageReadState(client, addressed);
  assert.equal(calls[0].jid, '55761694654630@lid');
});

test('LID-only message keys get the phone JID from the LID mapping', async () => {
  const resolve = async (lid: string) => (lid === '202860566425607@lid' ? '5511964242104:0@s.whatsapp.net' : null);
  const known = { remoteJid: '202860566425607@lid' } as { remoteJid: string; remoteJidAlt?: string };
  await fillRemoteJidAlt(known, resolve);
  assert.equal(known.remoteJidAlt, '5511964242104@s.whatsapp.net');

  const unknown = { remoteJid: '999999999999999@lid' } as { remoteJid: string; remoteJidAlt?: string };
  await fillRemoteJidAlt(unknown, resolve);
  assert.equal(unknown.remoteJidAlt, undefined);

  const already = { remoteJid: '202860566425607@lid', remoteJidAlt: '5500000000000@s.whatsapp.net' };
  await fillRemoteJidAlt(already, resolve);
  assert.equal(already.remoteJidAlt, '5500000000000@s.whatsapp.net');

  const phone = { remoteJid: jid } as { remoteJid: string; remoteJidAlt?: string };
  await fillRemoteJidAlt(phone, resolve);
  assert.equal(phone.remoteJidAlt, undefined);

  const failing = { remoteJid: '202860566425607@lid' } as { remoteJid: string; remoteJidAlt?: string };
  await fillRemoteJidAlt(failing, async () => { throw new Error('down'); });
  assert.equal(failing.remoteJidAlt, undefined);
});

const groupJid = '120363295648424210@g.us';
const senderJid = '5511977777777@s.whatsapp.net';
const groupReceipt = { remoteJid: groupJid, fromMe: false, id: 'group-inbound-1', participant: senderJid };
const groupLastMessage = { key: groupReceipt, messageTimestamp: 1_790_000_100 };

test('group receipts carry the participant through to the SDK', async () => {
  const { client, calls } = mockClient();
  await syncMessageReadState(client, { readMessages: [groupReceipt], lastMessage: groupLastMessage });
  assert.deepEqual(calls[0], { command: 'chatModify', payload: { markRead: true, lastMessages: [groupLastMessage] }, jid: groupJid });
  assert.deepEqual(calls[1], { command: 'readMessages', payload: [groupReceipt] });
});

test('a group key without participant fails before any SDK effect', async () => {
  const { client, calls } = mockClient();
  const { participant: _ignored, ...noParticipant } = groupReceipt;
  await assert.rejects(
    syncMessageReadState(client, { readMessages: [noParticipant], lastMessage: groupLastMessage }),
    ReadStateValidationError,
  );
  await assert.rejects(
    syncMessageReadState(client, {
      readMessages: [groupReceipt],
      lastMessage: { key: noParticipant, messageTimestamp: groupLastMessage.messageTimestamp },
    }),
    ReadStateValidationError,
  );
  await assert.rejects(
    syncMessageReadState(client, {
      readMessages: [{ ...groupReceipt, participant: '   ' }],
      lastMessage: groupLastMessage,
    }),
    ReadStateValidationError,
  );
  assert.deepEqual(calls, []);
});

test('our own group message needs no participant', async () => {
  const { client, calls } = mockClient();
  const mine = { key: { remoteJid: groupJid, fromMe: true, id: 'group-outbound-1' }, messageTimestamp: 1_790_000_101 };
  await syncMessageReadState(client, { readMessages: [], lastMessage: mine });
  assert.deepEqual(calls, [{ command: 'chatModify', payload: { markRead: true, lastMessages: [mine] }, jid: groupJid }]);
});

test('group addressing is left alone: only phone JIDs are mapped to LID', async () => {
  const addressed = await readRequestToChatAddressing(
    { readMessages: [groupReceipt], lastMessage: groupLastMessage },
    async () => '999999999999@lid',
  );
  assert.equal(addressed.readMessages[0].remoteJid, groupJid);
  assert.equal(addressed.readMessages[0].participant, senderJid);
  assert.equal(addressed.lastMessage?.key.remoteJid, groupJid);
});

test('request schema accepts the participant on both keys', () => {
  const validator = new Validator();
  const valid = (value: unknown) => validator.validate(value, readMessageSchema).valid;
  assert.equal(valid({ readMessages: [groupReceipt], lastMessage: groupLastMessage }), true);
  assert.equal(valid({ readMessages: [{ ...groupReceipt, participant: '' }] }), false);
});

test('a legacy receipts-only group request is not forced to carry the participant', async () => {
  const { client, calls } = mockClient();
  const { participant: _ignored, ...noParticipant } = groupReceipt;
  await syncMessageReadState(client, { readMessages: [noParticipant] });
  assert.deepEqual(calls, [{ command: 'readMessages', payload: [noParticipant] }]);
});

test('participant is preserved for group read receipts and omitted when absent', async () => {
  const groupJid = '120363000000000000@g.us';
  const { client, calls } = mockClient();
  await syncMessageReadState(client, {
    readMessages: [
      { remoteJid: groupJid, fromMe: false, id: 'g1', participant: '5511888888888@s.whatsapp.net' },
      { remoteJid: groupJid, fromMe: false, id: 'g2' },
    ],
  });
  assert.deepEqual(calls, [
    {
      command: 'readMessages',
      payload: [
        { remoteJid: groupJid, fromMe: false, id: 'g1', participant: '5511888888888@s.whatsapp.net' },
        { remoteJid: groupJid, fromMe: false, id: 'g2' },
      ],
    },
  ]);
  const schema = new Validator().validate(
    { readMessages: [{ remoteJid: groupJid, fromMe: false, id: 'g1', participant: 'x@lid' }] },
    readMessageSchema,
  );
  assert.equal(schema.valid, true);
});

const group = '120363000000000000@g.us';
const own = ownAccountJids({ id: '5511999999999:12@s.whatsapp.net', lid: '202860566425607:12@lid' });
const receiptFor = (id: string, userJid: string, readTimestamp: unknown = 1_790_000_100, remoteJid = group) => ({
  // Shape emitted by Baileys handleReceipt for group receipts: fromMe is always true, participant = reader.
  key: { remoteJid, id, fromMe: true, participant: userJid },
  receipt: { userJid, readTimestamp },
});

test('own account is normalised across device suffix, c.us and LID addressing', () => {
  assert.equal(normalizeAccountJid('5511999999999:12@s.whatsapp.net'), '5511999999999@s.whatsapp.net');
  assert.equal(normalizeAccountJid('5511999999999@c.us'), '5511999999999@s.whatsapp.net');
  assert.equal(normalizeAccountJid('202860566425607:3@lid'), '202860566425607@lid');
  assert.equal(normalizeAccountJid('nonsense'), null);
  assert.deepEqual([...own].sort(), ['202860566425607@lid', '5511999999999@s.whatsapp.net']);
});

test('group read-self receipts (phone JID or LID) are collected once per group, newest timestamp wins', () => {
  const result = collectGroupReadSelf(
    [
      receiptFor('m1', '5511999999999@s.whatsapp.net', 1_790_000_100),
      receiptFor('m2', '202860566425607@lid', 1_790_000_200),
      receiptFor('m2', '5511999999999@s.whatsapp.net', 1_790_000_150),
      receiptFor('o1', '5511999999999@s.whatsapp.net', 1_790_000_300, '120363111111111111@g.us'),
    ],
    own,
  );
  assert.deepEqual(result, [
    { remoteJid: group, ids: ['m1', 'm2'], readTimestamp: 1_790_000_200 },
    { remoteJid: '120363111111111111@g.us', ids: ['o1'], readTimestamp: 1_790_000_300 },
  ]);
});

test('a receipt from another participant (someone read OUR message) is never forwarded as our read', () => {
  const others = [
    receiptFor('m1', '5511888888888@s.whatsapp.net'),
    receiptFor('m2', '999999999999999@lid'),
    receiptFor('m3', '5511999999998@s.whatsapp.net'), // similar number, different user
  ];
  assert.deepEqual(collectGroupReadSelf(others, own), []);
});

test('non-group chats, delivery-only receipts and malformed updates are ignored', () => {
  const me = '5511999999999@s.whatsapp.net';
  assert.deepEqual(
    collectGroupReadSelf(
      [
        receiptFor('d1', me, 1_790_000_100, '5511888888888@s.whatsapp.net'),
        receiptFor('d2', me, null),
        receiptFor('d3', me, 'soon'),
        { key: { remoteJid: group }, receipt: { userJid: me, readTimestamp: 1 } },
        { key: null, receipt: null },
      ],
      own,
    ),
    [],
  );
});

test('groupsIgnore disables the forward; unknown own account disables it too', () => {
  const updates = [receiptFor('m1', '5511999999999@s.whatsapp.net')];
  assert.equal(collectGroupReadSelf(updates, own, { groupsIgnore: true }).length, 0);
  assert.equal(collectGroupReadSelf(updates, own, { groupsIgnore: false }).length, 1);
  assert.equal(collectGroupReadSelf(updates, ownAccountJids(undefined)).length, 0);
});

test('latest message id: newest stored timestamp wins, falls back to the last id on missing data or errors', async () => {
  assert.equal(await pickLatestMessageId(['a']), 'a');
  assert.equal(await pickLatestMessageId(['a', 'b', 'c']), 'c');
  assert.equal(await pickLatestMessageId(['a', 'b', 'c'], async () => ({ a: 30, b: 50, c: 10 })), 'b');
  assert.equal(await pickLatestMessageId(['a', 'b', 'c'], async () => ({ a: null })), 'c');
  assert.equal(await pickLatestMessageId(['a', 'b'], async () => { throw new Error('db down'); }), 'b');
});

test('group read-self payload has the messages.update status shape the CRM parser consumes', () => {
  const payload = buildGroupReadSelfPayload({
    keyId: 'm2',
    remoteJid: group,
    instanceId: 'inst-1',
    readTimestamp: 1_790_000_200,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    keyId: 'm2',
    remoteJid: group,
    fromMe: false,
    status: 'READ',
    instanceId: 'inst-1',
    readTimestamp: 1_790_000_200,
  });
  // parseEvolutionEvents('messages.update') needs: id (keyId), status READ, remoteJid, fromMe=false.
  assert.equal(payload.fromMe, false);
  assert.equal(payload.status, 'READ');
});
