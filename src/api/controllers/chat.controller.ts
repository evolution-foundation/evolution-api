import {
  ArchiveChatDto,
  BlockUserDto,
  DecryptPollVoteDto,
  DeleteMessage,
  getBase64FromMediaMessageDto,
  MarkChatUnreadDto,
  MarkMessageAsPlayedDto,
  NumberDto,
  PrivacySettingDto,
  ProfileNameDto,
  ProfilePictureDto,
  ProfileStatusDto,
  ReadMessageDto,
  SendPresenceDto,
  UpdateMessageDto,
  WhatsAppNumberDto,
} from '@api/dto/chat.dto';
import { InstanceDto } from '@api/dto/instance.dto';
import { Query } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Contact, Message, MessageUpdate } from '@prisma/client';

export class ChatController {
  constructor(private readonly waMonitor: WAMonitoringService) {}

  public async whatsappNumber({ instanceName }: InstanceDto, data: WhatsAppNumberDto) {
    return await this.waMonitor.waInstances[instanceName].whatsappNumber(data);
  }

  public async readMessage({ instanceName }: InstanceDto, data: ReadMessageDto) {
    return await this.waMonitor.waInstances[instanceName].markMessageAsRead(data);
  }

  public async markMessageAsPlayed({ instanceName }: InstanceDto, data: MarkMessageAsPlayedDto) {
    return await this.waMonitor.waInstances[instanceName].markMessageAsPlayed(data);
  }

  public async archiveChat({ instanceName }: InstanceDto, data: ArchiveChatDto) {
    return await this.waMonitor.waInstances[instanceName].archiveChat(data);
  }

  public async markChatUnread({ instanceName }: InstanceDto, data: MarkChatUnreadDto) {
    return await this.waMonitor.waInstances[instanceName].markChatUnread(data);
  }

  public async deleteMessage({ instanceName }: InstanceDto, data: DeleteMessage) {
    return await this.waMonitor.waInstances[instanceName].deleteMessage(data);
  }

  public async fetchProfilePicture({ instanceName }: InstanceDto, data: NumberDto) {
    return await this.waMonitor.waInstances[instanceName].profilePicture(data.number);
  }

  public async fetchProfile({ instanceName }: InstanceDto, data: NumberDto) {
    return await this.waMonitor.waInstances[instanceName].fetchProfile(instanceName, data.number);
  }

  public async fetchLid({ instanceName }: InstanceDto, data: NumberDto) {
    return await this.waMonitor.waInstances[instanceName].getLid(data.number);
  }

  public async fetchContacts({ instanceName }: InstanceDto, query: Query<Contact>) {
    return await this.waMonitor.waInstances[instanceName].fetchContacts(query);
  }

  public async getBase64FromMediaMessage({ instanceName }: InstanceDto, data: getBase64FromMediaMessageDto) {
    return await this.waMonitor.waInstances[instanceName].getBase64FromMediaMessage(data);
  }

  public async fetchMessages({ instanceName }: InstanceDto, query: Query<Message>) {
    return await this.waMonitor.waInstances[instanceName].fetchMessages(query);
  }

  public async fetchStatusMessage({ instanceName }: InstanceDto, query: Query<MessageUpdate>) {
    return await this.waMonitor.waInstances[instanceName].fetchStatusMessage(query);
  }

  public async fetchChats({ instanceName }: InstanceDto, query: Query<Contact>) {
    return await this.waMonitor.waInstances[instanceName].fetchChats(query);
  }

  public async findChatByRemoteJid({ instanceName }: InstanceDto, remoteJid: string) {
    return await this.waMonitor.waInstances[instanceName].findChatByRemoteJid(remoteJid);
  }

  public async sendPresence({ instanceName }: InstanceDto, data: SendPresenceDto) {
    return await this.waMonitor.waInstances[instanceName].sendPresence(data);
  }

  public async fetchPrivacySettings({ instanceName }: InstanceDto) {
    return await this.waMonitor.waInstances[instanceName].fetchPrivacySettings();
  }

  public async updatePrivacySettings({ instanceName }: InstanceDto, data: PrivacySettingDto) {
    return await this.waMonitor.waInstances[instanceName].updatePrivacySettings(data);
  }

  public async fetchBusinessProfile({ instanceName }: InstanceDto, data: ProfilePictureDto) {
    return await this.waMonitor.waInstances[instanceName].fetchBusinessProfile(data.number);
  }

  public async updateProfileName({ instanceName }: InstanceDto, data: ProfileNameDto) {
    return await this.waMonitor.waInstances[instanceName].updateProfileName(data.name);
  }

  public async updateProfileStatus({ instanceName }: InstanceDto, data: ProfileStatusDto) {
    return await this.waMonitor.waInstances[instanceName].updateProfileStatus(data.status);
  }

  public async updateProfilePicture({ instanceName }: InstanceDto, data: ProfilePictureDto) {
    return await this.waMonitor.waInstances[instanceName].updateProfilePicture(data.picture);
  }

  public async removeProfilePicture({ instanceName }: InstanceDto) {
    return await this.waMonitor.waInstances[instanceName].removeProfilePicture();
  }

  public async updateMessage({ instanceName }: InstanceDto, data: UpdateMessageDto) {
    return await this.waMonitor.waInstances[instanceName].updateMessage(data);
  }

  public async blockUser({ instanceName }: InstanceDto, data: BlockUserDto) {
    return await this.waMonitor.waInstances[instanceName].blockUser(data);
  }

  public async decryptPollVote({ instanceName }: InstanceDto, data: DecryptPollVoteDto) {
    const pollCreationMessageKey = {
      id: data.message.key.id,
      remoteJid: data.remoteJid,
    };
    return await this.waMonitor.waInstances[instanceName].baileysDecryptPollVote(pollCreationMessageKey);
  }

  public async fetchChannels({ instanceName }: InstanceDto, query: Query<Contact>) {
    return await this.waMonitor.waInstances[instanceName].fetchChannels(query);
  }
}
