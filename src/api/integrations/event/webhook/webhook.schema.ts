import { JSONSchema7 } from 'json-schema';
import { v4 } from 'uuid';

import { EventController } from '../event.controller';

const isNotEmpty = (...propertyNames: string[]): JSONSchema7 => {
  const properties = {};
  propertyNames.forEach(
    (property) =>
      (properties[property] = {
        minLength: 1,
        description: `The "${property}" cannot be empty`,
      }),
  );
  return {
    if: {
      propertyNames: {
        enum: [...propertyNames],
      },
    },
    then: { properties },
  };
};

export const webhookSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    webhook: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        url: { type: 'string' },
        headers: { type: 'object' },
        byEvents: { type: 'boolean' },
        base64: { type: 'boolean' },
        excludeFields: {
          type: 'array',
          minItems: 0,
          items: {
            type: 'string',
            minLength: 1,
          },
        },
        includeFields: {
          type: 'array',
          minItems: 0,
          items: {
            type: 'string',
            minLength: 1,
          },
        },
        events: {
          type: 'array',
          minItems: 0,
          items: {
            type: 'string',
            enum: EventController.events,
          },
        },
      },
      required: ['enabled', 'url'],
      ...isNotEmpty('enabled', 'url'),
    },
  },
  required: ['webhook'],
};
