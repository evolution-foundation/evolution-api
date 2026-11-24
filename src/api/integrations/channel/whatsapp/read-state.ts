import type { ReadMessageDto } from '@api/dto/chat.dto';
import type { proto, WASocket } from 'baileys';

export class ReadStateValidationError extends Error {}

type ReadStateClient = Pick<WASocket, 'readMessages' | 'chatModify'>;

function isGroupJid(jid: unknown): boolean {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

/**
 * Baileys throws on a group read whose not-from-me key has no participant
 * (Utils/chat-utils getMessageRange) and aggregates receipts by
 * `remoteJid:participant` (Utils/messages). Catch it here so the caller gets a
 * 400 naming the missing field instead of an opaque provider failure.
 */
function missingGroupParticipant(key: { remoteJid?: unknown; fromMe?: unknown; participant?: unknown }): boolean {
  return (
    isGroupJid(key.remoteJid) && key.fromMe !== true && (typeof key.participant !== 'string' || !key.participant.trim())
  );
}

function isChatJid(jid: string): boolean {
  // Baileys' isPnUser/isJidGroup/isLidUser check these suffixes. Keep this
  // predicate local so focused tests need not load the full Baileys runtime.
  return typeof jid === 'string' && /[^@\s]+@(s\.whatsapp\.net|g\.us|lid)$/.test(jid);
}

/** The legacy request still sends receipts alone. A lastMessage also syncs chat state to linked devices. */
export async function syncMessageReadState(client: ReadStateClient, data: ReadMessageDto) {
  if (!Array.isArray(data.readMessages)) {
    throw new ReadStateValidationError('readMessages must be an array');
  }

  const lastMessage = data.lastMessage;
  if (lastMessage) {
    const { key, messageTimestamp } = lastMessage;
    if (
      !key ||
      typeof key.remoteJid !== 'string' ||
      !isChatJid(key.remoteJid) ||
      typeof key.id !== 'string' ||
      !key.id.trim() ||
      typeof key.fromMe !== 'boolean' ||
      !Number.isSafeInteger(messageTimestamp) ||
      messageTimestamp <= 0
    ) {
      throw new ReadStateValidationError('lastMessage requires a valid chat key and epoch-seconds messageTimestamp');
    }
    if (missingGroupParticipant(key)) {
      throw new ReadStateValidationError('lastMessage from a group requires key.participant when fromMe is false');
    }
    if (
      data.readMessages.some(
        (read) =>
          !read ||
          !isChatJid(read.remoteJid) ||
          read.remoteJid !== key.remoteJid ||
          !read.id ||
          typeof read.fromMe !== 'boolean',
      )
    ) {
      throw new ReadStateValidationError('readMessages and lastMessage must belong to the same chat');
    }
    if (data.readMessages.some((read) => read && missingGroupParticipant(read))) {
      throw new ReadStateValidationError('readMessages from a group require participant when fromMe is false');
    }
  } else if (data.readMessages.length === 0) {
    throw new ReadStateValidationError('readMessages cannot be empty without lastMessage');
  }

  const keys: proto.IMessageKey[] = data.readMessages
    .filter((read) => isChatJid(read.remoteJid))
    .map((read) => ({
      remoteJid: read.remoteJid,
      fromMe: read.fromMe,
      id: read.id,
      ...(read.participant ? { participant: read.participant } : {}),
    }));

  // Run validation before either external call. A failure in either call propagates to the HTTP request.
  if (lastMessage) {
    await client.chatModify({ markRead: true, lastMessages: [lastMessage] }, lastMessage.key.remoteJid);
  }
  if (keys.length > 0 || !lastMessage) {
    await client.readMessages(keys);
  }
  return { message: 'Read messages', read: 'success' };
}

export function chatReadStateUpdates(
  chats: Array<Partial<proto.IConversation>>,
  instanceId: string,
  readStateObservedAt: string,
) {
  return chats.map((chat) => ({
    remoteJid: chat.id,
    instanceId,
    readStateObservedAt,
    ...(Number.isInteger(chat.unreadCount) ? { unreadCount: chat.unreadCount } : {}),
  }));
}

type ChatReadStateUpdate = ReturnType<typeof chatReadStateUpdates>[number];

/**
 * Chats are keyed by LID on recent accounts, but inbound messages are already
 * normalized to the phone JID (key.remoteJidAlt). Emit the phone JID too so
 * webhook consumers can match the read state to the same conversation.
 * The original LID is kept in `lid`; unresolved LIDs pass through unchanged.
 */
export async function resolveReadStateLids(
  updates: ChatReadStateUpdate[],
  resolvePn: (lid: string) => Promise<string | null | undefined>,
) {
  return Promise.all(
    updates.map(async (update) => {
      if (typeof update.remoteJid !== 'string' || !update.remoteJid.endsWith('@lid')) return update;
      let pn: string | null | undefined;
      try {
        pn = await resolvePn(update.remoteJid);
      } catch {
        pn = null;
      }
      const user = typeof pn === 'string' ? pn.split('@')[0].split(':')[0] : '';
      if (!/^\d{8,15}$/.test(user)) return update;
      return { ...update, remoteJid: `${user}@s.whatsapp.net`, lid: update.remoteJid };
    }),
  );
}

/**
 * The inverse of resolveReadStateLids. Webhook consumers only ever see the
 * phone JID, but chats migrated to LID addressing are indexed by LID on the
 * phone: receipts and app-state patches must address the LID or they target a
 * chat the primary device does not know.
 */
export async function toChatAddressingJid(
  jid: string,
  resolveLid: (pn: string) => Promise<string | null | undefined>,
): Promise<string> {
  if (typeof jid !== 'string' || !jid.endsWith('@s.whatsapp.net')) return jid;
  let lid: string | null | undefined;
  try {
    lid = await resolveLid(jid);
  } catch {
    lid = null;
  }
  const user = typeof lid === 'string' && lid.endsWith('@lid') ? lid.split('@')[0].split(':')[0] : '';
  return /^\d{8,20}$/.test(user) ? `${user}@lid` : jid;
}

export async function readRequestToChatAddressing(
  data: ReadMessageDto,
  resolveLid: (pn: string) => Promise<string | null | undefined>,
): Promise<ReadMessageDto> {
  const jids = new Set<string>();
  if (data.lastMessage?.key?.remoteJid) jids.add(data.lastMessage.key.remoteJid);
  if (Array.isArray(data.readMessages))
    for (const read of data.readMessages) if (read?.remoteJid) jids.add(read.remoteJid);
  const mapped = new Map<string, string>();
  for (const jid of jids) mapped.set(jid, await toChatAddressingJid(jid, resolveLid));
  return {
    ...data,
    readMessages: Array.isArray(data.readMessages)
      ? data.readMessages.map((read) => (read?.remoteJid ? { ...read, remoteJid: mapped.get(read.remoteJid) } : read))
      : data.readMessages,
    ...(data.lastMessage?.key
      ? {
          lastMessage: {
            ...data.lastMessage,
            key: {
              ...data.lastMessage.key,
              remoteJid: mapped.get(data.lastMessage.key.remoteJid) ?? data.lastMessage.key.remoteJid,
            },
          },
        }
      : {}),
  } as ReadMessageDto;
}

/**
 * Messages addressed by LID sometimes arrive without remoteJidAlt (history sync
 * after a fresh pairing, contacts not yet resolved by the server). Without the
 * phone JID, webhook consumers cannot tell who sent the message. Fill it from
 * Baileys' LID mapping; leave the key untouched when the mapping is unknown.
 */
export async function fillRemoteJidAlt(
  key: { remoteJid?: string | null; remoteJidAlt?: string | null } | null | undefined,
  resolvePn: (lid: string) => Promise<string | null | undefined>,
): Promise<void> {
  if (!key || typeof key.remoteJid !== 'string' || !key.remoteJid.endsWith('@lid') || key.remoteJidAlt) return;
  let pn: string | null | undefined;
  try {
    pn = await resolvePn(key.remoteJid);
  } catch {
    return;
  }
  const user = typeof pn === 'string' ? pn.split('@')[0].split(':')[0] : '';
  if (/^\d{8,15}$/.test(user)) key.remoteJidAlt = `${user}@s.whatsapp.net`;
}

/** `5511999999999:12@s.whatsapp.net` and `5511999999999@c.us` → `5511999999999@s.whatsapp.net`; LIDs keep their server. */
export function normalizeAccountJid(jid: unknown): string | null {
  if (typeof jid !== 'string') return null;
  const at = jid.lastIndexOf('@');
  if (at <= 0) return null;
  const user = jid.slice(0, at).split(':')[0].split('_')[0];
  const server = jid.slice(at + 1) === 'c.us' ? 's.whatsapp.net' : jid.slice(at + 1);
  return user && server ? `${user}@${server}` : null;
}

/** The instance's own account in every addressing mode (phone JID and LID), device suffix stripped. */
export function ownAccountJids(user: { id?: string | null; lid?: string | null } | null | undefined): Set<string> {
  const own = new Set<string>();
  for (const jid of [user?.id, user?.lid]) {
    const normalized = normalizeAccountJid(jid);
    if (normalized) own.add(normalized);
  }
  return own;
}

export type ReceiptUpdateLike = {
  key?: { remoteJid?: string | null; id?: string | null } | null;
  receipt?: { userJid?: string | null; readTimestamp?: unknown } | null;
};

export type GroupReadSelf = { remoteJid: string; ids: string[]; readTimestamp: number };

/**
 * Baileys reports a group receipt as `message-receipt.update` with
 * `receipt.userJid` = whoever read (messages-recv.js handleReceipt: the node's
 * `participant`). `key.participant` is that same reader and `key.fromMe` is
 * always true there, so neither says who wrote the message. A read by the
 * instance's own account is the phone reading the group (read-self); a read by
 * anyone else is a participant reading OUR message and must not be reported as ours.
 */
export function collectGroupReadSelf(
  updates: ReceiptUpdateLike[],
  own: Set<string>,
  opts: { groupsIgnore?: boolean } = {},
): GroupReadSelf[] {
  if (opts.groupsIgnore || own.size === 0) return [];
  const byGroup = new Map<string, GroupReadSelf>();
  for (const update of updates) {
    const remoteJid = update?.key?.remoteJid;
    const id = update?.key?.id;
    const readTimestamp = update?.receipt?.readTimestamp;
    if (typeof remoteJid !== 'string' || !remoteJid.endsWith('@g.us')) continue;
    if (typeof id !== 'string' || !id || typeof readTimestamp !== 'number' || !Number.isFinite(readTimestamp)) continue;
    const reader = normalizeAccountJid(update?.receipt?.userJid);
    if (!reader || !own.has(reader)) continue;

    const entry = byGroup.get(remoteJid) ?? { remoteJid, ids: [], readTimestamp };
    if (!entry.ids.includes(id)) entry.ids.push(id);
    entry.readTimestamp = Math.max(entry.readTimestamp, readTimestamp);
    byGroup.set(remoteJid, entry);
  }
  return [...byGroup.values()];
}

/**
 * One webhook per group is enough: the consumer clears the group's unread up to
 * the message it is given. A receipt lists many ids with no order guarantee, so
 * when a resolver for message timestamps is available the newest stored message
 * wins; otherwise (or on any resolver failure) the last id listed is used.
 */
export async function pickLatestMessageId(
  ids: string[],
  resolveTimestamps?: (ids: string[]) => Promise<Record<string, number | null | undefined>>,
): Promise<string> {
  const last = ids[ids.length - 1];
  if (ids.length < 2 || !resolveTimestamps) return last;
  try {
    const candidates = ids.slice(-200);
    const stamps = await resolveTimestamps(candidates);
    let best = last;
    let bestStamp = -Infinity;
    for (const id of candidates) {
      const raw = stamps?.[id];
      if (raw === null || raw === undefined) continue; // Number(null) would read as timestamp 0
      const stamp = Number(raw);
      if (Number.isFinite(stamp) && stamp >= bestStamp) {
        best = id;
        bestStamp = stamp;
      }
    }
    return bestStamp === -Infinity ? last : best;
  } catch {
    return last;
  }
}

/** Same shape the `messages.update` handler sends for a status change (consumed as MESSAGES_UPDATE). */
export function buildGroupReadSelfPayload(input: {
  keyId: string;
  remoteJid: string;
  instanceId: string;
  readTimestamp: number;
  messageId?: string;
}) {
  return {
    keyId: input.keyId,
    remoteJid: input.remoteJid,
    fromMe: false,
    participant: undefined,
    status: 'READ',
    pollUpdates: undefined,
    instanceId: input.instanceId,
    ...(input.messageId ? { messageId: input.messageId } : {}),
    readTimestamp: input.readTimestamp,
  };
}
