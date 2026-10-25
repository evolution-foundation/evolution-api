import { ICache } from '@api/abstract/abstract.cache';
import { CacheConf, CacheConfRedis, ConfigService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BufferJSON } from 'baileys';
import { RedisClientType } from 'redis';

import { redisClient } from './rediscache.client';

export class RedisCache implements ICache {
  private readonly logger = new Logger('RedisCache');
  private conf: CacheConfRedis;
  private client: RedisClientType = null;
  private connecting: Promise<RedisClientType> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly module: string,
  ) {
    this.conf = this.configService.get<CacheConf>('CACHE')?.REDIS;
  }

  private async ensureClient(): Promise<RedisClientType> {
    if (this.client) {
      return this.client;
    }
    if (this.connecting) {
      return this.connecting;
    }
    this.connecting = redisClient.getConnection();
    this.client = await this.connecting;
    this.connecting = null;
    return this.client;
  }

  async get(key: string): Promise<any> {
    try {
      const client = await this.ensureClient();
      if (!client) return null;
      return JSON.parse(await client.get(this.buildKey(key)));
    } catch (error) {
      this.logger.error(error);
    }
  }

  async hGet(key: string, field: string) {
    try {
      const client = await this.ensureClient();
      if (!client) return null;
      const data = await client.hGet(this.buildKey(key), field);

      if (data) {
        return JSON.parse(data, BufferJSON.reviver);
      }

      return null;
    } catch (error) {
      this.logger.error(error);
    }
  }

  async set(key: string, value: any, ttl?: number) {
    try {
      const client = await this.ensureClient();
      if (!client) return;
      await client.setEx(this.buildKey(key), ttl || this.conf?.TTL, JSON.stringify(value));
    } catch (error) {
      this.logger.error(error);
    }
  }

  async hSet(key: string, field: string, value: any) {
    try {
      const client = await this.ensureClient();
      if (!client) return;
      const json = JSON.stringify(value, BufferJSON.replacer);

      await client.hSet(this.buildKey(key), field, json);
    } catch (error) {
      this.logger.error(error);
    }
  }

  async has(key: string) {
    try {
      const client = await this.ensureClient();
      if (!client) return false;
      return (await client.exists(this.buildKey(key))) > 0;
    } catch (error) {
      this.logger.error(error);
    }
  }

  async delete(key: string) {
    try {
      const client = await this.ensureClient();
      if (!client) return 0;
      return await client.del(this.buildKey(key));
    } catch (error) {
      this.logger.error(error);
    }
  }

  async hDelete(key: string, field: string) {
    try {
      const client = await this.ensureClient();
      if (!client) return false;
      return await client.hDel(this.buildKey(key), field);
    } catch (error) {
      this.logger.error(error);
    }
  }

  async deleteAll(appendCriteria?: string) {
    try {
      const client = await this.ensureClient();
      if (!client) return 0;
      const keys = await this.keys(appendCriteria);
      if (!keys?.length) {
        return 0;
      }

      return await client.del(keys);
    } catch (error) {
      this.logger.error(error);
    }
  }

  async keys(appendCriteria?: string) {
    try {
      const client = await this.ensureClient();
      if (!client) return [];
      const match = `${this.buildKey('')}${appendCriteria ? `${appendCriteria}:` : ''}*`;
      const keys = [];
      for await (const key of client.scanIterator({
        MATCH: match,
        COUNT: 100,
      })) {
        keys.push(key);
      }

      return [...new Set(keys)];
    } catch (error) {
      this.logger.error(error);
    }
  }

  buildKey(key: string) {
    return `${this.conf?.PREFIX_KEY}:${this.module}:${key}`;
  }
}
