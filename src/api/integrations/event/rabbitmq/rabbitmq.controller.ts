import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { configService, Log, Rabbitmq } from '@config/env.config';
import { Logger } from '@config/logger.config';
import * as amqp from 'amqplib/callback_api';

import { EmitData, EventController, EventControllerInterface } from '../event.controller';

class BrokerNackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerNackError';
  }
}

export class RabbitmqController extends EventController implements EventControllerInterface {
  public amqpChannel: amqp.ConfirmChannel | null = null;
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
        port: url.port ? Number(url.port) : 5672,
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

        connection.createConfirmChannel((channelError: Error, channel: amqp.ConfirmChannel) => {
          if (channelError) {
            this.logger.error({
              local: 'RabbitmqController.createConfirmChannel',
              message: 'Failed to create RabbitMQ confirm channel',
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

  private set channel(channel: amqp.ConfirmChannel | null) {
    this.amqpChannel = channel;
  }

  public get channel(): amqp.ConfirmChannel | null {
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
        const eventName = event.replace(/_/g, '.').toLowerCase();
        const queueName = `${instanceName}.${eventName}`;

        await this.publishWithRetry({
          exchangeName,
          queueName,
          bindingKey: eventName,
          routingKey: event,
          message,
          logEnabled,
          logLocal: `${origin}.sendData-RabbitMQ`,
          targetLabel: 'local',
        });
      }
    }

    if (rabbitmqGlobal && rabbitmqEvents[we] && this.amqpChannel) {
      const exchangeName = rabbitmqExchangeName;
      const eventName = event.replace(/_/g, '.').toLowerCase();
      const queueName = prefixKey ? `${prefixKey}.${eventName}` : eventName;

      await this.publishWithRetry({
        exchangeName,
        queueName,
        bindingKey: event,
        routingKey: event,
        message,
        logEnabled,
        logLocal: `${origin}.sendData-RabbitMQ-Global`,
        targetLabel: 'global',
      });
    }
  }

  /**
   * Publishes a persistent message and awaits broker confirmation (and drain on backpressure).
   */
  private publishWithConfirm(exchange: string, routingKey: string, content: Buffer, timeoutMs = 10_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const channel = this.amqpChannel;
      if (!channel) {
        reject(new Error('AMQP confirm channel is not available'));
        return;
      }

      let settled = false;
      let confirmed = false;
      let drained = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const onDrain = () => {
        drained = true;
        tryResolve();
      };

      const onError = (err: Error) => {
        finish(err || new Error('AMQP channel error during publish'));
      };

      const onClose = () => {
        finish(new Error('AMQP channel closed during publish'));
      };

      const cleanupListeners = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        channel.removeListener('drain', onDrain);
        channel.removeListener('error', onError);
        channel.removeListener('close', onClose);
      };

      const finish = (err?: Error | null) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupListeners();
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };

      const tryResolve = () => {
        if (confirmed && drained) {
          finish();
        }
      };

      channel.once('error', onError);
      channel.once('close', onClose);

      let published = false;
      try {
        published = channel.publish(exchange, routingKey, content, { persistent: true }, (err?: Error) => {
          if (err) {
            if (this.amqpChannel === channel) {
              finish(new BrokerNackError(err.message || String(err)));
            } else {
              finish(err);
            }
            return;
          }
          confirmed = true;
          tryResolve();
        });
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      if (published) {
        drained = true;
        tryResolve();
      } else if (!settled) {
        channel.once('drain', onDrain);
      }

      if (!settled) {
        timer = setTimeout(() => {
          finish(new Error('RabbitMQ publish confirmation timed out'));
        }, timeoutMs);
      }
    });
  }

  /**
   * Asserts exchange/queue/binding and publishes with publisher confirms, retrying up to 3 times.
   */
  private async publishWithRetry(params: {
    exchangeName: string;
    queueName: string;
    bindingKey: string;
    routingKey: string;
    message: Record<string, unknown>;
    logEnabled: boolean;
    logLocal: string;
    targetLabel: 'local' | 'global';
  }): Promise<void> {
    const { exchangeName, queueName, bindingKey, routingKey, message, logEnabled, logLocal, targetLabel } = params;
    let retry = 0;

    while (retry < 3) {
      if (!this.amqpChannel) {
        break;
      }

      try {
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

        await this.amqpChannel.bindQueue(queueName, exchangeName, bindingKey);

        await this.publishWithConfirm(exchangeName, routingKey, Buffer.from(JSON.stringify(message)));

        if (logEnabled) {
          const logData = {
            local: logLocal,
            ...message,
          };

          this.logger.log(logData);
        }

        break;
      } catch (error) {
        this.logger.error({
          local: 'RabbitmqController.emit',
          message: `Error publishing ${targetLabel} RabbitMQ message (attempt ${retry + 1}/3)`,
          error: error?.message || error,
        });
        retry++;
        if (!this.amqpChannel) {
          break;
        }
        if (retry >= 3 && !(error instanceof BrokerNackError)) {
          this.handleConnectionLoss();
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
    const channel = this.amqpChannel;
    const connection = this.amqpConnection;
    this.amqpChannel = null;
    this.amqpConnection = null;

    try {
      if (channel) {
        await channel.close();
      }
      if (connection) {
        await connection.close();
      }
    } catch (error) {
      this.logger.warn({
        local: 'RabbitmqController.cleanup',
        message: 'Error during cleanup',
        error: error.message || error,
      });
    }
  }
}
