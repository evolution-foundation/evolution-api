import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Integration } from '@api/types/wa.types';
import { ConfigService } from '@config/env.config';
import { IntegrationSession } from '@prisma/client';
import { sendTelemetry } from '@utils/sendTelemetry';
import OpenAI from 'openai';

import { BaseChatbotService } from '../../base-chatbot.service';

// MiniMax bot type from Prisma
interface MinimaxBot {
  id: string;
  enabled: boolean;
  description?: string;
  model?: string;
  systemMessages?: any;
  assistantMessages?: any;
  userMessages?: any;
  maxTokens?: number;
  minimaxCredsId: string;
  instanceId: string;
  [key: string]: any;
}

// MiniMax settings type from Prisma
interface MinimaxSetting {
  id: string;
  expire?: number;
  keywordFinish?: string;
  delayMessage?: number;
  unknownMessage?: string;
  listeningFromMe?: boolean;
  stopBotFromMe?: boolean;
  keepOpen?: boolean;
  debounceTime?: number;
  ignoreJids?: any;
  splitMessages?: boolean;
  timePerChar?: number;
  minimaxCredsId?: string;
  minimaxIdFallback?: string;
  instanceId: string;
  [key: string]: any;
}

/**
 * MiniMax service that extends the common BaseChatbotService
 * Uses OpenAI-compatible API via https://api.minimax.io/v1
 */
export class MinimaxService extends BaseChatbotService<MinimaxBot, MinimaxSetting> {
  protected client: OpenAI;

  constructor(waMonitor: WAMonitoringService, prismaRepository: PrismaRepository, configService: ConfigService) {
    super(waMonitor, prismaRepository, 'MinimaxService', configService);
  }

  /**
   * Return the bot type for MiniMax
   */
  protected getBotType(): string {
    return 'minimax';
  }

  /**
   * Initialize the OpenAI-compatible client with MiniMax base URL
   */
  protected initClient(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.minimax.io/v1',
    });
    return this.client;
  }

  /**
   * Process a message using MiniMax chat completion
   */
  public async process(
    instance: any,
    remoteJid: string,
    minimaxBot: MinimaxBot,
    session: IntegrationSession,
    settings: MinimaxSetting,
    content: string,
    pushName?: string,
    msg?: any,
  ): Promise<void> {
    try {
      this.logger.log(`Starting process for remoteJid: ${remoteJid}`);

      // Get the MiniMax credentials
      const creds = await this.prismaRepository.minimaxCreds.findUnique({
        where: { id: minimaxBot.minimaxCredsId },
      });

      if (!creds) {
        this.logger.error(`MiniMax credentials not found. CredsId: ${minimaxBot.minimaxCredsId}`);
        return;
      }

      // Initialize MiniMax client
      this.initClient(creds.apiKey);

      // Handle keyword finish
      const keywordFinish = settings?.keywordFinish || '';
      const normalizedContent = content.toLowerCase().trim();
      if (keywordFinish.length > 0 && normalizedContent === keywordFinish.toLowerCase()) {
        if (settings?.keepOpen) {
          await this.prismaRepository.integrationSession.update({
            where: { id: session.id },
            data: { status: 'closed' },
          });
        } else {
          await this.prismaRepository.integrationSession.delete({
            where: { id: session.id },
          });
        }

        await sendTelemetry('/minimax/session/finish');
        return;
      }

      // If session is new or doesn't exist
      if (!session) {
        const data = {
          remoteJid,
          pushName,
          botId: minimaxBot.id,
        };

        const createSession = await this.createNewSession(
          { instanceName: instance.instanceName, instanceId: instance.instanceId },
          data,
          this.getBotType(),
        );

        await this.initNewSession(
          instance,
          remoteJid,
          minimaxBot,
          settings,
          createSession.session,
          content,
          pushName,
          msg,
        );

        await sendTelemetry('/minimax/session/start');
        return;
      }

      // If session exists but is paused
      if (session.status === 'paused') {
        await this.prismaRepository.integrationSession.update({
          where: { id: session.id },
          data: { status: 'opened', awaitUser: true },
        });
        return;
      }

      // Process with the ChatCompletion API
      await this.sendMessageToBot(instance, session, settings, minimaxBot, remoteJid, pushName || '', content, msg);
    } catch (error) {
      this.logger.error(`Error in process: ${error.message || JSON.stringify(error)}`);
      return;
    }
  }

  /**
   * Send message to MiniMax via OpenAI-compatible ChatCompletion API
   */
  protected async sendMessageToBot(
    instance: any,
    session: IntegrationSession,
    settings: MinimaxSetting,
    minimaxBot: MinimaxBot,
    remoteJid: string,
    pushName: string,
    content: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    msg?: any,
  ): Promise<void> {
    this.logger.log(`Sending message to MiniMax for remoteJid: ${remoteJid}`);

    if (!this.client) {
      this.logger.log('Client not initialized, initializing now');
      const creds = await this.prismaRepository.minimaxCreds.findUnique({
        where: { id: minimaxBot.minimaxCredsId },
      });

      if (!creds) {
        this.logger.error(`MiniMax credentials not found. CredsId: ${minimaxBot.minimaxCredsId}`);
        return;
      }

      this.initClient(creds.apiKey);
    }

    try {
      const message = await this.processChatCompletionMessage(instance, minimaxBot, remoteJid, content);

      this.logger.log(`Got response from MiniMax: ${message?.substring(0, 50)}${message?.length > 50 ? '...' : ''}`);

      if (message) {
        await this.sendMessageWhatsApp(instance, remoteJid, message, settings, true);
      } else {
        this.logger.error('No message to send to WhatsApp');
      }

      // Update session status
      await this.prismaRepository.integrationSession.update({
        where: { id: session.id },
        data: { status: 'opened', awaitUser: true },
      });
    } catch (error) {
      this.logger.error(`Error in sendMessageToBot: ${error.message || JSON.stringify(error)}`);
      return;
    }
  }

  /**
   * Process message using MiniMax ChatCompletion API (OpenAI-compatible)
   */
  private async processChatCompletionMessage(
    instance: any,
    minimaxBot: MinimaxBot,
    remoteJid: string,
    content: string,
  ): Promise<string> {
    this.logger.log('Starting processChatCompletionMessage');

    if (!this.client) {
      const creds = await this.prismaRepository.minimaxCreds.findUnique({
        where: { id: minimaxBot.minimaxCredsId },
      });

      if (!creds) {
        this.logger.error(`MiniMax credentials not found. CredsId: ${minimaxBot.minimaxCredsId}`);
        return 'Error: MiniMax credentials not found';
      }

      this.initClient(creds.apiKey);
    }

    const model = minimaxBot.model || 'MiniMax-M2.5';

    this.logger.log(`Using model: ${model}, max tokens: ${minimaxBot.maxTokens || 500}`);

    // Get existing conversation history from the session
    const session = await this.prismaRepository.integrationSession.findFirst({
      where: {
        remoteJid,
        botId: minimaxBot.id,
        status: 'opened',
      },
    });

    let conversationHistory = [];

    if (session && session.context) {
      try {
        const sessionData =
          typeof session.context === 'string' ? JSON.parse(session.context as string) : session.context;

        conversationHistory = sessionData.history || [];
        this.logger.log(`Retrieved conversation history from session, ${conversationHistory.length} messages`);
      } catch (error) {
        this.logger.error(`Error parsing session context: ${error.message}`);
        conversationHistory = [];
      }
    }

    // Prepare system messages
    const systemMessages: any = minimaxBot.systemMessages || [];
    const messagesSystem: any[] = systemMessages.map((message) => ({
      role: 'system',
      content: message,
    }));

    // Prepare assistant messages
    const assistantMessages: any = minimaxBot.assistantMessages || [];
    const messagesAssistant: any[] = assistantMessages.map((message) => ({
      role: 'assistant',
      content: message,
    }));

    // Prepare user messages
    const userMessages: any = minimaxBot.userMessages || [];
    const messagesUser: any[] = userMessages.map((message) => ({
      role: 'user',
      content: message,
    }));

    // Prepare current message
    const messageData: any = {
      role: 'user',
      content: [{ type: 'text', text: content }],
    };

    // Combine all messages
    const messages: any[] = [
      ...messagesSystem,
      ...messagesAssistant,
      ...messagesUser,
      ...conversationHistory,
      messageData,
    ];

    if (instance.integration === Integration.WHATSAPP_BAILEYS) {
      await instance.client.presenceSubscribe(remoteJid);
      await instance.client.sendPresenceUpdate('composing', remoteJid);
    }

    try {
      this.logger.log('Sending request to MiniMax API');
      const completions = await this.client.chat.completions.create({
        model: model,
        messages: messages,
        max_tokens: minimaxBot.maxTokens || 500,
      });

      if (instance.integration === Integration.WHATSAPP_BAILEYS) {
        await instance.client.sendPresenceUpdate('paused', remoteJid);
      }

      let responseContent = completions.choices[0].message.content;

      // Strip thinking tags from MiniMax responses (M2.5 may include <think>...</think>)
      if (responseContent) {
        responseContent = responseContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      }

      this.logger.log(`Received response from MiniMax: ${JSON.stringify(completions.choices[0])}`);

      // Add the current exchange to the conversation history
      conversationHistory.push(messageData);
      conversationHistory.push({
        role: 'assistant',
        content: responseContent,
      });

      // Limit history length to avoid token limits (keep last 10 messages)
      if (conversationHistory.length > 10) {
        conversationHistory = conversationHistory.slice(conversationHistory.length - 10);
      }

      // Save the updated conversation history to the session
      if (session) {
        await this.prismaRepository.integrationSession.update({
          where: { id: session.id },
          data: {
            context: JSON.stringify({ history: conversationHistory }),
          },
        });
        this.logger.log(`Updated session with conversation history, now ${conversationHistory.length} messages`);
      }

      return responseContent;
    } catch (error) {
      this.logger.error(`Error calling MiniMax: ${error.message || JSON.stringify(error)}`);
      return `Sorry, there was an error: ${error.message || 'Unknown error'}`;
    }
  }
}
