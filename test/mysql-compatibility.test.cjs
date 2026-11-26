// Run against a disposable, migrated local database with DATABASE_PROVIDER=mysql:
// node --test test/mysql-compatibility.test.cjs
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
const { Prisma, PrismaClient } = require('@prisma/client');

// Execute the actual service methods without importing server.module or starting WhatsApp/network workers.
function methods(file, names) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const members = source.statements.filter(ts.isClassDeclaration).flatMap((node) => [...node.members]);
  const selected = names.map((name) => {
    const member = members.find((node) => node.name?.getText(source) === name);
    assert.ok(member, `${file}: ${name} exists`);
    return member.getText(source);
  });
  const js = ts.transpileModule(`class Subject { ${selected.join('\n')} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function('Prisma', 'cuid', 'isArray', 'status', 'createJid', `${js}; return Subject.prototype;`)(
    Prisma, randomUUID, Array.isArray, { 3: 'DELIVERY_ACK', 4: 'READ' }, (jid) => `${jid}@s.whatsapp.net`,
  );
}

const repository = methods('src/api/repository/repository.service.ts', ['isMysql', 'jsonPath']);
const channel = methods('src/api/services/channel.service.ts', ['fetchMessages', 'fetchChats']);
const whatsapp = methods('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', [
  'getMessage', 'updateMessagesReadedByTimestamp', 'updateChatUnreadMessages', 'addLabel', 'removeLabel',
]);
const chatwoot = methods('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', [
  'getMessageByKeyId', 'updateChatwootMessageId',
]);

test('JSON paths follow the provider, including escaped member names', () => {
  for (const provider of ['mysql', 'postgresql', 'psql_bouncer']) {
    const receiver = Object.create(repository);
    receiver.configService = { get: () => ({ PROVIDER: provider }) };
    const segments = ['key.with.dot', 'quoted"key'];
    assert.deepEqual(receiver.jsonPath(...segments), provider === 'mysql' ? '$."key.with.dot"."quoted\\"key"' : segments);
  }
});

test('MySQL/MariaDB service operations preserve data and instance isolation', async (t) => {
  assert.equal(process.env.DATABASE_PROVIDER, 'mysql');
  const uri = new URL(process.env.DATABASE_CONNECTION_URI);
  assert.ok(['127.0.0.1', 'localhost'].includes(uri.hostname));
  assert.match(uri.pathname, /^\/evolution_mysql_test_\d+$/);
  const db = new PrismaClient();
  db.isMysql = true;
  db.jsonPath = repository.jsonPath;
  const base = {
    prismaRepository: db,
    instanceId: 'instance-a',
    cleanMessageData: (message) => message,
    logger: { verbose() {}, error() {} },
    isImportHistoryAvailable: () => false,
  };
  const wa = Object.assign(Object.create(whatsapp), base);
  const chats = Object.assign(Object.create(channel), base);
  const cw = Object.assign(Object.create(chatwoot), base);
  const jid = '966500000001@s.whatsapp.net';
  const now = Math.floor(Date.now() / 1000);
  try {
    await db.instance.createMany({ data: [{ id: 'instance-a', name: 'a' }, { id: 'instance-b', name: 'b' }] });
    await db.chat.createMany({ data: [
      { id: 'chat-b', instanceId: 'instance-b', remoteJid: jid, name: 'Other account', unreadMessages: 9 },
      { id: 'chat-a', instanceId: 'instance-a', remoteJid: jid, name: 'Arabic العربية', unreadMessages: 2 },
    ] });
    for (const [id, instanceId, fromMe, time] of [
      ['incoming', 'instance-a', false, now - 10],
      ['outgoing', 'instance-a', true, now],
      ['other-account', 'instance-b', false, now + 10],
    ]) {
      await db.message.create({ data: {
        id, instanceId, key: { id: fromMe ? 'sent' : 'shared-id', remoteJid: jid, fromMe },
        messageType: 'conversation', message: { conversation: 'مرحبا' }, source: 'web',
        status: 'DELIVERY_ACK', messageTimestamp: time,
      } });
    }

    await t.test('JSON filters accept strings and booleans and retain scope', async () => {
      const result = await chats.fetchMessages({ where: { key: { fromMe: true, remoteJid: jid } } });
      assert.deepEqual(result.messages.records.map((m) => m.id), ['outgoing']);
      assert.equal(result.messages.total, 1);
      const message = await wa.getMessage({ id: 'shared-id' }, true);
      assert.equal(message.id, 'incoming');
      assert.equal((await wa.getMessage({ id: 'shared-id' })).conversation, 'مرحبا');
      assert.equal(await cw.getMessageByKeyId({ instanceId: 'instance-a' }, "' OR 1=1 --"), null);
    });

    await t.test('read receipt updates do not touch outgoing or other-account messages/chats', async () => {
      assert.equal(await wa.updateMessagesReadedByTimestamp(jid, now), 1);
      assert.equal((await db.message.findUnique({ where: { id: 'incoming' } })).status, 'READ');
      assert.equal((await db.message.findUnique({ where: { id: 'outgoing' } })).status, 'DELIVERY_ACK');
      assert.equal((await db.message.findUnique({ where: { id: 'other-account' } })).status, 'DELIVERY_ACK');
      assert.equal((await db.chat.findUnique({ where: { id: 'chat-b' } })).unreadMessages, 9);
      assert.equal((await db.chat.findUnique({ where: { id: 'chat-a' } })).unreadMessages, 0);
    });

    await t.test('chat list returns newest message, JSON objects, booleans and pagination', async () => {
      const result = await chats.fetchChats({});
      assert.equal(result.length, 1);
      assert.equal(result[0].lastMessage.id, 'outgoing');
      assert.equal(result[0].lastMessage.key.remoteJid, jid);
      assert.equal(result[0].lastMessage.message.conversation, 'مرحبا');
      assert.equal(typeof result[0].windowActive, 'boolean');
      assert.equal(result[0].pushName, 'Arabic العربية');
      assert.deepEqual(await chats.fetchChats({ skip: 1 }), []);
      assert.deepEqual(await chats.fetchChats({ where: { remoteJid: "x' OR 1=1 --@s.whatsapp.net" } }), []);
      const filtered = await chats.fetchChats({ where: { messageTimestamp: {
        gte: new Date((now - 15) * 1000).toISOString(), lte: new Date((now - 5) * 1000).toISOString(),
      } }, take: 1 });
      assert.equal(filtered[0].lastMessage.id, 'incoming');
    });

    await t.test('label operations are atomic, literal and scoped', async () => {
      await Promise.all(['a', 'b', 'a', 'x%_!', "quote'"].map((label) => wa.addLabel(label, 'instance-a', jid)));
      let chat = await db.chat.findUnique({ where: { id: 'chat-a' } });
      assert.deepEqual([...chat.labels].sort(), ['a', 'b', 'x%_!', "quote'"].sort());
      await wa.removeLabel('x%_!', 'instance-a', jid);
      await wa.removeLabel('absent', 'instance-a', jid);
      chat = await db.chat.findUnique({ where: { id: 'chat-a' } });
      assert.deepEqual([...chat.labels].sort(), ['a', 'b', "quote'"].sort());
      assert.equal((await db.chat.findUnique({ where: { id: 'chat-b' } })).labels, null);
      await wa.removeLabel('absent', 'instance-a', 'new@s.whatsapp.net');
      assert.deepEqual((await db.chat.findFirst({ where: { instanceId: 'instance-a', remoteJid: 'new@s.whatsapp.net' } })).labels, []);
    });

    await t.test('compound label identity and LID cache can be written and read', async () => {
      const identity = { labelId: 'label', instanceId: 'instance-a' };
      for (const name of ['first', 'updated']) await db.label.upsert({
        where: { labelId_instanceId: identity }, create: { ...identity, name, color: '1' }, update: { name },
      });
      await db.label.create({ data: { ...identity, instanceId: 'instance-b', name: 'other', color: '2' } });
      assert.equal((await db.label.findUnique({ where: { labelId_instanceId: identity } })).name, 'updated');
      await db.isOnWhatsapp.create({ data: { remoteJid: jid, jidOptions: jid, lid: '123@lid' } });
      assert.equal((await db.isOnWhatsapp.findUnique({ where: { remoteJid: jid } })).lid, '123@lid');
    });

    await t.test('Chatwoot IDs update only the matching account', async () => {
      await cw.updateChatwootMessageId({ key: { id: 'shared-id' } }, { messageId: 42, isRead: true }, { instanceId: 'instance-a' });
      assert.equal((await cw.getMessageByKeyId({ instanceId: 'instance-a' }, 'shared-id')).chatwootMessageId, 42);
      assert.equal((await cw.getMessageByKeyId({ instanceId: 'instance-b' }, 'shared-id')).chatwootMessageId, null);
    });
  } finally {
    await db.$disconnect();
  }
});
