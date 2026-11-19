import * as s3Service from '@api/integrations/storage/s3/libs/minio.server';
import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { CreateQueueCommand, DeleteQueueCommand, ListQueuesCommand, SQS } from '@aws-sdk/client-sqs';
import { configService, HttpServer, Log, S3, Sqs } from '@config/env.config';
import { Logger } from '@config/logger.config';

import { EmitData, EventController, EventControllerInterface } from '../event.controller';
import { EventDto } from '../event.dto';

export class SqsController extends EventController implements EventControllerInterface {
  private sqs: SQS;
  private readonly logger = new Logger('SqsController');

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor, configService.get<Sqs>('SQS')?.ENABLED, 'sqs');
  }

  public async init(): Promise<void> {
    if (!this.status) {
      return;
    }

    const awsConfig = configService.get<Sqs>('SQS');

    this.sqs = new SQS({
      credentials: {
        accessKeyId: awsConfig.ACCESS_KEY_ID,
        secretAccessKey: awsConfig.SECRET_ACCESS_KEY,
      },

      region: awsConfig.REGION,
    });

    this.logger.info('SQS initialized');

    const sqsConfig = configService.get<Sqs>('SQS');
    if (this.sqs && sqsConfig.GLOBAL_ENABLED) {
      const sqsEvents = Object.keys(sqsConfig.EVENTS).filter((e) => sqsConfig.EVENTS[e]);
      await this.saveQueues(sqsConfig.GLOBAL_PREFIX_NAME, sqsEvents, true);
    }
  }

  private set channel(sqs: SQS) {
    this.sqs = sqs;
  }

  public get channel(): SQS {
    return this.sqs;
  }

  override async set(instanceName: string, data: EventDto): Promise<any> {
    if (!this.status || configService.get<Sqs>('SQS').GLOBAL_ENABLED) {
      return;
    }

    if (!data[this.name]?.enabled) {
      data[this.name].events = [];
    } else {
      if (0 === data[this.name].events.length) {
        data[this.name].events = EventController.events;
      }
    }

    await this.saveQueues(instanceName, data[this.name].events, data[this.name]?.enabled);

    const payload: any = {
      where: {
        instanceId: this.monitor.waInstances[instanceName].instanceId,
      },
      update: {
        enabled: data[this.name]?.enabled,
        events: data[this.name].events,
      },
      create: {
        enabled: data[this.name]?.enabled,
        events: data[this.name].events,
        instanceId: this.monitor.waInstances[instanceName].instanceId,
      },
    };

    console.log('*** payload: ', payload);
    return this.prisma[this.name].upsert(payload);
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
    integration,
    extra,
  }: EmitData): Promise<void> {
    if (integration && !integration.includes('sqs')) {
      return;
    }

    if (!this.status) {
      return;
    }

    if (this.sqs) {
      const serverConfig = configService.get<HttpServer>('SERVER');
      const sqsConfig = configService.get<Sqs>('SQS');

      const we = event.replace(/[.-]/gm, '_').toUpperCase();

      let sqsEvents = [];
      if (sqsConfig.GLOBAL_ENABLED) {
        sqsEvents = Object.keys(sqsConfig.EVENTS).filter((e) => sqsConfig.EVENTS[e]);
      } else {
        const instanceSqs = await this.get(instanceName);
        if (instanceSqs?.enabled && Array.isArray(instanceSqs?.events)) {
          sqsEvents = instanceSqs?.events;
        }
      }

      if (Array.isArray(sqsEvents) && sqsEvents.includes(we)) {
        const prefixName = sqsConfig.GLOBAL_ENABLED ? sqsConfig.GLOBAL_PREFIX_NAME : instanceName;
        const eventFormatted =
          sqsConfig.GLOBAL_ENABLED && sqsConfig.GLOBAL_FORCE_SINGLE_QUEUE
            ? 'singlequeue'
            : `${event.replace('.', '_').toLowerCase()}`;
        const queueName = `${prefixName}_${eventFormatted}.fifo`;
        const sqsUrl = `https://sqs.${sqsConfig.REGION}.amazonaws.com/${sqsConfig.ACCOUNT_ID}/${queueName}`;

        const message = {
          ...(extra ?? {}),
          event,
          instance: instanceName,
          dataType: 'json',
          data,
          server: serverConfig.NAME,
          server_url: serverUrl,
          date_time: dateTime,
          sender,
          apikey: apiKey,
        };

        const jsonStr = JSON.stringify(message);
        const size = Buffer.byteLength(jsonStr, 'utf8');
        if (size > sqsConfig.MAX_PAYLOAD_SIZE) {
          if (!configService.get<S3>('S3').ENABLE) {
            this.logger.error(
              `${instanceName} - ${eventFormatted} - SQS ignored: payload (${size} bytes) exceeds SQS size limit (${sqsConfig.MAX_PAYLOAD_SIZE} bytes) and S3 storage is not enabled.`,
            );
            return;
          }

          const buffer = Buffer.from(jsonStr, 'utf8');
          const fullName = `messages/${instanceName}_${eventFormatted}_${Date.now()}.json`;

          await s3Service.uploadFile(fullName, buffer, size, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });

          const fileUrl = await s3Service.getObjectUrl(fullName);

          message.data = { fileUrl };
          message.dataType = 's3';
        }

        const messageGroupId = sqsConfig.GLOBAL_ENABLED
          ? `${serverConfig.NAME}-${eventFormatted}-${instanceName}`
          : 'evolution';
        const isGlobalEnabled = sqsConfig.GLOBAL_ENABLED;
        const params = {
          MessageBody: JSON.stringify(message),
          MessageGroupId: messageGroupId,
          QueueUrl: sqsUrl,
          ...(!isGlobalEnabled && {
            MessageDeduplicationId: `${instanceName}_${eventFormatted}_${Date.now()}`,
          }),
        };

        this.sqs.sendMessage(params, (err) => {
          if (err) {
            this.logger.error({
              local: `${origin}.sendData-SQS`,
              params: JSON.stringify(message),
              sqsUrl: sqsUrl,
              message: err?.message,
              hostName: err?.hostname,
              code: err?.code,
              stack: err?.stack,
              name: err?.name,
              url: queueName,
              server_url: serverUrl,
            });
          } else if (configService.get<Log>('LOG').LEVEL.includes('WEBHOOKS')) {
            const logData = {
              local: `${origin}.sendData-SQS`,
              ...message,
            };

            this.logger.log(logData);
          }
        });
      }
    }
  }

  private async saveQueues(prefixName: string, events: string[], enable: boolean) {
    if (enable) {
      const sqsConfig = configService.get<Sqs>('SQS');
      const eventsFinded = await this.listQueues(prefixName);
      console.log('eventsFinded', eventsFinded);

      for (const event of events) {
        const normalizedEvent =
          sqsConfig.GLOBAL_ENABLED && sqsConfig.GLOBAL_FORCE_SINGLE_QUEUE ? 'singlequeue' : event.toLowerCase();
        if (eventsFinded.includes(normalizedEvent)) {
          this.logger.info(`A queue para o evento "${normalizedEvent}" já existe. Ignorando criação.`);
          continue;
        }

        const queueName = `${prefixName}_${normalizedEvent}.fifo`;
        try {
          const isGlobalEnabled = sqsConfig.GLOBAL_ENABLED;
          const createCommand = new CreateQueueCommand({
            QueueName: queueName,
            Attributes: {
              FifoQueue: 'true',
              ...(isGlobalEnabled && { ContentBasedDeduplication: 'true' }),
            },
          });

          const data = await this.sqs.send(createCommand);
          this.logger.info(`Queue ${queueName} criada: ${data.QueueUrl}`);
        } catch (err: any) {
          this.logger.error(`Erro ao criar queue ${queueName}: ${err.message}`);
        }

        if (sqsConfig.GLOBAL_ENABLED && sqsConfig.GLOBAL_FORCE_SINGLE_QUEUE) {
          break;
        }
      }
    }
  }

  private async listQueues(prefixName: string) {
    let existingQueues: string[] = [];

    try {
      const listCommand = new ListQueuesCommand({
        QueueNamePrefix: `${prefixName}_`,
      });

      const listData = await this.sqs.send(listCommand);
      if (listData.QueueUrls && listData.QueueUrls.length > 0) {
        // Extrai o nome da fila a partir da URL
        existingQueues = listData.QueueUrls.map((queueUrl) => {
          const parts = queueUrl.split('/');
          return parts[parts.length - 1];
        });
      }
    } catch (error: any) {
      this.logger.error(`Erro ao listar filas para ${prefixName}: ${error.message}`);
      return;
    }

    // Mapeia os eventos já existentes nas filas: remove o prefixo e o sufixo ".fifo"
    return existingQueues
      .map((queueName) => {
        // Espera-se que o nome seja `${instanceName}_${event}.fifo`
        if (queueName.startsWith(`${prefixName}_`) && queueName.endsWith('.fifo')) {
          return queueName.substring(prefixName.length + 1, queueName.length - 5).toLowerCase();
        }
        return '';
      })
      .filter((event) => event !== '');
  }

  // Para uma futura feature de exclusão forçada das queues
  private async removeQueuesByInstance(prefixName: string) {
    try {
      const listCommand = new ListQueuesCommand({
        QueueNamePrefix: `${prefixName}_`,
      });
      const listData = await this.sqs.send(listCommand);

      if (!listData.QueueUrls || listData.QueueUrls.length === 0) {
        this.logger.info(`No queues found for ${prefixName}`);
        return;
      }

      for (const queueUrl of listData.QueueUrls) {
        try {
          const deleteCommand = new DeleteQueueCommand({ QueueUrl: queueUrl });
          await this.sqs.send(deleteCommand);
          this.logger.info(`Queue ${queueUrl} deleted`);
        } catch (err: any) {
          this.logger.error(`Error deleting queue ${queueUrl}: ${err.message}`);
        }
      }
    } catch (err: any) {
      this.logger.error(`Error listing queues for ${prefixName}: ${err.message}`);
    }
  }
}
