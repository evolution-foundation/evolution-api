import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Validator } from 'jsonschema';
import {
  attachLids,
  resolveLidsForConfirmedJids,
  WHATSAPP_NUMBERS_LID_LIMIT,
} from '../src/api/integrations/channel/whatsapp/numbers-lid';
import { whatsappNumberSchema } from '../src/validate/chat.schema';

const pnJid = (n: string) => `${n}@s.whatsapp.net`;

/** Mimics lidMapping.getLIDsForPNs: returns only the PNs it knows, in the {lid, pn} pair shape. */
function mockLookup(known: Record<string, string>) {
  const calls: string[][] = [];
  const lookup = async (pns: string[]) => {
    calls.push(pns);
    const pairs = pns.filter((pn) => known[pn]).map((pn) => ({ pn, lid: known[pn] }));
    return pairs.length ? pairs : null;
  };
  return { lookup, calls };
}

test('legacy body (no includeLid) still passes the schema', () => {
  const v = new Validator();
  assert.equal(v.validate({ numbers: ['5511999999999'] }, whatsappNumberSchema).valid, true);
});

test('schema: includeLid must be a boolean', () => {
  const v = new Validator();
  assert.equal(v.validate({ numbers: ['5511999999999'], includeLid: true }, whatsappNumberSchema).valid, true);
  assert.equal(v.validate({ numbers: ['5511999999999'], includeLid: 'yes' }, whatsappNumberSchema).valid, false);
});

test('adds lid from the mapping only for exists=true, in ONE batched call', async () => {
  const { lookup, calls } = mockLookup({ [pnJid('5511999999999')]: '111222333444@lid' });
  const items = [
    { jid: pnJid('5511999999999'), exists: true, number: '5511999999999', name: 'Ana' },
    { jid: pnJid('5511888888888'), exists: true, number: '5511888888888' },
    { jid: pnJid('5511777777777'), exists: false, number: '5511777777777' },
    { jid: '120363000000000000@g.us', exists: true, number: '120363000000000000@g.us' },
  ];
  const out = await attachLids(items, lookup);
  assert.deepEqual(
    out.map((o) => o.lid),
    ['111222333444@lid', null, null, null],
  );
  assert.equal(out[0].name, 'Ana');
  assert.equal(calls.length, 1, 'a single batched lookup');
  assert.deepEqual(calls[0], [pnJid('5511999999999'), pnJid('5511888888888')]);
});

test('lid corresponds to the jid WhatsApp confirmed (9th digit), not to the typed number', async () => {
  // typed 5511999999999 (with 9) but WhatsApp confirmed the 12-digit jid
  const confirmed = pnJid('551199999999');
  const { lookup, calls } = mockLookup({ [confirmed]: '999888777666@lid', [pnJid('5511999999999')]: '000@lid' });
  const out = await attachLids([{ jid: confirmed, exists: true, number: '5511999999999' }], lookup);
  assert.deepEqual(calls[0], [confirmed]);
  assert.equal(out[0].lid, '999888777666@lid');
});

test('device suffix on the returned lid is stripped; hosted/malformed lids are ignored', async () => {
  const lookup = async () => [
    { pn: pnJid('5511999999999'), lid: '111222333444:7@lid' },
    { pn: pnJid('5511888888888'), lid: '555666777888@hosted.lid' },
    { pn: pnJid('5511777777777'), lid: 'garbage' },
  ];
  const out = await attachLids(
    ['5511999999999', '5511888888888', '5511777777777'].map((n) => ({ jid: pnJid(n), exists: true, number: n })),
    lookup,
  );
  assert.deepEqual(
    out.map((o) => o.lid),
    ['111222333444@lid', null, null],
  );
});

test('lookup throws: lid null for everyone, no throw, WARN logged', async () => {
  const warnings: string[] = [];
  const out = await attachLids(
    [{ jid: pnJid('5511999999999'), exists: true, number: '5511999999999' }],
    async () => {
      throw new Error('usync timeout');
    },
    { warn: (m) => warnings.push(m) },
  );
  assert.equal(out[0].lid, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /usync timeout/);
});

test('lookup returns null (no pairs): lid null', async () => {
  const out = await attachLids([{ jid: pnJid('5511999999999'), exists: true, number: 'x' }], async () => null);
  assert.equal(out[0].lid, null);
});

test('cap: only the first N unique numbers are looked up, the rest get null + a WARN', async () => {
  const known: Record<string, string> = {};
  const items = Array.from({ length: WHATSAPP_NUMBERS_LID_LIMIT + 5 }, (_, i) => {
    const n = `55119${String(10000000 + i)}`;
    known[pnJid(n)] = `${900000000 + i}@lid`;
    return { jid: pnJid(n), exists: true, number: n };
  });
  const { lookup, calls } = mockLookup(known);
  const warnings: string[] = [];
  const out = await attachLids(items, lookup, { warn: (m) => warnings.push(m) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, WHATSAPP_NUMBERS_LID_LIMIT);
  assert.equal(out.filter((o) => o.lid).length, WHATSAPP_NUMBERS_LID_LIMIT);
  assert.equal(out[WHATSAPP_NUMBERS_LID_LIMIT - 1].lid, `${900000000 + WHATSAPP_NUMBERS_LID_LIMIT - 1}@lid`);
  assert.equal(out[WHATSAPP_NUMBERS_LID_LIMIT].lid, null);
  assert.equal(warnings.length, 1);
});

test('duplicate confirmed jids are looked up once and both items get the lid', async () => {
  const jid = pnJid('5511999999999');
  const { lookup, calls } = mockLookup({ [jid]: '111222333444@lid' });
  const out = await attachLids(
    [
      { jid, exists: true, number: '5511999999999' },
      { jid, exists: true, number: '551199999999' },
    ],
    lookup,
  );
  assert.deepEqual(calls[0], [jid]);
  assert.deepEqual(
    out.map((o) => o.lid),
    ['111222333444@lid', '111222333444@lid'],
  );
});

test('already-LID jid (cache hit) is returned as is, without a lookup', async () => {
  const { lookup, calls } = mockLookup({});
  const map = await resolveLidsForConfirmedJids([{ jid: '111222333444@lid', exists: true }], lookup);
  assert.equal(calls.length, 0);
  assert.equal(map.get('111222333444@lid'), '111222333444@lid');
});

test('nothing to resolve: no lookup call at all', async () => {
  const { lookup, calls } = mockLookup({});
  await attachLids([{ jid: pnJid('5511999999999'), exists: false, number: 'x' }], lookup);
  assert.equal(calls.length, 0);
});
