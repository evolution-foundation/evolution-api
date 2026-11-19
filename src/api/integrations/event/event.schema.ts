import { JSONSchema7 } from 'json-schema';
import { v4 } from 'uuid';

import { EventController } from './event.controller';

export * from '@api/integrations/event/pusher/pusher.schema';
export * from '@api/integrations/event/webhook/webhook.schema';

export const eventSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    websocket: {
      $ref: '#/$defs/event',
    },
    rabbitmq: {
      $ref: '#/$defs/event',
    },
    nats: {
      $ref: '#/$defs/event',
    },
    sqs: {
      $ref: '#/$defs/event',
    },
    kafka: {
      $ref: '#/$defs/event',
    },
  },
  $defs: {
    event: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', enum: [true, false] },
        events: {
          type: 'array',
          minItems: 0,
          items: {
            type: 'string',
            enum: EventController.events,
          },
        },
      },
      required: ['enabled'],
    },
  },
};
