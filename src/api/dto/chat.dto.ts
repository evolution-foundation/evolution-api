import {
  proto,
  WAPresence,
  WAPrivacyGroupAddValue,
  WAPrivacyOnlineValue,
  WAPrivacyValue,
  WAReadReceiptsValue,
} from 'baileys';

export class OnWhatsAppDto {
  constructor(
    public readonly jid: string,
    public readonly exists: boolean,
    public readonly number: string,
    public readonly name?: string,
    public readonly lid?: string,
  ) {}
}

export class getBase64FromMediaMessageDto {
  message: proto.WebMessageInfo;
  convertToMp4?: boolean;
}

export class WhatsAppNumberDto {
  numbers: string[];
  /** Opt-in: add each confirmed number's WhatsApp LID (`<digits>@lid` or null) to the response. */
  includeLid?: boolean;
}

export class NumberDto {
  number: string;
}

export class NumberBusiness {
  wid?: string;
  jid?: string;
  exists?: boolean;
  isBusiness: boolean;
  name?: string;
  message?: string;
  description?: string;
  email?: string;
  websites?: string[];
  website?: string[];
  address?: string;
  about?: string;
  vertical?: string;
  profilehandle?: string;
}

export class ProfileNameDto {
  name: string;
}

export class ProfileStatusDto {
  status: string;
}

export class ProfilePictureDto {
  number?: string;
  // url or base64
  picture?: string;
}

class Key {
  id: string;
  fromMe: boolean;
  remoteJid: string;
  /**
   * Group receipts address the sender, not the chat: Baileys aggregates read
   * receipts by `remoteJid:participant` and rejects a markRead range whose
   * not-from-me group key has no participant. Round-trip whatever the provider
   * gave us in the original key.
   */
  participant?: string;
}
export class ReadMessageDto {
  readMessages: Key[];
  lastMessage?: { key: Key; messageTimestamp: number };
}

export class LastMessage {
  key: Key;
  messageTimestamp?: number;
}

export class ArchiveChatDto {
  lastMessage?: LastMessage;
  chat?: string;
  archive: boolean;
}

export class MarkChatUnreadDto {
  lastMessage?: LastMessage;
  chat?: string;
}

export class PrivacySettingDto {
  readreceipts: WAReadReceiptsValue;
  profile: WAPrivacyValue;
  status: WAPrivacyValue;
  online: WAPrivacyOnlineValue;
  last: WAPrivacyValue;
  groupadd: WAPrivacyGroupAddValue;
}

export class DeleteMessage {
  id: string;
  fromMe: boolean;
  remoteJid: string;
  participant?: string;
}
export class Options {
  delay?: number;
  presence?: WAPresence;
}
class OptionsMessage {
  options: Options;
}
export class Metadata extends OptionsMessage {
  number: string;
}

export class SendPresenceDto extends Metadata {
  presence: WAPresence;
  delay: number;
}

export class UpdateMessageDto extends Metadata {
  number: string;
  key: proto.IMessageKey;
  text: string;
}

export class BlockUserDto {
  number: string;
  status: 'block' | 'unblock';
}
