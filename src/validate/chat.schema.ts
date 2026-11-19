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

export const whatsappNumberSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    numbers: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        description: '"numbers" must be an array of numeric strings',
      },
    },
  },
};

export const readMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    readMessages: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        properties: {
          id: { type: 'string' },
          fromMe: { type: 'boolean', enum: [true, false] },
          remoteJid: { type: 'string' },
        },
        required: ['id', 'fromMe', 'remoteJid'],
        ...isNotEmpty('id', 'remoteJid'),
      },
    },
  },
  required: ['readMessages'],
};

export const archiveChatSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    chat: { type: 'string' },
    lastMessage: {
      type: 'object',
      properties: {
        key: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            remoteJid: { type: 'string' },
            fromMe: { type: 'boolean', enum: [true, false] },
          },
          required: ['id', 'fromMe', 'remoteJid'],
          ...isNotEmpty('id', 'remoteJid'),
        },
        messageTimestamp: { type: 'integer', minLength: 1 },
      },
      required: ['key'],
      ...isNotEmpty('messageTimestamp'),
    },
    archive: { type: 'boolean', enum: [true, false] },
  },
  required: ['archive'],
};

export const markChatUnreadSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    chat: { type: 'string' },
    lastMessage: {
      type: 'object',
      properties: {
        key: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            remoteJid: { type: 'string' },
            fromMe: { type: 'boolean', enum: [true, false] },
          },
          required: ['id', 'fromMe', 'remoteJid'],
          ...isNotEmpty('id', 'remoteJid'),
        },
        messageTimestamp: { type: 'integer', minLength: 1 },
      },
      required: ['key'],
      ...isNotEmpty('messageTimestamp'),
    },
  },
  required: ['lastMessage'],
};

export const deleteMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    id: { type: 'string' },
    fromMe: { type: 'boolean', enum: [true, false] },
    remoteJid: { type: 'string' },
    participant: { type: 'string' },
  },
  required: ['id', 'fromMe', 'remoteJid'],
  ...isNotEmpty('id', 'remoteJid', 'participant'),
};

export const profilePictureSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { type: 'string' },
    picture: { type: 'string' },
  },
};

export const updateMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { type: 'string' },
    text: { type: 'string' },
    key: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        remoteJid: { type: 'string' },
        fromMe: { type: 'boolean', enum: [true, false] },
      },
      required: ['id', 'fromMe', 'remoteJid'],
      ...isNotEmpty('id', 'remoteJid'),
    },
  },
  ...isNotEmpty('number', 'text', 'key'),
};

export const presenceSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    delay: { type: 'number' },
    presence: {
      type: 'string',
      enum: ['unavailable', 'available', 'composing', 'recording', 'paused'],
    },
  },
  required: ['number', 'presence', 'delay'],
};

export const blockUserSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { type: 'string' },
    status: { type: 'string', enum: ['block', 'unblock'] },
  },
  required: ['number', 'status'],
  ...isNotEmpty('number', 'status'),
};

export const contactValidateSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    where: {
      type: 'object',
      properties: {
        _id: { type: 'string', minLength: 1 },
        pushName: { type: 'string', minLength: 1 },
        id: { type: 'string', minLength: 1 },
        remoteJid: { type: 'string', minLength: 1 },
      },
      ...isNotEmpty('_id', 'id', 'pushName', 'remoteJid'),
    },
  },
};

export const messageValidateSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    where: {
      type: 'object',
      properties: {
        _id: { type: 'string', minLength: 1 },
        key: {
          type: 'object',
          if: {
            propertyNames: {
              enum: ['fromMe', 'remoteJid', 'id'],
            },
          },
          then: {
            properties: {
              remoteJid: {
                type: 'string',
                minLength: 1,
                description: 'The property cannot be empty',
              },
              id: {
                type: 'string',
                minLength: 1,
                description: 'The property cannot be empty',
              },
              fromMe: { type: 'boolean', enum: [true, false] },
            },
          },
        },
        message: { type: 'object' },
      },
      ...isNotEmpty('_id'),
    },
    limit: { type: 'integer' },
  },
};

export const messageUpSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    where: {
      type: 'object',
      properties: {
        _id: { type: 'string' },
        remoteJid: { type: 'string' },
        id: { type: 'string' },
        fromMe: { type: 'boolean', enum: [true, false] },
        participant: { type: 'string' },
        status: {
          type: 'string',
          enum: ['ERROR', 'PENDING', 'SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED'],
        },
      },
      ...isNotEmpty('_id', 'remoteJid', 'id', 'status'),
    },
    limit: { type: 'integer' },
  },
};

export const privacySettingsSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    readreceipts: { type: 'string', enum: ['all', 'none'] },
    profile: {
      type: 'string',
      enum: ['all', 'contacts', 'contact_blacklist', 'none'],
    },
    status: {
      type: 'string',
      enum: ['all', 'contacts', 'contact_blacklist', 'none'],
    },
    online: { type: 'string', enum: ['all', 'match_last_seen'] },
    last: { type: 'string', enum: ['all', 'contacts', 'contact_blacklist', 'none'] },
    groupadd: {
      type: 'string',
      enum: ['all', 'contacts', 'contact_blacklist', 'none'],
    },
  },
  required: ['readreceipts', 'profile', 'status', 'online', 'last', 'groupadd'],
  ...isNotEmpty('readreceipts', 'profile', 'status', 'online', 'last', 'groupadd'),
};

export const profileNameSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    name: { type: 'string' },
  },
  ...isNotEmpty('name'),
};

export const profileStatusSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    status: { type: 'string' },
  },
  ...isNotEmpty('status'),
};

export const profileSchema: JSONSchema7 = {
  type: 'object',
  properties: {
    wuid: { type: 'string' },
    name: { type: 'string' },
    picture: { type: 'string' },
    status: { type: 'string' },
    isBusiness: { type: 'boolean' },
  },
};
