export interface DeduplicationCache {
  has(key: string): Promise<boolean | undefined>;
  set(key: string, value: boolean, ttl?: number): Promise<void>;
  delete?(key: string): Promise<unknown>;
}

export interface ChatbotMessageDeduplicatorOptions {
  /** Time-to-live for seen message IDs in milliseconds (default: 5 minutes). */
  ttlMs?: number;
  /** Maximum number of entries retained in the in-memory map (default: 10,000). */
  maxSize?: number;
  /** Optional shared cache (e.g. CacheService / Redis) for cross-instance deduplication. */
  cache?: DeduplicationCache;
  /** Clock function for deterministic testing (default: Date.now). */
  now?: () => number;
  /** Optional logger for cache fallback warnings. */
  logger?: { warn?: (msg: unknown) => void };
}

export interface DedupKeyParams {
  integrationName?: string;
  instanceId?: string;
  instanceName?: string;
  remoteJid?: string;
  messageId?: string;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SIZE = 10_000;

/**
 * Bounded, TTL-based message deduplicator for chatbot integrations.
 *
 * Uses a synchronous in-memory map as the primary fast path (preventing concurrent
 * redelivery races within the same process) and optionally mirrors keys to a shared
 * CacheService with graceful fallback if the cache is disabled or unavailable.
 */
export class ChatbotMessageDeduplicator {
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly cache?: DeduplicationCache;
  private readonly now: () => number;
  private readonly logger?: { warn?: (msg: unknown) => void };
  private readonly seen = new Map<string, number>();

  constructor(options: ChatbotMessageDeduplicatorOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSize = Math.max(1, options.maxSize ?? DEFAULT_MAX_SIZE);
    this.cache = options.cache;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
  }

  /**
   * Builds a scoped deduplication key, or returns null if messageId is missing.
   */
  public buildKey({ integrationName, instanceId, instanceName, remoteJid, messageId }: DedupKeyParams): string | null {
    if (!messageId || typeof messageId !== 'string') {
      return null;
    }

    const integration = integrationName || 'chatbot';
    const instance = instanceId || instanceName || 'default';
    const jid = remoteJid || '';

    return `chatbot:dedup:${integration}:${instance}:${jid}:${messageId}`;
  }

  /**
   * Checks whether the message has already been seen within the TTL window and
   * atomically marks it as seen in memory if not.
   *
   * Returns `false` when `messageId` is missing so messages without a key.id are
   * never suppressed.
   */
  public async isDuplicate(params: DedupKeyParams): Promise<boolean> {
    const key = this.buildKey(params);
    if (!key) {
      return false;
    }

    const currentTime = this.now();
    const existingExpiry = this.seen.get(key);

    if (existingExpiry !== undefined) {
      if (existingExpiry > currentTime) {
        return true;
      }
      this.seen.delete(key);
    }

    if (this.ttlMs > 0) {
      this.evictIfNeeded(currentTime);
      // Claim synchronously before any async cache call to prevent concurrent redelivery races.
      this.seen.set(key, currentTime + this.ttlMs);
    }

    if (this.cache && this.ttlMs > 0) {
      try {
        const exists = await this.cache.has(key);
        if (exists) {
          return true;
        }
        const ttlSeconds = Math.max(1, Math.ceil(this.ttlMs / 1000));
        await this.cache.set(key, true, ttlSeconds);
      } catch (error) {
        this.logger?.warn?.(`Chatbot deduplication cache unavailable, using in-memory fallback: ${error}`);
      }
    }

    return false;
  }

  /**
   * Releases a previously claimed deduplication key so a failed delivery can be retried.
   */
  public async release(params: DedupKeyParams): Promise<void> {
    const key = this.buildKey(params);
    if (!key) {
      return;
    }

    this.seen.delete(key);

    if (this.cache?.delete) {
      try {
        await this.cache.delete(key);
      } catch (error) {
        this.logger?.warn?.(`Chatbot deduplication cache delete failed: ${error}`);
      }
    }
  }

  /**
   * Returns the current number of entries held in the in-memory map.
   */
  public get size(): number {
    return this.seen.size;
  }

  /**
   * Clears all in-memory deduplication entries.
   */
  public clear(): void {
    this.seen.clear();
  }

  private evictIfNeeded(currentTime: number): void {
    if (this.seen.size < this.maxSize) {
      return;
    }

    // First prune any expired entries.
    for (const [entryKey, expiresAt] of this.seen.entries()) {
      if (expiresAt <= currentTime) {
        this.seen.delete(entryKey);
      }
    }

    // If still at or above capacity, evict the oldest entries (Map preserves insertion order).
    while (this.seen.size >= this.maxSize) {
      const oldestKey = this.seen.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.seen.delete(oldestKey);
    }
  }
}
