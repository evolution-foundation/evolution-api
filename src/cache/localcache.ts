import { ICache } from '@api/abstract/abstract.cache';
import { CacheConf, CacheConfLocal, ConfigService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BufferJSON } from 'baileys';
import NodeCache from 'node-cache';

export class LocalCache implements ICache {
  private readonly logger = new Logger('LocalCache');
  private conf: CacheConfLocal;
  static localCache = new NodeCache();

  constructor(
    private readonly configService: ConfigService,
    private readonly module: string,
  ) {
    this.conf = this.configService.get<CacheConf>('CACHE')?.LOCAL;
  }

  async get(key: string): Promise<any> {
    return LocalCache.localCache.get(this.buildKey(key));
  }

  async set(key: string, value: any, ttl?: number) {
    return LocalCache.localCache.set(this.buildKey(key), value, ttl || this.conf.TTL);
  }

  async has(key: string) {
    return LocalCache.localCache.has(this.buildKey(key));
  }

  async delete(key: string) {
    return LocalCache.localCache.del(this.buildKey(key));
  }

  async deleteAll(appendCriteria?: string) {
    const keys = await this.keys(appendCriteria);
    if (!keys?.length) {
      return 0;
    }

    return LocalCache.localCache.del(keys);
  }

  async keys(appendCriteria?: string) {
    const filter = `${this.buildKey('')}${appendCriteria ? `${appendCriteria}:` : ''}`;

    return LocalCache.localCache.keys().filter((key) => key.substring(0, filter.length) === filter);
  }

  buildKey(key: string) {
    return `${this.module}:${key}`;
  }

  async hGet(key: string, field: string) {
    try {
      const data = LocalCache.localCache.get(this.buildKey(key)) as object;

      if (data && field in data) {
        return JSON.parse(data[field], BufferJSON.reviver);
      }

      return null;
    } catch (error) {
      this.logger.error(error);
    }
  }

  async hSet(key: string, field: string, value: any) {
    try {
      const json = JSON.stringify(value, BufferJSON.replacer);

      let hash = LocalCache.localCache.get(this.buildKey(key));

      if (!hash) {
        hash = {};
      }

      hash[field] = json;
      LocalCache.localCache.set(this.buildKey(key), hash);
    } catch (error) {
      this.logger.error(error);
    }
  }

  async hDelete(key: string, field: string) {
    try {
      const data = LocalCache.localCache.get(this.buildKey(key)) as object;

      if (data && field in data) {
        delete data[field];
        LocalCache.localCache.set(this.buildKey(key), data);
        return 1;
      }

      return 0;
    } catch (error) {
      this.logger.error(error);
    }
  }
}
