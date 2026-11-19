import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Integration } from '@api/types/wa.types';
import { ConfigService, HttpServer } from '@config/env.config';
import { Dify, DifySetting, IntegrationSession } from '@prisma/client';
import axios from 'axios';
import { isURL } from 'class-validator';

import { BaseChatbotService } from '../../base-chatbot.service';
import { OpenaiService } from '../../openai/services/openai.service';

export class DifyService extends BaseChatbotService<Dify, DifySetting> {
  private openaiService: OpenaiService;

  constructor(
    waMonitor: WAMonitoringService,
    prismaRepository: PrismaRepository,
    configService: ConfigService,
    openaiService: OpenaiService,
  ) {
    super(waMonitor, prismaRepository, 'DifyService', configService);
    this.openaiService = openaiService;
  }

  /**
   * Return the bot type for Dify
   */
  protected getBotType(): string {
    return 'dify';
  }

  protected async sendMessageToBot(
    instance: any,
    session: IntegrationSession,
    settings: DifySetting,
    dify: Dify,
    remoteJid: string,
    pushName: string,
    content: string,
    msg?: any,
  ): Promise<void> {
    try {
      let endpoint: string = dify.apiUrl;

      if (!endpoint) {
        this.logger.error('No Dify endpoint defined');
        return;
      }

      // Handle audio messages - transcribe using OpenAI Whisper
      let processedContent = content;
      if (this.isAudioMessage(content) && msg) {
        try {
          this.logger.debug(`[Dify] Downloading audio for Whisper transcription`);
          const transcription = await this.openaiService.speechToText(msg, instance);
          if (transcription) {
            processedContent = `[audio] ${transcription}`;
          }
        } catch (err) {
          this.logger.error(`[Dify] Failed to transcribe audio: ${err}`);
        }
      }

      if (dify.botType === 'chatBot') {
        endpoint += '/chat-messages';
        const payload: any = {
          inputs: {
            remoteJid: remoteJid,
            pushName: pushName,
            instanceName: instance.instanceName,
            serverUrl: this.configService.get<HttpServer>('SERVER').URL,
            apiKey: instance.token,
          },
          query: processedContent,
          response_mode: 'blocking',
          conversation_id: session.sessionId === remoteJid ? undefined : session.sessionId,
          user: remoteJid,
        };

        // Handle image messages
        if (this.isImageMessage(content)) {
          const media = content.split('|');

          if (msg.message.mediaUrl || msg.message.base64) {
            let mediaBase64 = msg.message.base64 || null;

            if (msg.message.mediaUrl && isURL(msg.message.mediaUrl)) {
              const result = await axios.get(msg.message.mediaUrl, { responseType: 'arraybuffer' });
              mediaBase64 = Buffer.from(result.data).toString('base64');
            }

            if (mediaBase64) {
              payload.files = [
                {
                  type: 'image',
                  transfer_method: 'remote_url',
                  url: mediaBase64,
                },
              ];
            }
          } else {
            payload.files = [
              {
                type: 'image',
                transfer_method: 'remote_url',
                url: media[1].split('?')[0],
              },
            ];
          }
          payload.query = media[2] || content;
        }

        if (instance.integration === Integration.WHATSAPP_BAILEYS) {
          await instance.client.presenceSubscribe(remoteJid);
          await instance.client.sendPresenceUpdate('composing', remoteJid);
        }

        const response = await axios.post(endpoint, payload, {
          headers: {
            Authorization: `Bearer ${dify.apiKey}`,
          },
        });

        if (instance.integration === Integration.WHATSAPP_BAILEYS)
          await instance.client.sendPresenceUpdate('paused', remoteJid);

        const message = response?.data?.answer;
        const conversationId = response?.data?.conversation_id;

        if (message) {
          await this.sendMessageWhatsApp(instance, remoteJid, message, settings, true);
        }

        await this.prismaRepository.integrationSession.update({
          where: {
            id: session.id,
          },
          data: {
            status: 'opened',
            awaitUser: true,
            sessionId: session.sessionId === remoteJid ? conversationId : session.sessionId,
          },
        });
      }

      if (dify.botType === 'textGenerator') {
        endpoint += '/completion-messages';
        const payload: any = {
          inputs: {
            query: processedContent,
            pushName: pushName,
            remoteJid: remoteJid,
            instanceName: instance.instanceName,
            serverUrl: this.configService.get<HttpServer>('SERVER').URL,
            apiKey: instance.token,
          },
          response_mode: 'blocking',
          conversation_id: session.sessionId === remoteJid ? undefined : session.sessionId,
          user: remoteJid,
        };

        // Handle image messages
        if (this.isImageMessage(content)) {
          const media = content.split('|');

          if (msg.message.mediaUrl || msg.message.base64) {
            let mediaBase64 = msg.message.base64 || null;

            if (msg.message.mediaUrl && isURL(msg.message.mediaUrl)) {
              const result = await axios.get(msg.message.mediaUrl, { responseType: 'arraybuffer' });
              mediaBase64 = Buffer.from(result.data).toString('base64');
            }

            if (mediaBase64) {
              payload.files = [
                {
                  type: 'image',
                  transfer_method: 'remote_url',
                  url: mediaBase64,
                },
              ];
            }
          } else {
            payload.files = [
              {
                type: 'image',
                transfer_method: 'remote_url',
                url: media[1].split('?')[0],
              },
            ];
            payload.inputs.query = media[2] || content;
          }
        }

        if (instance.integration === Integration.WHATSAPP_BAILEYS) {
          await instance.client.presenceSubscribe(remoteJid);
          await instance.client.sendPresenceUpdate('composing', remoteJid);
        }

        const response = await axios.post(endpoint, payload, {
          headers: {
            Authorization: `Bearer ${dify.apiKey}`,
          },
        });

        if (instance.integration === Integration.WHATSAPP_BAILEYS)
          await instance.client.sendPresenceUpdate('paused', remoteJid);

        const message = response?.data?.answer;
        const conversationId = response?.data?.conversation_id;

        if (message) {
          await this.sendMessageWhatsApp(instance, remoteJid, message, settings, true);
        }

        await this.prismaRepository.integrationSession.update({
          where: {
            id: session.id,
          },
          data: {
            status: 'opened',
            awaitUser: true,
            sessionId: session.sessionId === remoteJid ? conversationId : session.sessionId,
          },
        });
      }

      if (dify.botType === 'agent') {
        endpoint += '/chat-messages';
        const payload: any = {
          inputs: {
            remoteJid: remoteJid,
            pushName: pushName,
            instanceName: instance.instanceName,
            serverUrl: this.configService.get<HttpServer>('SERVER').URL,
            apiKey: instance.token,
          },
          query: processedContent,
          response_mode: 'streaming',
          conversation_id: session.sessionId === remoteJid ? undefined : session.sessionId,
          user: remoteJid,
        };

        // Handle image messages
        if (this.isImageMessage(content)) {
          const media = content.split('|');

          if (msg.message.mediaUrl || msg.message.base64) {
            payload.files = [
              {
                type: 'image',
                transfer_method: 'remote_url',
                url: msg.message.mediaUrl || msg.message.base64,
              },
            ];
          } else {
            payload.files = [
              {
                type: 'image',
                transfer_method: 'remote_url',
                url: media[1].split('?')[0],
              },
            ];
            payload.query = media[2] || content;
          }
        }

        if (instance.integration === Integration.WHATSAPP_BAILEYS) {
          await instance.client.presenceSubscribe(remoteJid);
          await instance.client.sendPresenceUpdate('composing', remoteJid);
        }

        const response = await axios.post(endpoint, payload, {
          headers: {
            Authorization: `Bearer ${dify.apiKey}`,
          },
        });

        let conversationId;
        let answer = '';

        const data = response.data.replaceAll('data: ', '');
        const events = data.split('\n').filter((line) => line.trim() !== '');

        for (const eventString of events) {
          if (eventString.trim().startsWith('{')) {
            const event = JSON.parse(eventString);

            if (event?.event === 'agent_message') {
              console.log('event:', event);
              conversationId = conversationId ?? event?.conversation_id;
              answer += event?.answer;
            }
          }
        }

        if (instance.integration === Integration.WHATSAPP_BAILEYS)
          await instance.client.sendPresenceUpdate('paused', remoteJid);

        if (answer) {
          await this.sendMessageWhatsApp(instance, remoteJid, answer, settings, true);
        }

        await this.prismaRepository.integrationSession.update({
          where: {
            id: session.id,
          },
          data: {
            status: 'opened',
            awaitUser: true,
            sessionId: session.sessionId === remoteJid ? conversationId : session.sessionId,
          },
        });
      }
    } catch (error) {
      this.logger.error(error.response?.data || error);
      return;
    }
  }
}
