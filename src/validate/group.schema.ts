import { JSONSchema7 } from 'json-schema';
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

export const createGroupSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    subject: { type: 'string' },
    description: { type: 'string' },
    profilePicture: { type: 'string' },
    promoteParticipants: { type: 'boolean', enum: [true, false] },
    participants: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        minLength: 10,
        pattern: '\\d+',
        description: '"participants" must be an array of numeric strings',
      },
    },
  },
  required: ['subject', 'participants'],
  ...isNotEmpty('subject', 'description', 'profilePicture'),
};

export const groupJidSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    groupJid: { type: 'string', pattern: '^[\\d-]+@g.us$' },
  },
  required: ['groupJid'],
  ...isNotEmpty('groupJid'),
};

export const getParticipantsSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    getParticipants: { type: 'string', enum: ['true', 'false'] },
  },
  required: ['getParticipants'],
  ...isNotEmpty('getParticipants'),
};

export const groupSendInviteSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    groupJid: { type: 'string' },
    description: { type: 'string' },
    numbers: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        minLength: 10,
        pattern: '\\d+',
        description: '"numbers" must be an array of numeric strings',
      },
    },
  },
  required: ['groupJid', 'description', 'numbers'],
  ...isNotEmpty('groupJid', 'description', 'numbers'),
};

export const groupInviteSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    inviteCode: { type: 'string', pattern: '^[a-zA-Z0-9]{22}$' },
  },
  required: ['inviteCode'],
  ...isNotEmpty('inviteCode'),
};

export const AcceptGroupInviteSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    inviteCode: { type: 'string', pattern: '^[a-zA-Z0-9]{22}$' },
  },
  required: ['inviteCode'],
  ...isNotEmpty('inviteCode'),
};

export const updateParticipantsSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    groupJid: { type: 'string' },
    action: {
      type: 'string',
      enum: ['add', 'remove', 'promote', 'demote'],
    },
    participants: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        minLength: 10,
        pattern: '\\d+',
        description: '"participants" must be an array of numeric strings',
      },
    },
  },
  required: ['groupJid', 'action', 'participants'],
  ...isNotEmpty('groupJid', 'action'),
};

export const updateSettingsSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    groupJid: { type: 'string' },
    action: {
      type: 'string',
      enum: ['announcement', 'not_announcement', 'locked', 'unlocked'],
    },
  },
  required: ['groupJid', 'action'],
  ...isNotEmpty('groupJid', 'action'),
};

export const toggleEphemeralSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    groupJid: { type: 'string' },
    expiration: {
      type: 'number',
      enum: [0, 86400, 604800, 7776000],
    },
  },
  required: ['groupJid', 'expiration'],
  ...isNotEmpty('groupJid', 'expiration'),
};

export const memberAddModeSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    groupJid: { type: 'string' },
    mode: { type: 'string', enum: ['admin_add', 'all_member_add'] },
  },
  required: ['groupJid', 'mode'],
  ...isNotEmpty('groupJid', 'mode'),
};

export const joinApprovalModeSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    groupJid: { type: 'string' },
    mode: { type: 'string', enum: ['on', 'off'] },
  },
  required: ['groupJid', 'mode'],
  ...isNotEmpty('groupJid', 'mode'),
};

export const updateParticipantRequestSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    groupJid: { type: 'string' },
    action: { type: 'string', enum: ['approve', 'reject'] },
    participants: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string' },
    },
  },
  required: ['groupJid', 'action', 'participants'],
  ...isNotEmpty('groupJid', 'action'),
};

export const updateGroupPictureSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    groupJid: { type: 'string' },
    image: { type: 'string' },
  },
  required: ['groupJid', 'image'],
  ...isNotEmpty('groupJid', 'image'),
};

export const updateGroupSubjectSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    groupJid: { type: 'string' },
    subject: { type: 'string' },
  },
  required: ['groupJid', 'subject'],
  ...isNotEmpty('groupJid', 'subject'),
};

export const updateGroupDescriptionSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    groupJid: { type: 'string' },
    description: { type: 'string' },
  },
  required: ['groupJid', 'description'],
  ...isNotEmpty('groupJid', 'description'),
};
