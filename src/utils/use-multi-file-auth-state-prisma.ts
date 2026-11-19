import { prismaRepository } from '@api/server.module';
import { CacheService } from '@api/services/cache.service';
import { CacheConf, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { INSTANCE_DIR } from '@config/path.config';
import { AuthenticationState, BufferJSON, initAuthCreds, WAProto as proto } from 'baileys';
import fs from 'fs/promises';
import path from 'path';

const fixFileName = (file: string): string | undefined => {
  if (!file) {
    return undefined;
  }
  const replacedSlash = file.replace(/\//g, '__');
  const replacedColon = replacedSlash.replace(/:/g, '-');
  return replacedColon;
};

export async function keyExists(sessionId: string): Promise<any> {
  try {
    const key = await prismaRepository.session.findUnique({ where: { sessionId: sessionId } });
    return !!key;
  } catch {
    return false;
  }
}

export async function saveKey(sessionId: string, keyJson: any): Promise<any> {
  const exists = await keyExists(sessionId);
  try {
    if (!exists)
      return await prismaRepository.session.create({
        data: {
          sessionId: sessionId,
          creds: JSON.stringify(keyJson),
        },
      });
    await prismaRepository.session.update({
      where: { sessionId: sessionId },
      data: { creds: JSON.stringify(keyJson) },
    });
  } catch {
    return null;
  }
}

export async function getAuthKey(sessionId: string): Promise<any> {
  try {
    const register = await keyExists(sessionId);
    if (!register) return null;
    const auth = await prismaRepository.session.findUnique({ where: { sessionId: sessionId } });
    return JSON.parse(auth?.creds);
  } catch {
    return null;
  }
}

async function deleteAuthKey(sessionId: string): Promise<any> {
  try {
    const register = await keyExists(sessionId);
    if (!register) return;
    await prismaRepository.session.delete({ where: { sessionId: sessionId } });
  } catch {
    return;
  }
}

async function fileExists(file: string): Promise<any> {
  try {
    const stat = await fs.stat(file);
    if (stat.isFile()) return true;
  } catch {
    return;
  }
}

const logger = new Logger('useMultiFileAuthStatePrisma');

export default async function useMultiFileAuthStatePrisma(
  sessionId: string,
  cache: CacheService,
): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  removeCreds: () => Promise<void>;
}> {
  const localFolder = path.join(INSTANCE_DIR, sessionId);
  const localFile = (key: string) => path.join(localFolder, fixFileName(key) + '.json');
  await fs.mkdir(localFolder, { recursive: true });

  async function writeData(data: any, key: string): Promise<any> {
    const dataString = JSON.stringify(data, BufferJSON.replacer);
    const cacheConfig = configService.get<CacheConf>('CACHE');

    if (key != 'creds') {
      if (cacheConfig.REDIS.ENABLED) {
        return await cache.hSet(sessionId, key, data);
      } else {
        await fs.writeFile(localFile(key), dataString);
        return;
      }
    }
    await saveKey(sessionId, dataString);
    return;
  }

  async function readData(key: string): Promise<any> {
    try {
      let rawData;
      const cacheConfig = configService.get<CacheConf>('CACHE');

      if (key != 'creds') {
        if (cacheConfig.REDIS.ENABLED) {
          return await cache.hGet(sessionId, key);
        } else {
          if (!(await fileExists(localFile(key)))) return null;
          rawData = await fs.readFile(localFile(key), { encoding: 'utf-8' });
          return JSON.parse(rawData, BufferJSON.reviver);
        }
      } else {
        rawData = await getAuthKey(sessionId);
      }

      const parsedData = JSON.parse(rawData, BufferJSON.reviver);
      return parsedData;
    } catch {
      return null;
    }
  }

  async function removeData(key: string): Promise<any> {
    try {
      const cacheConfig = configService.get<CacheConf>('CACHE');

      if (key != 'creds') {
        if (cacheConfig.REDIS.ENABLED) {
          return await cache.hDelete(sessionId, key);
        } else {
          await fs.unlink(localFile(key));
        }
      } else {
        await deleteAuthKey(sessionId);
      }
    } catch {
      return;
    }
  }

  async function removeCreds(): Promise<any> {
    const cacheConfig = configService.get<CacheConf>('CACHE');

    // Redis
    try {
      if (cacheConfig.REDIS.ENABLED) {
        await cache.delete(sessionId);
        logger.info({ action: 'redis.delete', sessionId });

        return;
      }
    } catch (err) {
      logger.warn({ action: 'redis.delete', sessionId, err });
    }

    logger.info({ action: 'auth.key.delete', sessionId });

    await deleteAuthKey(sessionId);
  }

  let creds = await readData('creds');
  if (!creds) {
    creds = initAuthCreds();
    await writeData(creds, 'creds');
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.create(value);
              }

              data[id] = value;
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;

              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => {
      return writeData(creds, 'creds');
    },

    removeCreds,
  };
}
