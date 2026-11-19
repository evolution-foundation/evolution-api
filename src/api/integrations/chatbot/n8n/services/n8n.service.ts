import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { ConfigService, HttpServer } from '@config/env.config';
import { IntegrationSession, N8n, N8nSetting } from '@prisma/client';
import axios from 'axios';

import { BaseChatbotService } from '../../base-chatbot.service';
import { OpenaiService } from '../../openai/services/openai.service';

export class N8nService extends BaseChatbotService<N8n, N8nSetting> {
  private openaiService: OpenaiService;

  constructor(
    waMonitor: WAMonitoringService,
    prismaRepository: PrismaRepository,
    configService: ConfigService,
    openaiService: OpenaiService,
  ) {
    super(waMonitor, prismaRepository, 'N8nService', configService);
    this.openaiService = openaiService;
  }

  /**
   * Return the bot type for N8n
   */
  protected getBotType(): string {
    return 'n8n';
  }

  protected async sendMessageToBot(
    instance: any,
    session: IntegrationSession,
    settings: N8nSetting,
    n8n: N8n,
    remoteJid: string,
    pushName: string,
    content: string,
    msg?: any,
  ) {
    try {
      if (!session) {
        this.logger.error('Session is null in sendMessageToBot');
        return;
      }

      const endpoint: string = n8n.webhookUrl;
      const payload: any = {
        chatInput: content,
        sessionId: session.sessionId,
        remoteJid: remoteJid,
        pushName: pushName,
        keyId: msg?.key?.id,
        fromMe: msg?.key?.fromMe,
        quotedMessage: msg?.contextInfo?.quotedMessage,
        instanceName: instance.instanceName,
        serverUrl: this.configService.get<HttpServer>('SERVER').URL,
        apiKey: instance.token,
      };

      // Handle audio messages
      if (this.isAudioMessage(content) && msg) {
        try {
          this.logger.debug(`[N8n] Downloading audio for Whisper transcription`);
          const transcription = await this.openaiService.speechToText(msg, instance);
          if (transcription) {
            payload.chatInput = `[audio] ${transcription}`;
          }
        } catch (err) {
          this.logger.error(`[N8n] Failed to transcribe audio: ${err}`);
        }
      }

      const headers: Record<string, string> = {};
      if (n8n.basicAuthUser && n8n.basicAuthPass) {
        const auth = Buffer.from(`${n8n.basicAuthUser}:${n8n.basicAuthPass}`).toString('base64');
        headers['Authorization'] = `Basic ${auth}`;
      }
      const response = await axios.post(endpoint, payload, { headers });
      const message = response?.data?.output || response?.data?.answer;

      // Use base class method instead of custom implementation
      await this.sendMessageWhatsApp(instance, remoteJid, message, settings, true);

      await this.prismaRepository.integrationSession.update({
        where: {
          id: session.id,
        },
        data: {
          status: 'opened',
          awaitUser: true,
        },
      });
    } catch (error) {
      this.logger.error(error.response?.data || error);
      return;
    }
  }
}
