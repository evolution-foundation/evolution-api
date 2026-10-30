import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  attachStatusAck,
  buildStatusAckStanza,
  type StatusAckNode,
  type StatusAckStanza,
} from '../src/api/integrations/channel/whatsapp/status-ack';

const statusNode: StatusAckNode = {
  tag: 'status',
  attrs: { id: '3A3ED33A9E8247EFA6B71DC531204430', from: '5511999999999@s.whatsapp.net', type: 'media', offline: '0' },
};

function fakeSocket(sendNode: (s: StatusAckStanza) => Promise<unknown> = async () => undefined) {
  const ws = new EventEmitter();
  const sent: StatusAckStanza[] = [];
  return {
    ws,
    sent,
    socket: {
      ws: { on: (event: string, listener: (node: StatusAckNode) => void) => ws.on(event, listener) },
      sendNode: async (s: StatusAckStanza) => {
        sent.push(s);
        return sendNode(s);
      },
    },
  };
}

test('builds the ack the server asked for: class=status, same id and type, no error attribute', () => {
  assert.deepEqual(buildStatusAckStanza(statusNode), {
    tag: 'ack',
    attrs: {
      id: '3A3ED33A9E8247EFA6B71DC531204430',
      to: '5511999999999@s.whatsapp.net',
      class: 'status',
      type: 'media',
    },
  });
});

test('keeps participant and recipient when present, and omits type when absent', () => {
  const stanza = buildStatusAckStanza({
    tag: 'status',
    attrs: { id: 'X1', from: 'status@broadcast', participant: '1@lid', recipient: '2@s.whatsapp.net' },
  });
  assert.deepEqual(stanza?.attrs, {
    id: 'X1',
    to: 'status@broadcast',
    class: 'status',
    participant: '1@lid',
    recipient: '2@s.whatsapp.net',
  });
  assert.equal('error' in (stanza?.attrs ?? {}), false);
});

test('a node without id or from cannot be acked', () => {
  assert.equal(buildStatusAckStanza({ tag: 'status', attrs: { from: 'a@s.whatsapp.net' } }), null);
  assert.equal(buildStatusAckStanza({ tag: 'status', attrs: { id: 'X' } }), null);
});

test('CB:status is acked, live and offline; other events are not touched', () => {
  const { ws, sent, socket } = fakeSocket();
  attachStatusAck(socket, () => assert.fail('no error expected'));

  ws.emit('CB:status', statusNode);
  ws.emit('CB:status', { ...statusNode, attrs: { ...statusNode.attrs, id: 'OFF1', offline: 'true', type: 'text' } });
  ws.emit('CB:message', statusNode);

  assert.deepEqual(
    sent.map((s) => [s.attrs.id, s.attrs.class, s.attrs.type]),
    [
      ['3A3ED33A9E8247EFA6B71DC531204430', 'status', 'media'],
      ['OFF1', 'status', 'text'],
    ],
  );
});

test('a failing send is reported and never throws out of the listener', async () => {
  const boom = new Error('socket closed');
  const { ws, socket } = fakeSocket(async () => {
    throw boom;
  });
  const errors: unknown[] = [];
  attachStatusAck(socket, (e) => errors.push(e));

  assert.doesNotThrow(() => ws.emit('CB:status', statusNode));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [boom]);
});

test('a sendNode that throws synchronously (Baileys encodes before the promise) is reported too', () => {
  const ws = new EventEmitter();
  const boom = new Error('encode failed');
  const errors: unknown[] = [];
  const socket = {
    ws,
    sendNode: (() => {
      throw boom;
    }) as (s: StatusAckStanza) => Promise<unknown>,
  };
  assert.equal(attachStatusAck(socket, (e) => errors.push(e)), true);

  assert.doesNotThrow(() => ws.emit('CB:status', statusNode));
  assert.deepEqual(errors, [boom]);
});

test('does not register a second ack when Baileys already listens to CB:status (no double ack)', () => {
  const ws = new EventEmitter();
  const sent: StatusAckStanza[] = [];
  ws.on('CB:status', () => undefined); // what a Baileys release with #2866 registers inside makeWASocket
  const socket = { ws, sendNode: async (s: StatusAckStanza) => sent.push(s) };

  assert.equal(attachStatusAck(socket, () => assert.fail('no error expected')), false);
  ws.emit('CB:status', statusNode);
  assert.equal(ws.listenerCount('CB:status'), 1);
  assert.deepEqual(sent, []);
});
