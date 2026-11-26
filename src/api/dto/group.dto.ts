export class CreateGroupDto {
  subject: string;
  participants: string[];
  description?: string;
  promoteParticipants?: boolean;
}

export class GroupPictureDto {
  groupJid: string;
  image: string;
}

export class GroupSubjectDto {
  groupJid: string;
  subject: string;
}

export class GroupDescriptionDto {
  groupJid: string;
  description: string;
}

export class GroupJid {
  groupJid: string;
}

export class GetParticipant {
  getParticipants: string;
}

export class GroupInvite {
  inviteCode: string;
}

export class AcceptGroupInvite {
  inviteCode: string;
}

export class GroupSendInvite {
  groupJid: string;
  description: string;
  numbers: string[];
}

export class GroupUpdateParticipantDto extends GroupJid {
  action: 'add' | 'remove' | 'promote' | 'demote';
  participants: string[];
  /** Sends a private invite when an add action is blocked by WhatsApp privacy settings. */
  inviteOnAddFailure?: boolean;
  /** Optional caption used for the private invite message. */
  inviteCaption?: string;
}

export class GroupUpdateSettingDto extends GroupJid {
  action: 'announcement' | 'not_announcement' | 'unlocked' | 'locked';
}

export class GroupToggleEphemeralDto extends GroupJid {
  expiration: 0 | 86400 | 604800 | 7776000;
}
