/**
 * Opt-in LID enrichment for POST /chat/whatsappNumbers (`includeLid: true`).
 *
 * Kept free of Baileys/Prisma imports so it can be tested in isolation.
 */

/** Max numbers resolved per request. Each miss costs a USync LID query; WhatsApp may rate-limit bursts. */
export const WHATSAPP_NUMBERS_LID_LIMIT = 50;

export type LidPair = { lid?: string | null; pn?: string | null };

/** Shape of `sock.signalRepository.lidMapping.getLIDsForPNs` (one batched call, cache -> auth keys -> USync). */
export type LidBatchLookup = (pns: string[]) => Promise<LidPair[] | null | undefined>;

type LidCandidate = { jid: string; exists: boolean };

/** `5511999999999:12@s.whatsapp.net` -> `5511999999999`; anything that is not a phone user JID -> null. */
function phoneUser(jid: unknown): string | null {
  if (typeof jid !== 'string' || !jid.endsWith('@s.whatsapp.net')) return null;
  const user = jid.split('@')[0].split(':')[0];
  return /^\d{5,20}$/.test(user) ? user : null;
}

/** `12345:3@lid` -> `12345@lid`. Hosted LIDs and malformed values are rejected. */
function normalizeLid(lid: unknown): string | null {
  if (typeof lid !== 'string' || !lid.endsWith('@lid')) return null;
  const user = lid.split('@')[0].split(':')[0];
  return /^\d{5,25}$/.test(user) ? `${user}@lid` : null;
}

/**
 * Resolves the LID of every confirmed (`exists`) phone JID with ONE batched lookup.
 * The map key is the JID exactly as WhatsApp confirmed it (so a Brazilian number
 * with or without the 9th digit gets the LID of the account that actually exists).
 * Never throws: a failed lookup or an unresolved number yields `null`.
 */
export async function resolveLidsForConfirmedJids(
  items: LidCandidate[],
  lookup: LidBatchLookup,
  opts: { limit?: number; warn?: (message: string) => void } = {},
): Promise<Map<string, string | null>> {
  const limit = opts.limit ?? WHATSAPP_NUMBERS_LID_LIMIT;
  const warn = opts.warn ?? (() => undefined);
  const result = new Map<string, string | null>();

  const jidByUser = new Map<string, string>();
  for (const item of items) {
    if (!item?.exists) continue;
    // Already addressed by LID: nothing to look up.
    if (typeof item.jid === 'string' && item.jid.endsWith('@lid')) {
      result.set(item.jid, normalizeLid(item.jid));
      continue;
    }
    const user = phoneUser(item.jid);
    if (user && !jidByUser.has(user)) jidByUser.set(user, item.jid);
    result.set(item.jid, null);
  }

  const users = [...jidByUser.keys()];
  if (users.length > limit) {
    warn(`includeLid: ${users.length} numbers requested, resolving only the first ${limit}; the rest return lid null`);
  }
  const batch = users.slice(0, limit).map((user) => `${user}@s.whatsapp.net`);
  if (batch.length === 0) return result;

  let pairs: LidPair[] | null | undefined;
  try {
    pairs = await lookup(batch);
  } catch (error) {
    warn(`includeLid: LID lookup failed for ${batch.length} numbers, returning lid null: ${String(error)}`);
    return result;
  }

  const lidByUser = new Map<string, string>();
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    const user = phoneUser(pair?.pn);
    const lid = normalizeLid(pair?.lid);
    if (user && lid && !lidByUser.has(user)) lidByUser.set(user, lid);
  }

  for (const item of items) {
    if (!item?.exists) continue;
    const user = phoneUser(item.jid);
    const lid = user ? lidByUser.get(user) : undefined;
    if (lid) result.set(item.jid, lid);
  }
  return result;
}

/** Adds `lid` to every item. Items that are not confirmed phone numbers (groups, missing) get `lid: null`. */
export async function attachLids<T extends LidCandidate>(
  items: T[],
  lookup: LidBatchLookup,
  opts: { limit?: number; warn?: (message: string) => void } = {},
): Promise<Array<Omit<T, 'lid'> & { lid: string | null }>> {
  const lids = await resolveLidsForConfirmedJids(items, lookup, opts);
  return items.map((item) => ({ ...item, lid: (item.exists && lids.get(item.jid)) || null }));
}
