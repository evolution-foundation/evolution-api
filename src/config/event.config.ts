import { configService, EventEmitter as EventEmitterConfig } from '@config/env.config';
import EventEmitter2 from 'eventemitter2';

const eventEmitterConfig = configService.get<EventEmitterConfig>('EVENT_EMITTER');

export const eventEmitter = new EventEmitter2({
  delimiter: '.',
  newListener: false,
  ignoreErrors: false,
  maxListeners: eventEmitterConfig.MAX_LISTENERS,
});
