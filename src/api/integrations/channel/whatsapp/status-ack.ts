/**
 * Ack for the top-level `<status>` stanza.
 *
 * WhatsApp now delivers some accounts' contact status updates (stories) as a
 * `<status from=... id=... type="media|text">` stanza instead of
 * `<message from="status@broadcast">`. Baileys (7.0.0-rc14 and master) registers
 * no handler for it (only message, call, receipt, notification and
 * `ack,class:message`), so it is never acked. About 50 minutes after the
 * connection opens the server closes the stream naming the ack it is missing:
 *
 *   <stream:error><ack class="status" type="media" id="3A..."/></stream:error>
 *
 * Baileys maps it to "Stream Errored (ack)" / badSession (500), and on the
 * reconnect the server redelivers the same pending stanza offline: the drop
 * repeats every ~50 minutes. It does not depend on readStatus/shouldIgnoreJid,
 * the stanza never reaches handleMessage.
 *
 * Upstream: WhiskeySockets/Baileys#2858 (issue), #2866 (open PR, same fix);
 * reference implementation tulir/whatsmeow@a238105488 ("handle <status> nodes").
 *
 * The ack is a plain ack (no `error` attribute): a NACK keeps the stanza pending
 * on the server (see Baileys#2779). It mirrors Baileys' own buildAckStanza.
 * Drop this module once a Baileys release registers `CB:status` itself.
 */

export interface StatusAckNode {
  tag: string;
  attrs: Record<string, string | undefined>;
}

export interface StatusAckStanza {
  tag: 'ack';
  attrs: Record<string, string>;
}

export interface StatusAckSocket {
  ws: {
    on(event: string, listener: (node: StatusAckNode) => void): unknown;
    listenerCount?(event: string): number;
  };
  sendNode(stanza: StatusAckStanza): Promise<unknown>;
}

/** Same shape as Baileys' buildAckStanza for a node that is not `message`. Null when the node cannot be acked. */
export function buildStatusAckStanza(node: StatusAckNode): StatusAckStanza | null {
  const { attrs } = node ?? {};
  if (!attrs?.id || !attrs.from) return null;

  const stanza: StatusAckStanza = {
    tag: 'ack',
    attrs: { id: attrs.id, to: attrs.from, class: node.tag },
  };
  if (attrs.participant) stanza.attrs.participant = attrs.participant;
  if (attrs.recipient) stanza.attrs.recipient = attrs.recipient;
  if (attrs.type) stanza.attrs.type = attrs.type;
  return stanza;
}

/**
 * Acks every incoming `<status>` stanza, live or offline. Never throws.
 *
 * Call it right after makeWASocket. It does nothing and returns false when the socket
 * already has a `CB:status` listener: a Baileys release with #2866 registers one inside
 * makeWASocket and acks the stanza itself, so registering ours would ack it twice.
 */
export function attachStatusAck(socket: StatusAckSocket, onError: (error: unknown) => void): boolean {
  if (socket.ws.listenerCount?.('CB:status')) return false;
  socket.ws.on('CB:status', (node) => {
    try {
      const stanza = buildStatusAckStanza(node);
      if (!stanza) return;
      // Baileys' sendNode encodes synchronously before returning the send promise.
      socket.sendNode(stanza).catch(onError);
    } catch (error) {
      onError(error);
    }
  });
  return true;
}
