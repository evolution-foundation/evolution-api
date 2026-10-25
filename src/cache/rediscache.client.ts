import { CacheConf, CacheConfRedis, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { createClient, RedisClientType } from 'redis';

class Redis {
  private logger = new Logger('Redis');
  private client: RedisClientType = null;
  private conf: CacheConfRedis;
  private connected = false;
  private connecting: Promise<RedisClientType> | null = null;

  constructor() {
    this.conf = configService.get<CacheConf>('CACHE')?.REDIS;
  }

  async getConnection(): Promise<RedisClientType> {
    if (this.connected && this.client) {
      return this.client;
    }

    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this._connect();
    return this.connecting;
  }

  private async _connect(): Promise<RedisClientType> {
    this.client = createClient({
      url: this.conf.URI,
    });

    this.client.on('connect', () => {
      this.logger.verbose('redis connecting');
    });

    this.client.on('ready', () => {
      this.logger.verbose('redis ready');
      this.connected = true;
      this.connecting = null;
    });

    this.client.on('error', () => {
      this.logger.error('redis disconnected');
      this.connected = false;
      this.connecting = null;
    });

    this.client.on('end', () => {
      this.logger.verbose('redis connection ended');
      this.connected = false;
      this.connecting = null;
    });

    try {
      await this.client.connect();
    } catch (e) {
      this.connected = false;
      this.connecting = null;
      this.logger.error('redis connect exception caught: ' + e);
      return null;
    }

    return this.client;
  }
}

export const redisClient = new Redis();
