/* eslint-disable @typescript-eslint/no-unused-vars */
import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Integration } from '@api/types/wa.types';
import { ConfigService, HttpServer } from '@config/env.config';
import { Flowise as FlowiseModel, IntegrationSession } from '@prisma/client';
import axios from 'axios';
import { isURL } from 'class-validator';

import { BaseChatbotService } from '../../base-chatbot.service';
import { OpenaiService } from '../../openai/services/openai.service';

export class FlowiseService extends BaseChatbotService<FlowiseModel> {
  private openaiService: OpenaiService;

  constructor(
    waMonitor: WAMonitoringService,
    prismaRepository: PrismaRepository,
    configService: ConfigService,
    openaiService: OpenaiService,
  ) {
    super(waMonitor, prismaRepository, 'FlowiseService', configService);
    this.openaiService = openaiService;
  }

  // Return the bot type for Flowise
  protected getBotType(): string {
    return 'flowise';
  }

  // Process Flowise-specific bot logic
  public async processBot(
    instance: any,
    remoteJid: string,
    bot: FlowiseModel,
    session: IntegrationSession,
    settings: any,
    content: string,
    pushName?: string,
    msg?: any,
  ) {
    await this.process(instance, remoteJid, bot, session, settings, content, pushName, msg);
  }

  // Implement the abstract method to send message to Flowise API
  protected async sendMessageToBot(
    instance: any,
    session: IntegrationSession,
    settings: any,
    bot: FlowiseModel,
    remoteJid: string,
    pushName: string,
    content: string,
    msg?: any,
  ): Promise<void> {
    const payload: any = {
      question: content,
      overrideConfig: {
        sessionId: remoteJid,
        vars: {
          messageId: msg?.key?.id,
          fromMe: msg?.key?.fromMe,
          remoteJid: remoteJid,
          pushName: pushName,
          instanceName: instance.instanceName,
          serverUrl: this.configService.get<HttpServer>('SERVER').URL,
          apiKey: instance.token,
        },
      },
    };

    // Handle audio messages
    if (this.isAudioMessage(content) && msg) {
      try {
        this.logger.debug(`[Flowise] Downloading audio for Whisper transcription`);
        const transcription = await this.openaiService.speechToText(msg, instance);
        if (transcription) {
          payload.question = `[audio] ${transcription}`;
        }
      } catch (err) {
        this.logger.error(`[Flowise] Failed to transcribe audio: ${err}`);
      }
    }

    if (this.isImageMessage(content)) {
      const media = content.split('|');

      if (msg.message.mediaUrl || msg.message.base64) {
        payload.uploads = [
          {
            data: msg.message.base64 || msg.message.mediaUrl,
            type: 'url',
            name: 'Flowise.png',
            mime: 'image/png',
          },
        ];
      } else {
        payload.uploads = [
          {
            data: media[1].split('?')[0],
            type: 'url',
            name: 'Flowise.png',
            mime: 'image/png',
          },
        ];
        payload.question = media[2] || content;
      }
    }

    if (instance.integration === Integration.WHATSAPP_BAILEYS) {
      await instance.client.presenceSubscribe(remoteJid);
      await instance.client.sendPresenceUpdate('composing', remoteJid);
    }

    let headers: any = {
      'Content-Type': 'application/json',
    };

    if (bot.apiKey) {
      headers = {
        ...headers,
        Authorization: `Bearer ${bot.apiKey}`,
      };
    }

    const endpoint = bot.apiUrl;

    if (!endpoint) {
      this.logger.error('No Flowise endpoint defined');
      return;
    }

    const response = await axios.post(endpoint, payload, {
      headers,
    });

    if (instance.integration === Integration.WHATSAPP_BAILEYS) {
      await instance.client.sendPresenceUpdate('paused', remoteJid);
    }

    const message = response?.data?.text;

    if (message) {
      // Use the base class method to send the message to WhatsApp
      await this.sendMessageWhatsApp(instance, remoteJid, message, settings, true);
    }
  }

  // The service is now complete with just the abstract method implementations
}
