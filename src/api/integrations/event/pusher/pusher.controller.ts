import { EventDto } from '@api/integrations/event/event.dto';
import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { wa } from '@api/types/wa.types';
import { configService, Log, Pusher as ConfigPusher } from '@config/env.config';
import { Logger } from '@config/logger.config';
import Pusher from 'pusher';

import { EmitData, EventController, EventControllerInterface } from '../event.controller';
export class PusherController extends EventController implements EventControllerInterface {
  private readonly logger = new Logger('PusherController');
  private pusherClients: { [instanceName: string]: Pusher } = {};
  private globalPusherClient: Pusher | null = null;
  private pusherConfig: ConfigPusher = configService.get<ConfigPusher>('PUSHER');
  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor, configService.get<ConfigPusher>('PUSHER')?.ENABLED, 'pusher');
    this.init();
  }
  public async init(): Promise<void> {
    if (!this.status) {
      return;
    }
    if (this.pusherConfig.GLOBAL?.ENABLED) {
      const { APP_ID, KEY, SECRET, CLUSTER, USE_TLS } = this.pusherConfig.GLOBAL;
      if (APP_ID && KEY && SECRET && CLUSTER) {
        this.globalPusherClient = new Pusher({
          appId: APP_ID,
          key: KEY,
          secret: SECRET,
          cluster: CLUSTER,
          useTLS: USE_TLS,
        });
        this.logger.info('Pusher global client initialized');
      }
    }
    const instances = await this.prismaRepository.instance.findMany({
      where: {
        Pusher: {
          isNot: null,
        },
      },
      include: {
        Pusher: true,
      },
    });
    instances.forEach((instance) => {
      if (
        instance.Pusher.enabled &&
        instance.Pusher.appId &&
        instance.Pusher.key &&
        instance.Pusher.secret &&
        instance.Pusher.cluster
      ) {
        this.pusherClients[instance.name] = new Pusher({
          appId: instance.Pusher.appId,
          key: instance.Pusher.key,
          secret: instance.Pusher.secret,
          cluster: instance.Pusher.cluster,
          useTLS: instance.Pusher.useTLS,
        });
        this.logger.info(`Pusher client initialized for instance ${instance.name}`);
      } else {
        delete this.pusherClients[instance.name];
        this.logger.warn(`Pusher client disabled or misconfigured for instance ${instance.name}`);
      }
    });
  }
  override async set(instanceName: string, data: EventDto): Promise<wa.LocalPusher> {
    if (!data.pusher?.enabled) {
      data.pusher.events = [];
    } else if (data.pusher.events.length === 0) {
      data.pusher.events = EventController.events;
    }
    const instance = await this.prisma.pusher.upsert({
      where: {
        instanceId: this.monitor.waInstances[instanceName].instanceId,
      },
      update: {
        enabled: data.pusher.enabled,
        events: data.pusher.events,
        appId: data.pusher.appId,
        key: data.pusher.key,
        secret: data.pusher.secret,
        cluster: data.pusher.cluster,
        useTLS: data.pusher.useTLS,
      },
      create: {
        enabled: data.pusher.enabled,
        events: data.pusher.events,
        instanceId: this.monitor.waInstances[instanceName].instanceId,
        appId: data.pusher.appId,
        key: data.pusher.key,
        secret: data.pusher.secret,
        cluster: data.pusher.cluster,
        useTLS: data.pusher.useTLS,
      },
    });
    if (instance.enabled && instance.appId && instance.key && instance.secret && instance.cluster) {
      this.pusherClients[instanceName] = new Pusher({
        appId: instance.appId,
        key: instance.key,
        secret: instance.secret,
        cluster: instance.cluster,
        useTLS: instance.useTLS,
      });
      this.logger.info(`Pusher client initialized for instance ${instanceName}`);
    } else {
      delete this.pusherClients[instanceName];
      this.logger.warn(`Pusher client disabled or misconfigured for instance ${instanceName}`);
    }
    return instance;
  }
  public async emit({
    instanceName,
    origin,
    event,
    data,
    serverUrl,
    dateTime,
    sender,
    apiKey,
    local,
    integration,
    extra,
  }: EmitData): Promise<void> {
    if (integration && !integration.includes('pusher')) {
      return;
    }
    if (!this.status) {
      return;
    }
    const instance = (await this.get(instanceName)) as wa.LocalPusher;
    const we = event.replace(/[.-]/gm, '_').toUpperCase();
    const enabledLog = configService.get<Log>('LOG').LEVEL.includes('WEBHOOKS');
    const eventName = event.replace(/_/g, '.').toLowerCase();
    const pusherData = {
      ...(extra ?? {}),
      event,
      instance: instanceName,
      data,
      destination: instance?.appId || this.pusherConfig.GLOBAL?.APP_ID,
      date_time: dateTime,
      sender,
      server_url: serverUrl,
      apikey: apiKey,
    };
    if (event == 'qrcode.updated') {
      delete pusherData.data.qrcode.base64;
    }
    const payload = JSON.stringify(pusherData);
    const payloadSize = Buffer.byteLength(payload, 'utf8');
    const MAX_SIZE = 10240;
    if (payloadSize > MAX_SIZE) {
      this.logger.error({
        local: `${origin}.sendData-Pusher`,
        message: 'Payload size exceeds Pusher limit',
        event,
        instanceName,
        payloadSize,
      });
      return;
    }
    if (local && instance && instance.enabled) {
      const pusherLocalEvents = instance.events;
      if (Array.isArray(pusherLocalEvents) && pusherLocalEvents.includes(we)) {
        if (enabledLog) {
          this.logger.log({
            local: `${origin}.sendData-Pusher`,
            appId: instance.appId,
            ...pusherData,
          });
        }
        try {
          const pusher = this.pusherClients[instanceName];
          if (pusher) {
            pusher.trigger(instanceName, eventName, pusherData);
          } else {
            this.logger.error(`Pusher client not found for instance ${instanceName}`);
          }
        } catch (error) {
          this.logger.error({
            local: `${origin}.sendData-Pusher`,
            message: error?.message,
            error,
          });
        }
      }
    }
    if (this.pusherConfig.GLOBAL?.ENABLED) {
      const globalEvents = this.pusherConfig.EVENTS;
      if (globalEvents[we]) {
        if (enabledLog) {
          this.logger.log({
            local: `${origin}.sendData-Pusher-Global`,
            appId: this.pusherConfig.GLOBAL?.APP_ID,
            ...pusherData,
          });
        }
        try {
          if (this.globalPusherClient) {
            this.globalPusherClient.trigger(instanceName, eventName, pusherData);
          } else {
            this.logger.error('Global Pusher client not initialized');
          }
        } catch (error) {
          this.logger.error({
            local: `${origin}.sendData-Pusher-Global`,
            message: error?.message,
            error,
          });
        }
      }
    }
  }
}
