import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import { afterEach, beforeEach, describe, it } from 'node:test';

// Ensure RabbitMQ env vars are set before env.config is loaded
process.env.RABBITMQ_ENABLED = 'true';
process.env.RABBITMQ_URI = 'amqp://guest:guest@localhost:5672';
process.env.RABBITMQ_EXCHANGE_NAME = 'evolution_exchange';
process.env.RABBITMQ_FRAME_MAX = '8192';
process.env.RABBITMQ_GLOBAL_ENABLED = 'false';
process.env.RABBITMQ_PREFIX_KEY = '';
process.env.RABBITMQ_EVENTS_MESSAGES_UPSERT = 'true';

type PublishCall = {
  exchange: string;
  routingKey: string;
  content: Buffer;
  options: Record<string, any>;
};

function createMockConfirmChannel(
  publishBehavior?: (call: PublishCall, cb: (err?: Error | null) => void) => boolean | void,
) {
  const emitter = new EventEmitter() as any;
  emitter.publishCalls = [] as PublishCall[];
  emitter.assertExchangeCalls = [] as any[];
  emitter.assertQueueCalls = [] as any[];
  emitter.bindQueueCalls = [] as any[];
  emitter.closeCalls = 0;

  emitter.assertExchange = (exchange: string, type: string, options: any) => {
    emitter.assertExchangeCalls.push({ exchange, type, options });
  };
  emitter.assertQueue = (queue: string, options: any) => {
    emitter.assertQueueCalls.push({ queue, options });
  };
  emitter.bindQueue = (queue: string, exchange: string, pattern: string) => {
    emitter.bindQueueCalls.push({ queue, exchange, pattern });
  };
  emitter.publish = (
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Record<string, any>,
    cb?: (err?: Error | null) => void,
  ) => {
    const call: PublishCall = { exchange, routingKey, content, options };
    emitter.publishCalls.push(call);
    if (publishBehavior) {
      const res = publishBehavior(call, cb || (() => {}));
      if (typeof res === 'boolean') {
        return res;
      }
    } else if (cb) {
      cb(null);
    }
    return true;
  };
  emitter.close = () => {
    emitter.closeCalls++;
  };

  return emitter;
}

function createMockConnection(confirmChannel: any, channelError: Error | null = null) {
  const conn = new EventEmitter() as any;
  conn.createConfirmChannelCalled = false;
  conn.createChannelCalled = false;
  conn.closeCalls = 0;

  conn.createConfirmChannel = (cb: (err: Error | null, ch?: any) => void) => {
    conn.createConfirmChannelCalled = true;
    cb(channelError, confirmChannel);
  };
  conn.createChannel = () => {
    conn.createChannelCalled = true;
    throw new Error('createChannel should not be called; expected createConfirmChannel');
  };
  conn.close = () => {
    conn.closeCalls++;
  };

  return conn;
}

// Intercept @prisma/client and amqplib/callback_api before loading RabbitmqController
let mockConnectImpl: (options: any, cb: (err: Error | null, conn?: any) => void) => void = () => {};

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (request === '@prisma/client') {
    return {
      PrismaClient: class PrismaClient {},
    };
  }
  if (request === 'amqplib/callback_api') {
    return {
      connect: (options: any, cb: (err: Error | null, conn?: any) => void) => mockConnectImpl(options, cb),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RabbitmqController } = require('../src/api/integrations/event/rabbitmq/rabbitmq.controller');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { configService } = require('../src/config/env.config');

describe('RabbitmqController - Publisher Confirms & Persistence', () => {
  let prismaMock: any;
  let waMonitorMock: any;
  let controller: any;

  beforeEach(() => {
    prismaMock = {
      rabbitmq: {
        findUnique: async () => null,
        upsert: async () => null,
      },
    };
    waMonitorMock = {};
    controller = new RabbitmqController(prismaMock, waMonitorMock);
    // Stub get() to avoid needing instance DB lookup
    controller.get = async () => ({
      enabled: true,
      events: ['MESSAGES_UPSERT'],
    });
  });

  afterEach(async () => {
    // Prevent dangling reconnect timers from keeping the test process alive
    controller.maxReconnectAttempts = 0;
    await controller.cleanup();
  });

  it('uses createConfirmChannel instead of createChannel on init()', async () => {
    const mockChannel = createMockConfirmChannel();
    const mockConnection = createMockConnection(mockChannel);
    mockConnectImpl = (_opts, cb) => cb(null, mockConnection);

    await controller.init();

    assert.equal(mockConnection.createConfirmChannelCalled, true);
    assert.equal(mockConnection.createChannelCalled, false);
    assert.equal(controller.amqpChannel, mockChannel);
    assert.equal(controller.channel, mockChannel);
    assert.equal(mockChannel.assertExchangeCalls.length, 1);
    assert.deepEqual(mockChannel.assertExchangeCalls[0], {
      exchange: 'evolution_exchange',
      type: 'topic',
      options: { durable: true, autoDelete: false },
    });
  });

  it('passes { persistent: true } to publish() and resolves cleanly on broker ack', async () => {
    const mockChannel = createMockConfirmChannel((_call, cb) => cb(null));
    const mockConnection = createMockConnection(mockChannel);
    mockConnectImpl = (_opts, cb) => cb(null, mockConnection);

    await controller.init();

    await controller.emit({
      instanceName: 'test-instance',
      origin: 'TestOrigin',
      event: 'messages.upsert',
      data: { id: 'msg-1' },
      serverUrl: 'http://localhost:8080',
      dateTime: '2026-11-22T00:00:00.000Z',
      sender: '5511999999999@s.whatsapp.net',
    });

    assert.equal(mockChannel.publishCalls.length, 1);
    const call = mockChannel.publishCalls[0];
    assert.equal(call.exchange, 'test-instance');
    assert.equal(call.routingKey, 'messages.upsert');
    assert.deepEqual(call.options, { persistent: true });
    assert.equal(JSON.parse(call.content.toString()).event, 'messages.upsert');
  });

  it('logs error, retries up to 3 times, and triggers handleConnectionLoss on persistent broker nack', async () => {
    const mockChannel = createMockConfirmChannel((_call, cb) => {
      cb(new Error('Message nacked by broker'));
    });
    const mockConnection = createMockConnection(mockChannel);
    mockConnectImpl = (_opts, cb) => cb(null, mockConnection);

    await controller.init();

    const loggedErrors: any[] = [];
    controller.logger = {
      info: () => {},
      warn: () => {},
      log: () => {},
      error: (err: any) => loggedErrors.push(err),
    };

    let connectionLossHandled = false;
    controller.maxReconnectAttempts = 0;
    const origHandleLoss = controller.handleConnectionLoss.bind(controller);
    controller.handleConnectionLoss = () => {
      connectionLossHandled = true;
      origHandleLoss();
    };

    await controller.emit({
      instanceName: 'test-instance',
      origin: 'TestOrigin',
      event: 'messages.upsert',
      data: { id: 'msg-nack' },
      serverUrl: 'http://localhost:8080',
      dateTime: '2026-11-22T00:00:00.000Z',
      sender: '5511999999999@s.whatsapp.net',
    });

    const emitErrors = loggedErrors.filter((e) => e.local === 'RabbitmqController.emit');
    assert.equal(mockChannel.publishCalls.length, 3);
    assert.equal(emitErrors.length, 3);
    assert.match(emitErrors[0].message, /attempt 1\/3/);
    assert.match(emitErrors[2].message, /attempt 3\/3/);
    assert.equal(emitErrors[0].error, 'Message nacked by broker');
    assert.equal(connectionLossHandled, true);
    await new Promise((r) => setImmediate(r));
    assert.equal(controller.amqpChannel, null);
  });

  it('succeeds on retry if first publish is nacked and second is acked', async () => {
    let attempt = 0;
    const mockChannel = createMockConfirmChannel((_call, cb) => {
      attempt++;
      if (attempt === 1) {
        cb(new Error('Transient nack'));
      } else {
        cb(null);
      }
    });
    const mockConnection = createMockConnection(mockChannel);
    mockConnectImpl = (_opts, cb) => cb(null, mockConnection);

    await controller.init();

    let connectionLossHandled = false;
    controller.handleConnectionLoss = () => {
      connectionLossHandled = true;
    };

    await controller.emit({
      instanceName: 'test-instance',
      origin: 'TestOrigin',
      event: 'messages.upsert',
      data: { id: 'msg-retry-ok' },
      serverUrl: 'http://localhost:8080',
      dateTime: '2026-11-22T00:00:00.000Z',
      sender: '5511999999999@s.whatsapp.net',
    });

    assert.equal(mockChannel.publishCalls.length, 2);
    assert.equal(connectionLossHandled, false);
  });

  it('handles channel error and close events by cleaning up and scheduling reconnect', async () => {
    const mockChannel = createMockConfirmChannel();
    const mockConnection = createMockConnection(mockChannel);
    mockConnectImpl = (_opts, cb) => cb(null, mockConnection);

    await controller.init();
    assert.ok(controller.amqpChannel);

    let reconnectScheduled = false;
    controller.scheduleReconnect = () => {
      reconnectScheduled = true;
    };

    mockChannel.emit('error', new Error('Channel protocol error'));
    await new Promise((r) => setImmediate(r));

    assert.equal(controller.amqpChannel, null);
    assert.equal(mockChannel.closeCalls, 1);
    assert.equal(reconnectScheduled, true);
  });

  it('supports global RabbitMQ publishing with { persistent: true } and confirms', async () => {
    const rmqConfig = configService.get('RABBITMQ');
    const prevGlobal = rmqConfig.GLOBAL_ENABLED;
    rmqConfig.GLOBAL_ENABLED = true;

    try {
      const mockChannel = createMockConfirmChannel((_call, cb) => cb(null));
      const mockConnection = createMockConnection(mockChannel);
      mockConnectImpl = (_opts, cb) => cb(null, mockConnection);

      await controller.init();
      controller.get = async () => ({ enabled: false, events: [] });

      await controller.emit({
        instanceName: 'test-instance',
        origin: 'TestOrigin',
        event: 'messages.upsert',
        data: { id: 'msg-global' },
        serverUrl: 'http://localhost:8080',
        dateTime: '2026-11-22T00:00:00.000Z',
        sender: '5511999999999@s.whatsapp.net',
      });

      assert.equal(mockChannel.publishCalls.length, 1);
      assert.equal(mockChannel.publishCalls[0].exchange, 'evolution_exchange');
      assert.deepEqual(mockChannel.publishCalls[0].options, { persistent: true });
    } finally {
      rmqConfig.GLOBAL_ENABLED = prevGlobal;
    }
  });

  it('waits for drain event on backpressure (publish returns false) and cleans up listeners', async () => {
    const mockChannel = createMockConfirmChannel((_call, cb) => {
      cb(null);
      return false;
    });
    const mockConnection = createMockConnection(mockChannel);
    mockConnectImpl = (_opts, cb) => cb(null, mockConnection);

    await controller.init();

    const baseErrorListeners = mockChannel.listenerCount('error');
    const baseCloseListeners = mockChannel.listenerCount('close');

    let resolved = false;
    const emitPromise = controller
      .emit({
        instanceName: 'test-instance',
        origin: 'TestOrigin',
        event: 'messages.upsert',
        data: { id: 'msg-drain' },
        serverUrl: 'http://localhost:8080',
        dateTime: '2026-11-22T00:00:00.000Z',
        sender: '5511999999999@s.whatsapp.net',
      })
      .then(() => {
        resolved = true;
      });

    await new Promise((r) => setImmediate(r));
    assert.equal(resolved, false);
    assert.equal(mockChannel.listenerCount('drain'), 1);

    mockChannel.emit('drain');
    await emitPromise;

    assert.equal(resolved, true);
    assert.equal(mockChannel.listenerCount('drain'), 0);
    assert.equal(mockChannel.listenerCount('error'), baseErrorListeners);
    assert.equal(mockChannel.listenerCount('close'), baseCloseListeners);
  });

  it('aborts retries immediately when amqpChannel becomes null during failure', async () => {
    const mockChannel = createMockConfirmChannel((_call, cb) => {
      // Simulate channel loss nulling amqpChannel during the first attempt
      controller.amqpChannel = null;
      cb(new Error('Channel closed mid-publish'));
    });
    const mockConnection = createMockConnection(mockChannel);
    mockConnectImpl = (_opts, cb) => cb(null, mockConnection);

    await controller.init();

    const loggedErrors: any[] = [];
    controller.logger = {
      info: () => {},
      warn: () => {},
      log: () => {},
      error: (err: any) => loggedErrors.push(err),
    };

    await controller.emit({
      instanceName: 'test-instance',
      origin: 'TestOrigin',
      event: 'messages.upsert',
      data: { id: 'msg-abort' },
      serverUrl: 'http://localhost:8080',
      dateTime: '2026-11-22T00:00:00.000Z',
      sender: '5511999999999@s.whatsapp.net',
    });

    const emitErrors = loggedErrors.filter((e) => e.local === 'RabbitmqController.emit');
    assert.equal(mockChannel.publishCalls.length, 1);
    assert.equal(emitErrors.length, 1);
    assert.match(emitErrors[0].message, /attempt 1\/3/);
  });

  it('nulls amqpChannel before awaiting channel.close() in cleanup()', async () => {
    const mockChannel = createMockConfirmChannel();
    let channelDuringClose: any = 'not-checked';
    mockChannel.close = async () => {
      mockChannel.closeCalls++;
      channelDuringClose = controller.amqpChannel;
    };
    const mockConnection = createMockConnection(mockChannel);
    mockConnectImpl = (_opts, cb) => cb(null, mockConnection);

    await controller.init();
    assert.ok(controller.amqpChannel);

    await controller.cleanup();

    assert.equal(mockChannel.closeCalls, 1);
    assert.equal(channelDuringClose, null);
    assert.equal(controller.amqpChannel, null);
  });
});
