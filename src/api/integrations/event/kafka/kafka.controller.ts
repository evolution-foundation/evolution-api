import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { configService, Kafka, Log } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { Consumer, ConsumerConfig, Kafka as KafkaJS, KafkaConfig, Producer, ProducerConfig } from 'kafkajs';

import { EmitData, EventController, EventControllerInterface } from '../event.controller';

export class KafkaController extends EventController implements EventControllerInterface {
  private kafkaClient: KafkaJS | null = null;
  private producer: Producer | null = null;
  private consumer: Consumer | null = null;
  private readonly logger = new Logger('KafkaController');
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 5000; // 5 seconds
  private isReconnecting = false;

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor, configService.get<Kafka>('KAFKA')?.ENABLED, 'kafka');
  }

  public async init(): Promise<void> {
    if (!this.status) {
      return;
    }

    await this.connect();
  }

  private async connect(): Promise<void> {
    try {
      const kafkaConfig = configService.get<Kafka>('KAFKA');

      const clientConfig: KafkaConfig = {
        clientId: kafkaConfig.CLIENT_ID || 'evolution-api',
        brokers: kafkaConfig.BROKERS || ['localhost:9092'],
        connectionTimeout: kafkaConfig.CONNECTION_TIMEOUT || 3000,
        requestTimeout: kafkaConfig.REQUEST_TIMEOUT || 30000,
        retry: {
          initialRetryTime: 100,
          retries: 8,
        },
      };

      // Add SASL authentication if configured
      if (kafkaConfig.SASL?.ENABLED) {
        clientConfig.sasl = {
          mechanism: (kafkaConfig.SASL.MECHANISM as any) || 'plain',
          username: kafkaConfig.SASL.USERNAME,
          password: kafkaConfig.SASL.PASSWORD,
        };
      }

      // Add SSL configuration if enabled
      if (kafkaConfig.SSL?.ENABLED) {
        clientConfig.ssl = {
          rejectUnauthorized: kafkaConfig.SSL.REJECT_UNAUTHORIZED !== false,
          ca: kafkaConfig.SSL.CA ? [kafkaConfig.SSL.CA] : undefined,
          key: kafkaConfig.SSL.KEY,
          cert: kafkaConfig.SSL.CERT,
        };
      }

      this.kafkaClient = new KafkaJS(clientConfig);

      // Initialize producer
      const producerConfig: ProducerConfig = {
        maxInFlightRequests: 1,
        idempotent: true,
        transactionTimeout: 30000,
      };

      this.producer = this.kafkaClient.producer(producerConfig);
      await this.producer.connect();

      // Initialize consumer for global events if enabled
      if (kafkaConfig.GLOBAL_ENABLED) {
        await this.initGlobalConsumer();
      }

      this.reconnectAttempts = 0;
      this.isReconnecting = false;

      this.logger.info('Kafka initialized successfully');

      // Create topics if they don't exist
      if (kafkaConfig.AUTO_CREATE_TOPICS) {
        await this.createTopics();
      }
    } catch (error) {
      this.logger.error({
        local: 'KafkaController.connect',
        message: 'Failed to connect to Kafka',
        error: error.message || error,
      });
      this.scheduleReconnect();
      throw error;
    }
  }

  private async initGlobalConsumer(): Promise<void> {
    try {
      const kafkaConfig = configService.get<Kafka>('KAFKA');

      const consumerConfig: ConsumerConfig = {
        groupId: kafkaConfig.CONSUMER_GROUP_ID || 'evolution-api-consumers',
        sessionTimeout: 30000,
        heartbeatInterval: 3000,
      };

      this.consumer = this.kafkaClient.consumer(consumerConfig);
      await this.consumer.connect();

      // Subscribe to global topics
      const events = kafkaConfig.EVENTS;
      if (events) {
        const eventKeys = Object.keys(events).filter((event) => events[event]);

        for (const event of eventKeys) {
          const topicName = this.getTopicName(event, true);
          await this.consumer.subscribe({ topic: topicName });
        }

        // Start consuming messages
        await this.consumer.run({
          eachMessage: async ({ topic, message }) => {
            try {
              const data = JSON.parse(message.value?.toString() || '{}');
              this.logger.debug(`Received message from topic ${topic}: ${JSON.stringify(data)}`);

              // Process the message here if needed
              // This is where you can add custom message processing logic
            } catch (error) {
              this.logger.error(`Error processing message from topic ${topic}: ${error}`);
            }
          },
        });

        this.logger.info('Global Kafka consumer initialized');
      }
    } catch (error) {
      this.logger.error(`Failed to initialize global Kafka consumer: ${error}`);
    }
  }

  private async createTopics(): Promise<void> {
    try {
      const kafkaConfig = configService.get<Kafka>('KAFKA');
      const admin = this.kafkaClient.admin();
      await admin.connect();

      const topics = [];

      // Create global topics if enabled
      if (kafkaConfig.GLOBAL_ENABLED && kafkaConfig.EVENTS) {
        const eventKeys = Object.keys(kafkaConfig.EVENTS).filter((event) => kafkaConfig.EVENTS[event]);

        for (const event of eventKeys) {
          const topicName = this.getTopicName(event, true);
          topics.push({
            topic: topicName,
            numPartitions: kafkaConfig.NUM_PARTITIONS || 1,
            replicationFactor: kafkaConfig.REPLICATION_FACTOR || 1,
          });
        }
      }

      if (topics.length > 0) {
        await admin.createTopics({
          topics,
          waitForLeaders: true,
        });

        this.logger.info(`Created ${topics.length} Kafka topics`);
      }

      await admin.disconnect();
    } catch (error) {
      this.logger.error(`Failed to create Kafka topics: ${error}`);
    }
  }

  private getTopicName(event: string, isGlobal: boolean = false, instanceName?: string): string {
    const kafkaConfig = configService.get<Kafka>('KAFKA');
    const prefix = kafkaConfig.TOPIC_PREFIX || 'evolution';

    if (isGlobal) {
      return `${prefix}.global.${event.toLowerCase().replace(/_/g, '.')}`;
    } else {
      return `${prefix}.${instanceName}.${event.toLowerCase().replace(/_/g, '.')}`;
    }
  }

  private handleConnectionLoss(): void {
    if (this.isReconnecting) {
      return;
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
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    const delay = this.reconnectDelay * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5));

    this.logger.info(
      `Scheduling Kafka reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`,
    );

    setTimeout(async () => {
      try {
        this.logger.info(
          `Attempting to reconnect to Kafka (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
        );
        await this.connect();
        this.logger.info('Successfully reconnected to Kafka');
      } catch (error) {
        this.logger.error({
          local: 'KafkaController.scheduleReconnect',
          message: `Reconnection attempt ${this.reconnectAttempts} failed`,
          error: error.message || error,
        });
        this.isReconnecting = false;
        this.scheduleReconnect();
      }
    }, delay);
  }

  private async ensureConnection(): Promise<boolean> {
    if (!this.producer) {
      this.logger.warn('Kafka producer is not available, attempting to reconnect...');
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
    if (integration && !integration.includes('kafka')) {
      return;
    }

    if (!this.status) {
      return;
    }

    if (!(await this.ensureConnection())) {
      this.logger.warn(`Failed to emit event ${event} for instance ${instanceName}: No Kafka connection`);
      return;
    }

    const instanceKafka = await this.get(instanceName);
    const kafkaLocal = instanceKafka?.events;
    const kafkaGlobal = configService.get<Kafka>('KAFKA').GLOBAL_ENABLED;
    const kafkaEvents = configService.get<Kafka>('KAFKA').EVENTS;
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
      timestamp: Date.now(),
    };

    const messageValue = JSON.stringify(message);

    // Instance-specific events
    if (instanceKafka?.enabled && this.producer && Array.isArray(kafkaLocal) && kafkaLocal.includes(we)) {
      const topicName = this.getTopicName(event, false, instanceName);

      let retry = 0;
      while (retry < 3) {
        try {
          await this.producer.send({
            topic: topicName,
            messages: [
              {
                key: instanceName,
                value: messageValue,
                headers: {
                  event,
                  instance: instanceName,
                  origin,
                  timestamp: dateTime,
                },
              },
            ],
          });

          if (logEnabled) {
            const logData = {
              local: `${origin}.sendData-Kafka`,
              ...message,
            };
            this.logger.log(logData);
          }

          break;
        } catch (error) {
          this.logger.error({
            local: 'KafkaController.emit',
            message: `Error publishing local Kafka message (attempt ${retry + 1}/3)`,
            error: error.message || error,
          });
          retry++;
          if (retry >= 3) {
            this.handleConnectionLoss();
          }
        }
      }
    }

    // Global events
    if (kafkaGlobal && kafkaEvents[we] && this.producer) {
      const topicName = this.getTopicName(event, true);

      let retry = 0;
      while (retry < 3) {
        try {
          await this.producer.send({
            topic: topicName,
            messages: [
              {
                key: `${instanceName}-${event}`,
                value: messageValue,
                headers: {
                  event,
                  instance: instanceName,
                  origin,
                  timestamp: dateTime,
                },
              },
            ],
          });

          if (logEnabled) {
            const logData = {
              local: `${origin}.sendData-Kafka-Global`,
              ...message,
            };
            this.logger.log(logData);
          }

          break;
        } catch (error) {
          this.logger.error({
            local: 'KafkaController.emit',
            message: `Error publishing global Kafka message (attempt ${retry + 1}/3)`,
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

  public async cleanup(): Promise<void> {
    try {
      if (this.consumer) {
        await this.consumer.disconnect();
        this.consumer = null;
      }
      if (this.producer) {
        await this.producer.disconnect();
        this.producer = null;
      }
      this.kafkaClient = null;
    } catch (error) {
      this.logger.warn({
        local: 'KafkaController.cleanup',
        message: 'Error during cleanup',
        error: error.message || error,
      });
      this.producer = null;
      this.consumer = null;
      this.kafkaClient = null;
    }
  }
}
