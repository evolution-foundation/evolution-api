import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Integration } from '@api/types/wa.types';
import { ConfigService, HttpServer } from '@config/env.config';
import { Evoai, EvoaiSetting, IntegrationSession } from '@prisma/client';
import axios from 'axios';
import { downloadMediaMessage } from 'baileys';
import { isURL } from 'class-validator';
import { v4 as uuidv4 } from 'uuid';

import { BaseChatbotService } from '../../base-chatbot.service';
import { OpenaiService } from '../../openai/services/openai.service';

export class EvoaiService extends BaseChatbotService<Evoai, EvoaiSetting> {
  private openaiService: OpenaiService;

  constructor(
    waMonitor: WAMonitoringService,
    prismaRepository: PrismaRepository,
    configService: ConfigService,
    openaiService: OpenaiService,
  ) {
    super(waMonitor, prismaRepository, 'EvoaiService', configService);
    this.openaiService = openaiService;
  }

  /**
   * Return the bot type for EvoAI
   */
  protected getBotType(): string {
    return 'evoai';
  }

  /**
   * Implement the abstract method to send message to EvoAI API
   * Handles audio transcription, image processing, and complex JSON-RPC payload
   */
  protected async sendMessageToBot(
    instance: any,
    session: IntegrationSession,
    settings: EvoaiSetting,
    evoai: Evoai,
    remoteJid: string,
    pushName: string,
    content: string,
    msg?: any,
  ): Promise<void> {
    try {
      this.logger.debug(`[EvoAI] Sending message to bot with content: ${content}`);

      let processedContent = content;

      // Handle audio messages - transcribe using OpenAI Whisper
      if (this.isAudioMessage(content) && msg) {
        try {
          this.logger.debug(`[EvoAI] Downloading audio for Whisper transcription`);
          const transcription = await this.openaiService.speechToText(msg, instance);
          if (transcription) {
            processedContent = `[audio] ${transcription}`;
          }
        } catch (err) {
          this.logger.error(`[EvoAI] Failed to transcribe audio: ${err}`);
        }
      }

      const endpoint: string = evoai.agentUrl;

      if (!endpoint) {
        this.logger.error('No EvoAI endpoint defined');
        return;
      }

      const callId = `req-${uuidv4().substring(0, 8)}`;
      const messageId = remoteJid.split('@')[0] || uuidv4(); // Use phone number as messageId

      // Prepare message parts
      const parts = [
        {
          type: 'text',
          text: processedContent,
        },
      ];

      // Handle image message if present
      if (this.isImageMessage(content) && msg) {
        const media = content.split('|');
        parts[0].text = media[2] || content;

        try {
          if (msg.message.mediaUrl || msg.message.base64) {
            let mediaBase64 = msg.message.base64 || null;

            if (msg.message.mediaUrl && isURL(msg.message.mediaUrl)) {
              const result = await axios.get(msg.message.mediaUrl, { responseType: 'arraybuffer' });
              mediaBase64 = Buffer.from(result.data).toString('base64');
            }

            if (mediaBase64) {
              parts.push({
                type: 'file',
                file: {
                  name: msg.key.id + '.jpeg',
                  mimeType: 'image/jpeg',
                  bytes: mediaBase64,
                },
              } as any);
            }
          } else {
            // Download the image
            const mediaBuffer = await downloadMediaMessage(msg, 'buffer', {});
            const fileContent = Buffer.from(mediaBuffer).toString('base64');
            const fileName = media[2] || `${msg.key?.id || 'image'}.jpg`;

            parts.push({
              type: 'file',
              file: {
                name: fileName,
                mimeType: 'image/jpeg',
                bytes: fileContent,
              },
            } as any);
          }
        } catch (fileErr) {
          this.logger.error(`[EvoAI] Failed to process image: ${fileErr}`);
        }
      }

      const payload = {
        jsonrpc: '2.0',
        id: callId,
        method: 'message/send',
        params: {
          contextId: session.sessionId,
          message: {
            role: 'user',
            parts,
            messageId: messageId,
            metadata: {
              messageKey: msg?.key,
            },
          },
          metadata: {
            remoteJid: remoteJid,
            pushName: pushName,
            fromMe: msg?.key?.fromMe,
            instanceName: instance.instanceName,
            serverUrl: this.configService.get<HttpServer>('SERVER').URL,
            apiKey: instance.token,
          },
        },
      };

      this.logger.debug(`[EvoAI] Sending request to: ${endpoint}`);
      // Redact base64 file bytes from payload log
      const redactedPayload = JSON.parse(JSON.stringify(payload));
      if (redactedPayload?.params?.message?.parts) {
        redactedPayload.params.message.parts = redactedPayload.params.message.parts.map((part) => {
          if (part.type === 'file' && part.file && part.file.bytes) {
            return { ...part, file: { ...part.file, bytes: '[base64 omitted]' } };
          }
          return part;
        });
      }
      this.logger.debug(`[EvoAI] Payload: ${JSON.stringify(redactedPayload)}`);

      if (instance.integration === Integration.WHATSAPP_BAILEYS) {
        await instance.client.presenceSubscribe(remoteJid);
        await instance.client.sendPresenceUpdate('composing', remoteJid);
      }

      const response = await axios.post(endpoint, payload, {
        headers: {
          'x-api-key': evoai.apiKey,
          'Content-Type': 'application/json',
        },
      });

      this.logger.debug(`[EvoAI] Response: ${JSON.stringify(response.data)}`);

      if (instance.integration === Integration.WHATSAPP_BAILEYS)
        await instance.client.sendPresenceUpdate('paused', remoteJid);

      let message = undefined;
      const result = response?.data?.result;

      // Extract message from artifacts array
      if (result?.artifacts && Array.isArray(result.artifacts) && result.artifacts.length > 0) {
        const artifact = result.artifacts[0];
        if (artifact?.parts && Array.isArray(artifact.parts)) {
          const textPart = artifact.parts.find((p) => p.type === 'text' && p.text);
          if (textPart) message = textPart.text;
        }
      }

      this.logger.debug(`[EvoAI] Extracted message to send: ${message}`);

      if (message) {
        await this.sendMessageWhatsApp(instance, remoteJid, message, settings, true);
      }
    } catch (error) {
      this.logger.error(
        `[EvoAI] Error sending message: ${error?.response?.data ? JSON.stringify(error.response.data) : error}`,
      );
      return;
    }
  }
}
