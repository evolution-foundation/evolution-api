import { InstanceDto } from '@api/dto/instance.dto';
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository } from '@api/repository/repository.service';
import { channelController } from '@api/server.module';
import { Events, Integration } from '@api/types/wa.types';
import { CacheConf, Chatwoot, ConfigService, Database, DelInstance, ProviderSession } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { INSTANCE_DIR, STORE_DIR } from '@config/path.config';
import { NotFoundException } from '@exceptions';
import { execFileSync } from 'child_process';
import EventEmitter2 from 'eventemitter2';
import { rmSync } from 'fs';
import { join } from 'path';

import { CacheService } from './cache.service';

export class WAMonitoringService {
  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly prismaRepository: PrismaRepository,
    private readonly providerFiles: ProviderFiles,
    private readonly cache: CacheService,
    private readonly chatwootCache: CacheService,
    private readonly baileysCache: CacheService,
  ) {
    this.removeInstance();
    this.noConnection();

    Object.assign(this.db, configService.get<Database>('DATABASE'));
    Object.assign(this.redis, configService.get<CacheConf>('CACHE'));

    (this as any).providerSession = Object.freeze(configService.get<ProviderSession>('PROVIDER'));
  }

  private readonly db: Partial<Database> = {};
  private readonly redis: Partial<CacheConf> = {};

  private readonly logger = new Logger('WAMonitoringService');
  public readonly waInstances: Record<string, any> = {};
  private readonly delInstanceTimeouts: Record<string, NodeJS.Timeout> = {};

  private readonly providerSession: ProviderSession;

  public delInstanceTime(instance: string) {
    const time = this.configService.get<DelInstance>('DEL_INSTANCE');
    if (typeof time === 'number' && time > 0) {
      // Clear previous timeout if exists
      if (this.delInstanceTimeouts[instance]) {
        clearTimeout(this.delInstanceTimeouts[instance]);
      }

      // Set new timeout and store reference
      this.delInstanceTimeouts[instance] = setTimeout(
        async () => {
          try {
            if (this.waInstances[instance]?.connectionStatus?.state !== 'open') {
              if (this.waInstances[instance]?.connectionStatus?.state === 'connecting') {
                if ((await this.waInstances[instance].integration) === Integration.WHATSAPP_BAILEYS) {
                  await this.waInstances[instance]?.client?.logout('Log out instance: ' + instance);
                  this.waInstances[instance]?.client?.ws?.close();
                  this.waInstances[instance]?.client?.end(undefined);
                }
                this.eventEmitter.emit('remove.instance', instance, 'inner');
              } else {
                this.eventEmitter.emit('remove.instance', instance, 'inner');
              }
            }
          } finally {
            // Clean up timeout reference
            delete this.delInstanceTimeouts[instance];
          }
        },
        1000 * 60 * time,
      );
    }
  }

  public clearDelInstanceTime(instance: string) {
    if (this.delInstanceTimeouts[instance]) {
      clearTimeout(this.delInstanceTimeouts[instance]);
      delete this.delInstanceTimeouts[instance];
    }
  }

  public async instanceInfo(instanceNames?: string[]): Promise<any> {
    if (instanceNames && instanceNames.length > 0) {
      const inexistentInstances = instanceNames ? instanceNames.filter((instance) => !this.waInstances[instance]) : [];

      if (inexistentInstances.length > 0) {
        throw new NotFoundException(
          `Instance${inexistentInstances.length > 1 ? 's' : ''} "${inexistentInstances.join(', ')}" not found`,
        );
      }
    }

    const clientName = this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME;

    const where =
      instanceNames && instanceNames.length > 0
        ? {
            name: {
              in: instanceNames,
            },
            clientName,
          }
        : { clientName };

    const instances = await this.prismaRepository.instance.findMany({
      where,
      include: {
        Chatwoot: true,
        Proxy: true,
        Rabbitmq: true,
        Nats: true,
        Sqs: true,
        Websocket: true,
        Setting: true,
        _count: {
          select: {
            Message: true,
            Contact: true,
            Chat: true,
          },
        },
      },
    });

    return instances;
  }

  public async instanceInfoById(instanceId?: string, number?: string) {
    let instanceName: string;
    if (instanceId) {
      instanceName = await this.prismaRepository.instance.findFirst({ where: { id: instanceId } }).then((r) => r?.name);
      if (!instanceName) {
        throw new NotFoundException(`Instance "${instanceId}" not found`);
      }
    } else if (number) {
      instanceName = await this.prismaRepository.instance.findFirst({ where: { number } }).then((r) => r?.name);
      if (!instanceName) {
        throw new NotFoundException(`Instance "${number}" not found`);
      }
    }

    if (!instanceName) {
      throw new NotFoundException(`Instance "${instanceId}" not found`);
    }

    if (instanceName && !this.waInstances[instanceName]) {
      throw new NotFoundException(`Instance "${instanceName}" not found`);
    }

    const instanceNames = instanceName ? [instanceName] : null;

    return this.instanceInfo(instanceNames);
  }

  public async cleaningUp(instanceName: string) {
    let instanceDbId: string;
    if (this.db.SAVE_DATA.INSTANCE) {
      const findInstance = await this.prismaRepository.instance.findFirst({
        where: { name: instanceName },
      });

      if (findInstance) {
        const instance = await this.prismaRepository.instance.update({
          where: { name: instanceName },
          data: { connectionStatus: 'close' },
        });

        rmSync(join(INSTANCE_DIR, instance.id), { recursive: true, force: true });

        instanceDbId = instance.id;
        await this.prismaRepository.session.deleteMany({ where: { sessionId: instance.id } });
      }
    }

    if (this.redis.REDIS.ENABLED && this.redis.REDIS.SAVE_INSTANCES) {
      await this.cache.delete(instanceName);
      if (instanceDbId) {
        await this.cache.delete(instanceDbId);
      }
    }

    if (this.providerSession?.ENABLED) {
      await this.providerFiles.removeSession(instanceName);
    }
  }

  public async cleaningStoreData(instanceName: string) {
    if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED) {
      const instancePath = join(STORE_DIR, 'chatwoot', instanceName);
      execFileSync('rm', ['-rf', instancePath]);
    }

    const instance = await this.prismaRepository.instance.findFirst({
      where: { name: instanceName },
    });

    if (!instance) return;

    rmSync(join(INSTANCE_DIR, instance.id), { recursive: true, force: true });

    await this.prismaRepository.session.deleteMany({ where: { sessionId: instance.id } });

    await this.prismaRepository.chat.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.contact.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.messageUpdate.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.message.deleteMany({ where: { instanceId: instance.id } });

    await this.prismaRepository.webhook.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.chatwoot.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.proxy.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.rabbitmq.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.nats.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.sqs.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.integrationSession.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.typebot.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.websocket.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.setting.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.label.deleteMany({ where: { instanceId: instance.id } });

    await this.prismaRepository.instance.delete({ where: { name: instanceName } });
  }

  public async loadInstance() {
    try {
      if (this.providerSession?.ENABLED) {
        await this.loadInstancesFromProvider();
      } else if (this.db.SAVE_DATA.INSTANCE) {
        await this.loadInstancesFromDatabasePostgres();
      } else if (this.redis.REDIS.ENABLED && this.redis.REDIS.SAVE_INSTANCES) {
        await this.loadInstancesFromRedis();
      }
    } catch (error) {
      this.logger.error(error);
    }
  }

  public async saveInstance(data: any) {
    const truncate = (str: string | null | undefined, maxLength: number): string | null => {
      if (!str) return null;
      return str.length > maxLength ? str.substring(0, maxLength) : str;
    };

    try {
      const instanceName = truncate(data.instanceName, 255);
      if (!instanceName || instanceName.trim().length === 0) {
        throw new Error('instanceName is required and cannot be empty');
      }

      const clientName = this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME;
      const clientNameTruncated = truncate(clientName, 100);

      // Validação adicional para garantir que todos os campos estão dentro dos limites
      const instanceData = {
        id: data.instanceId,
        name: instanceName,
        ownerJid: truncate(data.ownerJid, 100),
        profileName: truncate(data.profileName, 100),
        profilePicUrl: truncate(data.profilePicUrl, 500),
        connectionStatus:
          data.integration && data.integration === Integration.WHATSAPP_BAILEYS ? 'close' : (data.status ?? 'open'),
        number: truncate(data.number, 100),
        integration: truncate(data.integration || Integration.WHATSAPP_BAILEYS, 100),
        token: truncate(data.hash, 255),
        clientName: clientNameTruncated,
        businessId: truncate(data.businessId, 100),
      };

      this.logger.log({
        message: 'Creating instance in database',
        instanceName: instanceName,
        instanceId: data.instanceId,
        integration: instanceData.integration,
        tokenLength: instanceData.token?.length || 0,
      });

      await this.prismaRepository.instance.create({
        data: instanceData,
      });

      this.logger.log({
        message: 'Instance created successfully in database',
        instanceName: instanceName,
        instanceId: data.instanceId,
      });
    } catch (error) {
      this.logger.error({
        message: 'Error creating instance in database',
        error: error instanceof Error ? error.message : String(error),
        instanceName: data.instanceName,
        instanceId: data.instanceId,
      });
      throw error;
    }
  }

  public deleteInstance(instanceName: string) {
    try {
      this.eventEmitter.emit('remove.instance', instanceName, 'inner');
    } catch (error) {
      this.logger.error(error);
    }
  }

  private async setInstance(instanceData: InstanceDto) {
    const instance = channelController.init(instanceData, {
      configService: this.configService,
      eventEmitter: this.eventEmitter,
      prismaRepository: this.prismaRepository,
      cache: this.cache,
      chatwootCache: this.chatwootCache,
      baileysCache: this.baileysCache,
      providerFiles: this.providerFiles,
    });

    if (!instance) return;

    // Para WhatsApp Business, setInstance é async e precisa ser aguardado
    if (instanceData.integration === Integration.WHATSAPP_BUSINESS) {
      const setInstanceResult = (instance as any).setInstance({
        instanceId: instanceData.instanceId,
        instanceName: instanceData.instanceName,
        integration: instanceData.integration,
        token: instanceData.token,
        number: instanceData.number,
        businessId: instanceData.businessId,
        ownerJid: instanceData.ownerJid,
      });
      if (setInstanceResult instanceof Promise) {
        await setInstanceResult;
      }
    } else {
      instance.setInstance({
        instanceId: instanceData.instanceId,
        instanceName: instanceData.instanceName,
        integration: instanceData.integration,
        token: instanceData.token,
        number: instanceData.number,
        businessId: instanceData.businessId,
        ownerJid: instanceData.ownerJid,
      });
    }

    if (instanceData.connectionStatus === 'open' || instanceData.connectionStatus === 'connecting') {
      this.logger.info(
        `Auto-connecting instance "${instanceData.instanceName}" (status: ${instanceData.connectionStatus})`,
      );
      await instance.connectToWhatsapp();
    } else {
      this.logger.info(
        `Skipping auto-connect for instance "${instanceData.instanceName}" (status: ${instanceData.connectionStatus || 'close'})`,
      );
    }

    this.waInstances[instanceData.instanceName] = instance;
  }

  private async loadInstancesFromRedis() {
    const keys = await this.cache.keys();

    if (keys?.length > 0) {
      await Promise.all(
        keys.map(async (k) => {
          const instanceData = await this.prismaRepository.instance.findUnique({
            where: { id: k.split(':')[1] },
          });

          if (!instanceData) {
            return;
          }

          // Para WhatsApp Business, tenta carregar token completo do cache
          let token = instanceData.token;
          if (instanceData.integration === Integration.WHATSAPP_BUSINESS) {
            const cacheKey = `instance:${instanceData.name}:fullToken`;
            const fullToken = await this.cache.get(cacheKey);
            if (fullToken) {
              token = fullToken;
            }
          }

          const instance = {
            instanceId: k.split(':')[1],
            instanceName: k.split(':')[2],
            integration: instanceData.integration,
            token: token,
            number: instanceData.number,
            businessId: instanceData.businessId,
            connectionStatus: instanceData.connectionStatus as any, // Pass connection status
          };

          this.setInstance(instance);
        }),
      );
    }
  }

  private async loadInstancesFromDatabasePostgres() {
    const clientName = await this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME;

    const instances = await this.prismaRepository.instance.findMany({
      where: { clientName: clientName },
    });

    if (instances.length === 0) {
      return;
    }

    await Promise.all(
      instances.map(async (instance) => {
        // Para WhatsApp Business, tenta carregar token completo do cache
        let token = instance.token;
        if (instance.integration === Integration.WHATSAPP_BUSINESS) {
          const cacheKey = `instance:${instance.name}:fullToken`;
          const fullToken = await this.cache.get(cacheKey);
          if (fullToken) {
            token = fullToken;
          }
        }

        this.setInstance({
          instanceId: instance.id,
          instanceName: instance.name,
          integration: instance.integration,
          token: token,
          number: instance.number,
          businessId: instance.businessId,
          ownerJid: instance.ownerJid,
          connectionStatus: instance.connectionStatus as any, // Pass connection status
        });
      }),
    );
  }

  private async loadInstancesFromProvider() {
    const [instances] = await this.providerFiles.allInstances();

    if (!instances?.data) {
      return;
    }

    await Promise.all(
      instances?.data?.map(async (instanceId: string) => {
        const instance = await this.prismaRepository.instance.findUnique({
          where: { id: instanceId },
        });

        // Para WhatsApp Business, tenta carregar token completo do cache
        let token = instance.token;
        if (instance.integration === Integration.WHATSAPP_BUSINESS) {
          const cacheKey = `instance:${instance.name}:fullToken`;
          const fullToken = await this.cache.get(cacheKey);
          if (fullToken) {
            token = fullToken;
          }
        }

        this.setInstance({
          instanceId: instance.id,
          instanceName: instance.name,
          integration: instance.integration,
          token: token,
          businessId: instance.businessId,
          connectionStatus: instance.connectionStatus as any, // Pass connection status
        });
      }),
    );
  }

  private removeInstance() {
    this.eventEmitter.on('remove.instance', async (instanceName: string) => {
      try {
        await this.waInstances[instanceName]?.sendDataWebhook(Events.REMOVE_INSTANCE, null);

        this.clearDelInstanceTime(instanceName);

        this.cleaningUp(instanceName);
        this.cleaningStoreData(instanceName);
      } finally {
        this.logger.warn(`Instance "${instanceName}" - REMOVED`);
      }

      try {
        delete this.waInstances[instanceName];
      } catch (error) {
        this.logger.error(error);
      }
    });
    this.eventEmitter.on('logout.instance', async (instanceName: string) => {
      try {
        await this.waInstances[instanceName]?.sendDataWebhook(Events.LOGOUT_INSTANCE, null);

        this.clearDelInstanceTime(instanceName);

        if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED) {
          this.waInstances[instanceName]?.clearCacheChatwoot();
        }

        this.cleaningUp(instanceName);
      } finally {
        this.logger.warn(`Instance "${instanceName}" - LOGOUT`);
      }
    });
  }

  private noConnection() {
    this.eventEmitter.on('no.connection', async (instanceName) => {
      try {
        await this.waInstances[instanceName]?.client?.logout('Log out instance: ' + instanceName);

        this.waInstances[instanceName]?.client?.ws?.close();

        this.waInstances[instanceName].instance.qrcode = { count: 0 };
        this.waInstances[instanceName].stateConnection.state = 'close';
      } catch (error) {
        this.logger.error({
          localError: 'noConnection',
          warn: 'Error deleting instance from memory.',
          error,
        });
      } finally {
        this.logger.warn(`Instance "${instanceName}" - NOT CONNECTION`);
      }
    });
  }
}
