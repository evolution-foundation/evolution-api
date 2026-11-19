import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { configService, Log, Rabbitmq } from '@config/env.config';
import { Logger } from '@config/logger.config';
import * as amqp from 'amqplib/callback_api';

import { EmitData, EventController, EventControllerInterface } from '../event.controller';

export class RabbitmqController extends EventController implements EventControllerInterface {
  public amqpChannel: amqp.Channel | null = null;
  private amqpConnection: amqp.Connection | null = null;
  private readonly logger = new Logger('RabbitmqController');
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 5000; // 5 seconds
  private isReconnecting = false;

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor, configService.get<Rabbitmq>('RABBITMQ')?.ENABLED, 'rabbitmq');
  }

  public async init(): Promise<void> {
    if (!this.status) {
      return;
    }

    await this.connect();
  }

  private async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const uri = configService.get<Rabbitmq>('RABBITMQ').URI;
      const frameMax = configService.get<Rabbitmq>('RABBITMQ').FRAME_MAX;
      const rabbitmqExchangeName = configService.get<Rabbitmq>('RABBITMQ').EXCHANGE_NAME;

      const url = new URL(uri);
      const connectionOptions = {
        protocol: url.protocol.slice(0, -1),
        hostname: url.hostname,
        port: url.port || 5672,
        username: url.username || 'guest',
        password: url.password || 'guest',
        vhost: url.pathname.slice(1) || '/',
        frameMax: frameMax,
        heartbeat: 30, // Add heartbeat of 30 seconds
      };

      amqp.connect(connectionOptions, (error: Error, connection: amqp.Connection) => {
        if (error) {
          this.logger.error({
            local: 'RabbitmqController.connect',
            message: 'Failed to connect to RabbitMQ',
            error: error.message || error,
          });
          reject(error);
          return;
        }

        // Connection event handlers
        connection.on('error', (err: Error) => {
          this.logger.error({
            local: 'RabbitmqController.connectionError',
            message: 'RabbitMQ connection error',
            error: err.message || err,
          });
          this.handleConnectionLoss();
        });

        connection.on('close', () => {
          this.logger.warn('RabbitMQ connection closed');
          this.handleConnectionLoss();
        });

        connection.createChannel((channelError: Error, channel: amqp.Channel) => {
          if (channelError) {
            this.logger.error({
              local: 'RabbitmqController.createChannel',
              message: 'Failed to create RabbitMQ channel',
              error: channelError.message || channelError,
            });
            reject(channelError);
            return;
          }

          // Channel event handlers
          channel.on('error', (err: Error) => {
            this.logger.error({
              local: 'RabbitmqController.channelError',
              message: 'RabbitMQ channel error',
              error: err.message || err,
            });
            this.handleConnectionLoss();
          });

          channel.on('close', () => {
            this.logger.warn('RabbitMQ channel closed');
            this.handleConnectionLoss();
          });

          const exchangeName = rabbitmqExchangeName;

          channel.assertExchange(exchangeName, 'topic', {
            durable: true,
            autoDelete: false,
          });

          this.amqpConnection = connection;
          this.amqpChannel = channel;
          this.reconnectAttempts = 0; // Reset reconnect attempts on successful connection
          this.isReconnecting = false;

          this.logger.info('AMQP initialized successfully');

          resolve();
        });
      });
    })
      .then(() => {
        if (configService.get<Rabbitmq>('RABBITMQ')?.GLOBAL_ENABLED) {
          this.initGlobalQueues();
        }
      })
      .catch((error) => {
        this.logger.error({
          local: 'RabbitmqController.init',
          message: 'Failed to initialize AMQP',
          error: error.message || error,
        });
        this.scheduleReconnect();
        throw error;
      });
  }

  private handleConnectionLoss(): void {
    if (this.isReconnecting) {
      return; // Already attempting to reconnect
    }

    this.cleanup();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(
        `Maximum reconnect attempts (${this.maxReconnectAttempts}) reached. Stopping reconnection attempts.`,
      );
      return;
    }

    if (this.isReconnecting) {
      return; // Already scheduled
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    const delay = this.reconnectDelay * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)); // Exponential backoff with max delay

    this.logger.info(
      `Scheduling RabbitMQ reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`,
    );

    setTimeout(async () => {
      try {
        this.logger.info(
          `Attempting to reconnect to RabbitMQ (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
        );
        await this.connect();
        this.logger.info('Successfully reconnected to RabbitMQ');
      } catch (error) {
        this.logger.error({
          local: 'RabbitmqController.scheduleReconnect',
          message: `Reconnection attempt ${this.reconnectAttempts} failed`,
          error: error.message || error,
        });
        this.isReconnecting = false;
        this.scheduleReconnect();
      }
    }, delay);
  }

  private set channel(channel: amqp.Channel) {
    this.amqpChannel = channel;
  }

  public get channel(): amqp.Channel {
    return this.amqpChannel;
  }

  private async ensureConnection(): Promise<boolean> {
    if (!this.amqpChannel) {
      this.logger.warn('AMQP channel is not available, attempting to reconnect...');
      if (!this.isReconnecting) {
        this.scheduleReconnect();
      }
      return false;
    }
    return true;
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
    if (integration && !integration.includes('rabbitmq')) {
      return;
    }

    if (!this.status) {
      return;
    }

    if (!(await this.ensureConnection())) {
      this.logger.warn(`Failed to emit event ${event} for instance ${instanceName}: No AMQP connection`);
      return;
    }

    const instanceRabbitmq = await this.get(instanceName);
    const rabbitmqLocal = instanceRabbitmq?.events;
    const rabbitmqGlobal = configService.get<Rabbitmq>('RABBITMQ').GLOBAL_ENABLED;
    const rabbitmqEvents = configService.get<Rabbitmq>('RABBITMQ').EVENTS;
    const prefixKey = configService.get<Rabbitmq>('RABBITMQ').PREFIX_KEY;
    const rabbitmqExchangeName = configService.get<Rabbitmq>('RABBITMQ').EXCHANGE_NAME;
    const we = event.replace(/[.-]/gm, '_').toUpperCase();
    const logEnabled = configService.get<Log>('LOG').LEVEL.includes('WEBHOOKS');

    const message = {
      ...(extra ?? {}),
      event,
      instance: instanceName,
      data,
      server_url: serverUrl,
      date_time: dateTime,
      sender,
      apikey: apiKey,
    };

    if (instanceRabbitmq?.enabled && this.amqpChannel) {
      if (Array.isArray(rabbitmqLocal) && rabbitmqLocal.includes(we)) {
        const exchangeName = instanceName ?? rabbitmqExchangeName;

        let retry = 0;

        while (retry < 3) {
          try {
            await this.amqpChannel.assertExchange(exchangeName, 'topic', {
              durable: true,
              autoDelete: false,
            });

            const eventName = event.replace(/_/g, '.').toLowerCase();

            const queueName = `${instanceName}.${eventName}`;

            await this.amqpChannel.assertQueue(queueName, {
              durable: true,
              autoDelete: false,
              arguments: {
                'x-queue-type': 'quorum',
              },
            });

            await this.amqpChannel.bindQueue(queueName, exchangeName, eventName);

            await this.amqpChannel.publish(exchangeName, event, Buffer.from(JSON.stringify(message)));

            if (logEnabled) {
              const logData = {
                local: `${origin}.sendData-RabbitMQ`,
                ...message,
              };

              this.logger.log(logData);
            }

            break;
          } catch (error) {
            this.logger.error({
              local: 'RabbitmqController.emit',
              message: `Error publishing local RabbitMQ message (attempt ${retry + 1}/3)`,
              error: error.message || error,
            });
            retry++;
            if (retry >= 3) {
              this.handleConnectionLoss();
            }
          }
        }
      }
    }

    if (rabbitmqGlobal && rabbitmqEvents[we] && this.amqpChannel) {
      const exchangeName = rabbitmqExchangeName;

      let retry = 0;

      while (retry < 3) {
        try {
          await this.amqpChannel.assertExchange(exchangeName, 'topic', {
            durable: true,
            autoDelete: false,
          });

          const queueName = prefixKey
            ? `${prefixKey}.${event.replace(/_/g, '.').toLowerCase()}`
            : event.replace(/_/g, '.').toLowerCase();

          await this.amqpChannel.assertQueue(queueName, {
            durable: true,
            autoDelete: false,
            arguments: {
              'x-queue-type': 'quorum',
            },
          });

          await this.amqpChannel.bindQueue(queueName, exchangeName, event);

          await this.amqpChannel.publish(exchangeName, event, Buffer.from(JSON.stringify(message)));

          if (logEnabled) {
            const logData = {
              local: `${origin}.sendData-RabbitMQ-Global`,
              ...message,
            };

            this.logger.log(logData);
          }

          break;
        } catch (error) {
          this.logger.error({
            local: 'RabbitmqController.emit',
            message: `Error publishing global RabbitMQ message (attempt ${retry + 1}/3)`,
            error: error.message || error,
          });
          retry++;
          if (retry >= 3) {
            this.handleConnectionLoss();
          }
        }
      }
    }
  }

  private async initGlobalQueues(): Promise<void> {
    this.logger.info('Initializing global queues');

    if (!(await this.ensureConnection())) {
      this.logger.error('Cannot initialize global queues: No AMQP connection');
      return;
    }

    const rabbitmqExchangeName = configService.get<Rabbitmq>('RABBITMQ').EXCHANGE_NAME;
    const events = configService.get<Rabbitmq>('RABBITMQ').EVENTS;
    const prefixKey = configService.get<Rabbitmq>('RABBITMQ').PREFIX_KEY;

    if (!events) {
      this.logger.warn('No events to initialize on AMQP');
      return;
    }

    const eventKeys = Object.keys(events);

    for (const event of eventKeys) {
      if (events[event] === false) continue;

      try {
        const queueName =
          prefixKey !== ''
            ? `${prefixKey}.${event.replace(/_/g, '.').toLowerCase()}`
            : `${event.replace(/_/g, '.').toLowerCase()}`;
        const exchangeName = rabbitmqExchangeName;

        await this.amqpChannel.assertExchange(exchangeName, 'topic', {
          durable: true,
          autoDelete: false,
        });

        await this.amqpChannel.assertQueue(queueName, {
          durable: true,
          autoDelete: false,
          arguments: {
            'x-queue-type': 'quorum',
          },
        });

        await this.amqpChannel.bindQueue(queueName, exchangeName, event);

        this.logger.info(`Global queue initialized: ${queueName}`);
      } catch (error) {
        this.logger.error({
          local: 'RabbitmqController.initGlobalQueues',
          message: `Failed to initialize global queue for event ${event}`,
          error: error.message || error,
        });
        this.handleConnectionLoss();
        break;
      }
    }
  }

  public async cleanup(): Promise<void> {
    try {
      if (this.amqpChannel) {
        await this.amqpChannel.close();
        this.amqpChannel = null;
      }
      if (this.amqpConnection) {
        await this.amqpConnection.close();
        this.amqpConnection = null;
      }
    } catch (error) {
      this.logger.warn({
        local: 'RabbitmqController.cleanup',
        message: 'Error during cleanup',
        error: error.message || error,
      });
      this.amqpChannel = null;
      this.amqpConnection = null;
    }
  }
}
