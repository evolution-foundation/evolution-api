import { JSONSchema7 } from 'json-schema';
import { v4 } from 'uuid';

import { EventController } from '../event.controller';

export const kafkaSchema: JSONSchema7 = {
  $id: v4(),
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
};
