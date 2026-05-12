import { JSONSchema7, JSONSchema7Definition } from 'json-schema';
import { v4 } from 'uuid';

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

const numberDefinition: JSONSchema7Definition = {
  type: 'string',
  description: 'Invalid format',
};

export const templateMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    name: { type: 'string' },
    language: { type: 'string' },
    components: { type: 'array' },
    webhookUrl: { type: 'string' },
  },
  required: ['name', 'language'],
};

const quotedOptionsSchema: JSONSchema7 = {
  properties: {
    key: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        remoteJid: { type: 'string' },
        fromMe: { type: 'boolean', enum: [true, false] },
      },
      required: ['id'],
      ...isNotEmpty('id'),
    },
    message: { type: 'object' },
  },
};

export const offerCallSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    isVideo: { type: 'boolean', enum: [true, false] },
    callDuration: { type: 'integer', minimum: 1, maximum: 15 },
  },
  required: ['number', 'callDuration'],
};

export const textMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    text: { type: 'string' },
    linkPreview: { type: 'boolean' },
    delay: {
      type: 'integer',
      description: 'Enter a value in milliseconds',
    },
    quoted: { ...quotedOptionsSchema },
    mentionsEveryOne: { type: 'boolean', enum: [true, false] },
    mentioned: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^\\d+',
        description: '"mentioned" must be an array of numeric strings',
      },
    },
  },
  required: ['number', 'text'],
};

export const mediaMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    mediatype: { type: 'string', enum: ['image', 'document', 'video', 'audio'] },
    mimetype: { type: 'string' },
    media: { type: 'string' },
    fileName: { type: 'string' },
    caption: { type: 'string' },
    gifPlayback: {
      oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['true', 'false'] }],
    },
    gifAttribution: {
      oneOf: [
        { type: 'integer', enum: [0, 1, 2] },
        { type: 'string', enum: ['0', '1', '2'] },
      ],
    },
    delay: {
      type: 'integer',
      description: 'Enter a value in milliseconds',
    },
    quoted: { ...quotedOptionsSchema },
    mentionsEveryOne: { type: 'boolean', enum: [true, false] },
    mentioned: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^\\d+',
        description: '"mentioned" must be an array of numeric strings',
      },
    },
  },
  required: ['number', 'mediatype'],
};

export const ptvMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    video: { type: 'string' },
    delay: {
      type: 'integer',
      description: 'Enter a value in milliseconds',
    },
    quoted: { ...quotedOptionsSchema },
    mentionsEveryOne: { type: 'boolean', enum: [true, false] },
    mentioned: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^\\d+',
        description: '"mentioned" must be an array of numeric strings',
      },
    },
  },
  required: ['number'],
};

export const audioMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    audio: { type: 'string' },
    delay: {
      type: 'integer',
      description: 'Enter a value in milliseconds',
    },
    quoted: { ...quotedOptionsSchema },
    mentionsEveryOne: { type: 'boolean', enum: [true, false] },
    mentioned: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^\\d+',
        description: '"mentioned" must be an array of numeric strings',
      },
    },
  },
  required: ['number'],
};

export const statusMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['text', 'image', 'audio', 'video'] },
    content: { type: 'string' },
    caption: { type: 'string' },
    backgroundColor: { type: 'string' },
    font: { type: 'integer', minimum: 0, maximum: 5 },
    statusJidList: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^\\d+',
        description: '"statusJidList" must be an array of numeric strings',
      },
    },
    allContacts: { type: 'boolean', enum: [true, false] },
  },
  required: ['type'],
};

export const stickerMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    sticker: { type: 'string' },
    delay: {
      type: 'integer',
      description: 'Enter a value in milliseconds',
    },
    quoted: { ...quotedOptionsSchema },
    mentionsEveryOne: { type: 'boolean', enum: [true, false] },
    mentioned: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^\\d+',
        description: '"mentioned" must be an array of numeric strings',
      },
    },
  },
  required: ['number'],
};

export const locationMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    latitude: { type: 'number' },
    longitude: { type: 'number' },
    name: { type: 'string' },
    address: { type: 'string' },
    delay: {
      type: 'integer',
      description: 'Enter a value in milliseconds',
    },
    quoted: { ...quotedOptionsSchema },
    mentionsEveryOne: { type: 'boolean', enum: [true, false] },
    mentioned: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^\\d+',
        description: '"mentioned" must be an array of numeric strings',
      },
    },
  },
  required: ['number', 'latitude', 'longitude', 'name', 'address'],
};

export const contactMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    contact: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fullName: { type: 'string' },
          wuid: {
            type: 'string',
            minLength: 10,
            pattern: '\\d+',
            description: '"wuid" must be a numeric string',
          },
          phoneNumber: { type: 'string', minLength: 10 },
          organization: { type: 'string' },
          email: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['fullName', 'phoneNumber'],
        ...isNotEmpty('fullName'),
      },
      minItems: 1,
      uniqueItems: true,
    },
  },
  required: ['number', 'contact'],
};

export const reactionMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    key: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        remoteJid: { type: 'string' },
        fromMe: { type: 'boolean', enum: [true, false] },
      },
      required: ['id', 'remoteJid', 'fromMe'],
      ...isNotEmpty('id', 'remoteJid'),
    },
    reaction: { type: 'string' },
  },
  required: ['key', 'reaction'],
};

export const pollMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    name: { type: 'string' },
    selectableCount: { type: 'integer', minimum: 0, maximum: 10 },
    values: {
      type: 'array',
      minItems: 2,
      maxItems: 10,
      uniqueItems: true,
      items: {
        type: 'string',
      },
    },
    delay: {
      type: 'integer',
      description: 'Enter a value in milliseconds',
    },
    quoted: { ...quotedOptionsSchema },
    mentionsEveryOne: { type: 'boolean', enum: [true, false] },
    mentioned: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^\\d+',
        description: '"mentioned" must be an array of numeric strings',
      },
    },
  },
  required: ['number', 'name', 'selectableCount', 'values'],
};

export const listMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    title: { type: 'string' },
    description: { type: 'string' },
    footerText: { type: 'string' },
    buttonText: { type: 'string' },
    sections: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          rows: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                rowId: { type: 'string' },
              },
              required: ['title', 'rowId'],
              ...isNotEmpty('title', 'description', 'rowId'),
            },
          },
        },
        required: ['title', 'rows'],
        ...isNotEmpty('title'),
      },
    },
    delay: {
      type: 'integer',
      description: 'Enter a value in milliseconds',
    },
    quoted: { ...quotedOptionsSchema },
    mentionsEveryOne: { type: 'boolean', enum: [true, false] },
    mentioned: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^\\d+',
        description: '"mentioned" must be an array of numeric strings',
      },
    },
  },
  required: ['number', 'title', 'footerText', 'buttonText', 'sections'],
};

export const buttonsMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    thumbnailUrl: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    footer: { type: 'string' },
    buttons: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['reply', 'copy', 'url', 'call', 'pix'],
          },
          displayText: { type: 'string' },
          id: { type: 'string' },
          url: { type: 'string' },
          phoneNumber: { type: 'string' },
          currency: { type: 'string' },
          name: { type: 'string' },
          keyType: { type: 'string', enum: ['phone', 'email', 'cpf', 'cnpj', 'random'] },
          key: { type: 'string' },
        },
        required: ['type'],
        ...isNotEmpty('id', 'url', 'phoneNumber'),
      },
    },
    delay: {
      type: 'integer',
      description: 'Enter a value in milliseconds',
    },
    quoted: { ...quotedOptionsSchema },
    mentionsEveryOne: { type: 'boolean', enum: [true, false] },
    mentioned: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^\\d+',
        description: '"mentioned" must be an array of numeric strings',
      },
    },
  },
  required: ['number'],
};

export const carouselMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    body: { type: 'string', minLength: 1 },
    cards: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string', minLength: 1 },
          footer: { type: 'string' },
          imageUrl: { type: 'string' },
          buttons: {
            type: 'array',
            minItems: 1,
            maxItems: 3,
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['reply', 'copy', 'url', 'call'] },
                displayText: { type: 'string' },
                id: { type: 'string' },
                url: { type: 'string' },
                copyCode: { type: 'string' },
                phoneNumber: { type: 'string' },
              },
              required: ['type'],
              ...isNotEmpty('id', 'url', 'phoneNumber'),
            },
          },
        },
        required: ['body', 'buttons'],
      },
    },
    delay: {
      type: 'integer',
      description: 'Enter a value in milliseconds',
    },
    quoted: { ...quotedOptionsSchema },
    everyOne: { type: 'boolean', enum: [true, false] },
    mentioned: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^\\d+',
        description: '"mentioned" must be an array of numeric strings',
      },
    },
  },
  required: ['number', 'body', 'cards'],
};

export const decryptPollVoteSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    message: {
      type: 'object',
      properties: {
        key: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
      },
      required: ['key'],
    },
    remoteJid: { type: 'string' },
  },
  required: ['message', 'remoteJid'],
};
