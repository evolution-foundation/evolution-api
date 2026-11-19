import { InstanceDto } from '@api/dto/instance.dto';
import {
  MediaMessage,
  Options,
  SendAudioDto,
  SendButtonsDto,
  SendMediaDto,
  SendTextDto,
} from '@api/dto/sendMessage.dto';
import * as s3Service from '@api/integrations/storage/s3/libs/minio.server';
import { PrismaRepository } from '@api/repository/repository.service';
import { chatbotController } from '@api/server.module';
import { CacheService } from '@api/services/cache.service';
import { ChannelStartupService } from '@api/services/channel.service';
import { Events, wa } from '@api/types/wa.types';
import { AudioConverter, Chatwoot, ConfigService, Openai, S3 } from '@config/env.config';
import { BadRequestException, InternalServerErrorException } from '@exceptions';
import { createJid } from '@utils/createJid';
import { sendTelemetry } from '@utils/sendTelemetry';
import axios from 'axios';
import { isBase64, isURL } from 'class-validator';
import EventEmitter2 from 'eventemitter2';
import FormData from 'form-data';
import mimeTypes from 'mime-types';
import { join } from 'path';
import { v4 } from 'uuid';

export class EvolutionStartupService extends ChannelStartupService {
  constructor(
    public readonly configService: ConfigService,
    public readonly eventEmitter: EventEmitter2,
    public readonly prismaRepository: PrismaRepository,
    public readonly cache: CacheService,
    public readonly chatwootCache: CacheService,
  ) {
    super(configService, eventEmitter, prismaRepository, chatwootCache);

    this.client = null;
  }

  public client: any;

  public stateConnection: wa.StateConnection = { state: 'open' };

  public phoneNumber: string;
  public mobile: boolean;

  public get connectionStatus() {
    return this.stateConnection;
  }

  public async closeClient() {
    this.stateConnection = { state: 'close' };
  }

  public get qrCode(): wa.QrCode {
    return {
      pairingCode: this.instance.qrcode?.pairingCode,
      code: this.instance.qrcode?.code,
      base64: this.instance.qrcode?.base64,
      count: this.instance.qrcode?.count,
    };
  }

  public async logoutInstance() {
    await this.closeClient();
  }

  public setInstance(instance: InstanceDto) {
    this.logger.setInstance(instance.instanceId);

    this.instance.name = instance.instanceName;
    this.instance.id = instance.instanceId;
    this.instance.integration = instance.integration;
    this.instance.number = instance.number;
    this.instance.token = instance.token;
    this.instance.businessId = instance.businessId;

    if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
      this.chatwootService.eventWhatsapp(
        Events.STATUS_INSTANCE,
        {
          instanceName: this.instance.name,
          instanceId: this.instance.id,
          integration: instance.integration,
        },
        {
          instance: this.instance.name,
          status: 'created',
        },
      );
    }
  }

  public async profilePicture(number: string) {
    const jid = createJid(number);

    return {
      wuid: jid,
      profilePictureUrl: null,
    };
  }

  public async getProfileName() {
    return null;
  }

  public async profilePictureUrl() {
    return null;
  }

  public async getProfileStatus() {
    return null;
  }

  public async connectToWhatsapp(data?: any): Promise<any> {
    if (!data) {
      this.loadChatwoot();
      return;
    }

    try {
      this.eventHandler(data);
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException(error?.toString());
    }
  }

  protected async eventHandler(received: any) {
    try {
      let messageRaw: any;

      if (received.message) {
        const key = {
          id: received.key.id || v4(),
          remoteJid: received.key.remoteJid,
          fromMe: received.key.fromMe,
          profilePicUrl: received.profilePicUrl,
        };
        messageRaw = {
          key,
          pushName: received.pushName,
          message: received.message,
          messageType: received.messageType,
          messageTimestamp: Math.round(new Date().getTime() / 1000),
          source: 'unknown',
          instanceId: this.instanceId,
        };

        const isAudio = received?.message?.audioMessage;

        if (this.configService.get<Openai>('OPENAI').ENABLED && isAudio) {
          const openAiDefaultSettings = await this.prismaRepository.openaiSetting.findFirst({
            where: {
              instanceId: this.instanceId,
            },
            include: {
              OpenaiCreds: true,
            },
          });

          if (
            openAiDefaultSettings &&
            openAiDefaultSettings.openaiCredsId &&
            openAiDefaultSettings.speechToText &&
            received?.message?.audioMessage
          ) {
            messageRaw.message.speechToText = `[audio] ${await this.openaiService.speechToText(received, this)}`;
          }
        }

        this.logger.log(messageRaw);

        sendTelemetry(`received.message.${messageRaw.messageType ?? 'unknown'}`);

        this.sendDataWebhook(Events.MESSAGES_UPSERT, messageRaw);

        await chatbotController.emit({
          instance: { instanceName: this.instance.name, instanceId: this.instanceId },
          remoteJid: messageRaw.key.remoteJid,
          msg: messageRaw,
          pushName: messageRaw.pushName,
        });

        if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
          const chatwootSentMessage = await this.chatwootService.eventWhatsapp(
            Events.MESSAGES_UPSERT,
            { instanceName: this.instance.name, instanceId: this.instanceId },
            messageRaw,
          );

          if (chatwootSentMessage?.id) {
            messageRaw.chatwootMessageId = chatwootSentMessage.id;
            messageRaw.chatwootInboxId = chatwootSentMessage.id;
            messageRaw.chatwootConversationId = chatwootSentMessage.id;
          }
        }

        await this.prismaRepository.message.create({
          data: messageRaw,
        });

        await this.updateContact({
          remoteJid: messageRaw.key.remoteJid,
          pushName: messageRaw.pushName,
          profilePicUrl: received.profilePicUrl,
        });
      }
    } catch (error) {
      this.logger.error(error);
    }
  }

  private async updateContact(data: { remoteJid: string; pushName?: string; profilePicUrl?: string }) {
    const contactRaw: any = {
      remoteJid: data.remoteJid,
      pushName: data?.pushName,
      instanceId: this.instanceId,
      profilePicUrl: data?.profilePicUrl,
    };

    const existingContact = await this.prismaRepository.contact.findFirst({
      where: {
        remoteJid: data.remoteJid,
        instanceId: this.instanceId,
      },
    });

    if (existingContact) {
      await this.prismaRepository.contact.updateMany({
        where: {
          remoteJid: data.remoteJid,
          instanceId: this.instanceId,
        },
        data: contactRaw,
      });
    } else {
      await this.prismaRepository.contact.create({
        data: contactRaw,
      });
    }

    this.sendDataWebhook(Events.CONTACTS_UPSERT, contactRaw);

    if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
      await this.chatwootService.eventWhatsapp(
        Events.CONTACTS_UPDATE,
        {
          instanceName: this.instance.name,
          instanceId: this.instanceId,
          integration: this.instance.integration,
        },
        contactRaw,
      );
    }

    const chat = await this.prismaRepository.chat.findFirst({
      where: { instanceId: this.instanceId, remoteJid: data.remoteJid },
    });

    if (chat) {
      const chatRaw: any = {
        remoteJid: data.remoteJid,
        instanceId: this.instanceId,
      };

      this.sendDataWebhook(Events.CHATS_UPDATE, chatRaw);

      await this.prismaRepository.chat.updateMany({
        where: { remoteJid: chat.remoteJid },
        data: chatRaw,
      });
    }

    const chatRaw: any = {
      remoteJid: data.remoteJid,
      instanceId: this.instanceId,
    };

    this.sendDataWebhook(Events.CHATS_UPSERT, chatRaw);

    await this.prismaRepository.chat.create({
      data: chatRaw,
    });
  }

  protected async sendMessageWithTyping(
    number: string,
    message: any,
    options?: Options,
    file?: any,
    isIntegration = false,
  ) {
    try {
      let quoted: any;
      let webhookUrl: any;

      if (options?.quoted) {
        const m = options?.quoted;

        const msg = m?.key;

        if (!msg) {
          throw 'Message not found';
        }

        quoted = msg;
      }

      if (options.delay) {
        await new Promise((resolve) => setTimeout(resolve, options.delay));
      }

      if (options?.webhookUrl) {
        webhookUrl = options.webhookUrl;
      }

      let audioFile;

      const messageId = v4();

      let messageRaw: any;

      if (message?.mediaType === 'image') {
        messageRaw = {
          key: { fromMe: true, id: messageId, remoteJid: number },
          message: {
            base64: isBase64(message.media) ? message.media : null,
            mediaUrl: isURL(message.media) ? message.media : null,
            quoted,
          },
          messageType: 'imageMessage',
          messageTimestamp: Math.round(new Date().getTime() / 1000),
          webhookUrl,
          source: 'unknown',
          instanceId: this.instanceId,
        };
      } else if (message?.mediaType === 'video') {
        messageRaw = {
          key: { fromMe: true, id: messageId, remoteJid: number },
          message: {
            base64: isBase64(message.media) ? message.media : null,
            mediaUrl: isURL(message.media) ? message.media : null,
            quoted,
          },
          messageType: 'videoMessage',
          messageTimestamp: Math.round(new Date().getTime() / 1000),
          webhookUrl,
          source: 'unknown',
          instanceId: this.instanceId,
        };
      } else if (message?.mediaType === 'audio') {
        messageRaw = {
          key: { fromMe: true, id: messageId, remoteJid: number },
          message: {
            base64: isBase64(message.media) ? message.media : null,
            mediaUrl: isURL(message.media) ? message.media : null,
            quoted,
          },
          messageType: 'audioMessage',
          messageTimestamp: Math.round(new Date().getTime() / 1000),
          webhookUrl,
          source: 'unknown',
          instanceId: this.instanceId,
        };

        const buffer = Buffer.from(message.media, 'base64');
        audioFile = {
          buffer,
          mimetype: 'audio/mp4',
          originalname: `${messageId}.mp4`,
        };
      } else if (message?.mediaType === 'document') {
        messageRaw = {
          key: { fromMe: true, id: messageId, remoteJid: number },
          message: {
            base64: isBase64(message.media) ? message.media : null,
            mediaUrl: isURL(message.media) ? message.media : null,
            quoted,
          },
          messageType: 'documentMessage',
          messageTimestamp: Math.round(new Date().getTime() / 1000),
          webhookUrl,
          source: 'unknown',
          instanceId: this.instanceId,
        };
      } else if (message.buttonMessage) {
        messageRaw = {
          key: { fromMe: true, id: messageId, remoteJid: number },
          message: {
            ...message.buttonMessage,
            buttons: message.buttonMessage.buttons,
            footer: message.buttonMessage.footer,
            body: message.buttonMessage.body,
            quoted,
          },
          messageType: 'buttonMessage',
          messageTimestamp: Math.round(new Date().getTime() / 1000),
          webhookUrl,
          source: 'unknown',
          instanceId: this.instanceId,
        };
      } else if (message.listMessage) {
        messageRaw = {
          key: { fromMe: true, id: messageId, remoteJid: number },
          message: {
            ...message.listMessage,
            quoted,
          },
          messageType: 'listMessage',
          messageTimestamp: Math.round(new Date().getTime() / 1000),
          webhookUrl,
          source: 'unknown',
          instanceId: this.instanceId,
        };
      } else {
        messageRaw = {
          key: { fromMe: true, id: messageId, remoteJid: number },
          message: {
            ...message,
            quoted,
          },
          messageType: 'conversation',
          messageTimestamp: Math.round(new Date().getTime() / 1000),
          webhookUrl,
          source: 'unknown',
          instanceId: this.instanceId,
        };
      }

      if (messageRaw.message.contextInfo) {
        messageRaw.contextInfo = {
          ...messageRaw.message.contextInfo,
        };
      }

      if (messageRaw.contextInfo?.stanzaId) {
        const key: any = {
          id: messageRaw.contextInfo.stanzaId,
        };

        const findMessage = await this.prismaRepository.message.findFirst({
          where: {
            instanceId: this.instanceId,
            key,
          },
        });

        if (findMessage) {
          messageRaw.contextInfo.quotedMessage = findMessage.message;
        }
      }

      const { base64 } = messageRaw.message;
      delete messageRaw.message.base64;

      if (base64 || file || audioFile) {
        if (this.configService.get<S3>('S3').ENABLE) {
          try {
            // Verificação adicional para garantir que há conteúdo de mídia real
            const hasRealMedia = this.hasValidMediaContent(messageRaw);

            if (!hasRealMedia) {
              this.logger.warn('Message detected as media but contains no valid media content');
            } else {
              const fileBuffer = audioFile?.buffer || file?.buffer;
              const buffer = base64 ? Buffer.from(base64, 'base64') : fileBuffer;

              let mediaType: string;
              let mimetype = audioFile?.mimetype || file.mimetype;

              if (messageRaw.messageType === 'documentMessage') {
                mediaType = 'document';
                mimetype = !mimetype ? 'application/pdf' : mimetype;
              } else if (messageRaw.messageType === 'imageMessage') {
                mediaType = 'image';
                mimetype = !mimetype ? 'image/png' : mimetype;
              } else if (messageRaw.messageType === 'audioMessage') {
                mediaType = 'audio';
                mimetype = !mimetype ? 'audio/mp4' : mimetype;
              } else if (messageRaw.messageType === 'videoMessage') {
                mediaType = 'video';
                mimetype = !mimetype ? 'video/mp4' : mimetype;
              }

              const fileName = `${messageRaw.key.id}.${mimetype.split('/')[1]}`;

              const size = buffer.byteLength;

              const fullName = join(`${this.instance.id}`, messageRaw.key.remoteJid, mediaType, fileName);

              await s3Service.uploadFile(fullName, buffer, size, {
                'Content-Type': mimetype,
              });

              const mediaUrl = await s3Service.getObjectUrl(fullName);

              messageRaw.message.mediaUrl = mediaUrl;
            }
          } catch (error) {
            this.logger.error(['Error on upload file to minio', error?.message, error?.stack]);
          }
        }
      }

      this.logger.log(messageRaw);

      this.sendDataWebhook(Events.SEND_MESSAGE, messageRaw);

      if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled && !isIntegration) {
        this.chatwootService.eventWhatsapp(
          Events.SEND_MESSAGE,
          { instanceName: this.instance.name, instanceId: this.instanceId },
          messageRaw,
        );
      }

      if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled && isIntegration)
        await chatbotController.emit({
          instance: { instanceName: this.instance.name, instanceId: this.instanceId },
          remoteJid: messageRaw.key.remoteJid,
          msg: messageRaw,
          pushName: messageRaw.pushName,
        });

      await this.prismaRepository.message.create({
        data: messageRaw,
      });

      return messageRaw;
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  public async textMessage(data: SendTextDto, isIntegration = false) {
    const res = await this.sendMessageWithTyping(
      data.number,
      {
        conversation: data.text,
      },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        linkPreview: data?.linkPreview,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
      null,
      isIntegration,
    );
    return res;
  }

  protected async prepareMediaMessage(mediaMessage: MediaMessage) {
    try {
      if (mediaMessage.mediatype === 'document' && !mediaMessage.fileName) {
        const regex = new RegExp(/.*\/(.+?)\./);
        const arrayMatch = regex.exec(mediaMessage.media);
        mediaMessage.fileName = arrayMatch[1];
      }

      if (mediaMessage.mediatype === 'image' && !mediaMessage.fileName) {
        mediaMessage.fileName = 'image.png';
      }

      if (mediaMessage.mediatype === 'video' && !mediaMessage.fileName) {
        mediaMessage.fileName = 'video.mp4';
      }

      let mimetype: string | false;

      const prepareMedia: any = {
        caption: mediaMessage?.caption,
        fileName: mediaMessage.fileName,
        mediaType: mediaMessage.mediatype,
        media: mediaMessage.media,
        gifPlayback: false,
      };

      if (isURL(mediaMessage.media)) {
        mimetype = mimeTypes.lookup(mediaMessage.media);
      } else {
        mimetype = mimeTypes.lookup(mediaMessage.fileName);
      }

      prepareMedia.mimetype = mimetype;

      return prepareMedia;
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException(error?.toString() || error);
    }
  }

  public async mediaMessage(data: SendMediaDto, file?: any, isIntegration = false) {
    const mediaData: SendMediaDto = { ...data };

    if (file) mediaData.media = file.buffer.toString('base64');

    const message = await this.prepareMediaMessage(mediaData);

    const mediaSent = await this.sendMessageWithTyping(
      data.number,
      { ...message },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        linkPreview: data?.linkPreview,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
      file,
      isIntegration,
    );

    return mediaSent;
  }

  public async processAudio(audio: string, number: string, file: any) {
    number = number.replace(/\D/g, '');
    const hash = `${number}-${new Date().getTime()}`;

    const audioConverterConfig = this.configService.get<AudioConverter>('AUDIO_CONVERTER');
    if (audioConverterConfig.API_URL) {
      try {
        this.logger.verbose('Using audio converter API');
        const formData = new FormData();

        if (file) {
          formData.append('file', file.buffer, {
            filename: file.originalname,
            contentType: file.mimetype,
          });
        } else if (isURL(audio)) {
          formData.append('url', audio);
        } else {
          formData.append('base64', audio);
        }

        formData.append('format', 'mp4');

        const response = await axios.post(audioConverterConfig.API_URL, formData, {
          headers: {
            ...formData.getHeaders(),
            apikey: audioConverterConfig.API_KEY,
          },
        });

        if (!response?.data?.audio) {
          throw new InternalServerErrorException('Failed to convert audio');
        }

        const prepareMedia: any = {
          fileName: `${hash}.mp4`,
          mediaType: 'audio',
          media: response?.data?.audio,
          mimetype: 'audio/mpeg',
        };

        return prepareMedia;
      } catch (error) {
        this.logger.error(error?.response?.data || error);
        throw new InternalServerErrorException(error?.response?.data?.message || error?.toString() || error);
      }
    } else {
      let mimetype: string;

      const prepareMedia: any = {
        fileName: `${hash}.mp3`,
        mediaType: 'audio',
        media: audio,
        mimetype: 'audio/mpeg',
      };

      if (isURL(audio)) {
        mimetype = mimeTypes.lookup(audio).toString();
      } else {
        mimetype = mimeTypes.lookup(prepareMedia.fileName).toString();
      }

      prepareMedia.mimetype = mimetype;

      return prepareMedia;
    }
  }

  public async audioWhatsapp(data: SendAudioDto, file?: any, isIntegration = false) {
    const mediaData: SendAudioDto = { ...data };

    if (file?.buffer) {
      mediaData.audio = file.buffer.toString('base64');
    } else {
      console.error('El archivo o buffer no est� definido correctamente.');
      throw new Error('File or buffer is undefined.');
    }

    const message = await this.processAudio(mediaData.audio, data.number, file);

    const audioSent = await this.sendMessageWithTyping(
      data.number,
      { ...message },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        linkPreview: data?.linkPreview,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
      file,
      isIntegration,
    );

    return audioSent;
  }

  public async buttonMessage(data: SendButtonsDto, isIntegration = false) {
    return await this.sendMessageWithTyping(
      data.number,
      {
        buttonMessage: {
          title: data.title,
          description: data.description,
          footer: data.footer,
          buttons: data.buttons,
        },
      },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
      null,
      isIntegration,
    );
  }
  public async locationMessage() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async listMessage() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async templateMessage() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async contactMessage() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async reactionMessage() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async getBase64FromMediaMessage() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async deleteMessage() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async mediaSticker() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async pollMessage() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async statusMessage() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async reloadConnection() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async whatsappNumber() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async markMessageAsRead() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async archiveChat() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async markChatUnread() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async fetchProfile() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async offerCall() {
    throw new BadRequestException('Method not available on WhatsApp Business API');
  }
  public async sendPresence() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async setPresence() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async fetchPrivacySettings() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async updatePrivacySettings() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async fetchBusinessProfile() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async updateProfileName() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async updateProfileStatus() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async updateProfilePicture() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async removeProfilePicture() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async blockUser() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async updateMessage() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async createGroup() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async updateGroupPicture() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async updateGroupSubject() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async updateGroupDescription() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async findGroup() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async fetchAllGroups() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async inviteCode() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async inviteInfo() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async sendInvite() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async acceptInviteCode() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async revokeInviteCode() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async findParticipants() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async updateGParticipant() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async updateGSetting() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async toggleEphemeral() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async leaveGroup() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async fetchLabels() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async handleLabel() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async receiveMobileCode() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
  public async fakeCall() {
    throw new BadRequestException('Method not available on Evolution Channel');
  }
}
