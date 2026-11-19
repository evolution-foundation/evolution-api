import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Integration } from '@api/types/wa.types';
import { ConfigService, Language, Openai as OpenaiConfig } from '@config/env.config';
import { IntegrationSession, OpenaiBot, OpenaiSetting } from '@prisma/client';
import { sendTelemetry } from '@utils/sendTelemetry';
import axios from 'axios';
import { downloadMediaMessage } from 'baileys';
import { isURL } from 'class-validator';
import FormData from 'form-data';
import OpenAI from 'openai';
import P from 'pino';

import { BaseChatbotService } from '../../base-chatbot.service';

/**
 * OpenAI service that extends the common BaseChatbotService
 * Handles both Assistant API and ChatCompletion API
 */
export class OpenaiService extends BaseChatbotService<OpenaiBot, OpenaiSetting> {
  protected client: OpenAI;

  constructor(waMonitor: WAMonitoringService, prismaRepository: PrismaRepository, configService: ConfigService) {
    super(waMonitor, prismaRepository, 'OpenaiService', configService);
  }

  /**
   * Return the bot type for OpenAI
   */
  protected getBotType(): string {
    return 'openai';
  }

  /**
   * Initialize the OpenAI client with the provided API key
   */
  protected initClient(apiKey: string) {
    this.client = new OpenAI({ apiKey });
    return this.client;
  }

  /**
   * Process a message based on the bot type (assistant or chat completion)
   */
  public async process(
    instance: any,
    remoteJid: string,
    openaiBot: OpenaiBot,
    session: IntegrationSession,
    settings: OpenaiSetting,
    content: string,
    pushName?: string,
    msg?: any,
  ): Promise<void> {
    try {
      this.logger.log(`Starting process for remoteJid: ${remoteJid}, bot type: ${openaiBot.botType}`);

      // Handle audio message transcription
      if (content.startsWith('audioMessage|') && msg) {
        this.logger.log('Detected audio message, attempting to transcribe');

        // Get OpenAI credentials for transcription
        const creds = await this.prismaRepository.openaiCreds.findUnique({
          where: { id: openaiBot.openaiCredsId },
        });

        if (!creds) {
          this.logger.error(`OpenAI credentials not found. CredsId: ${openaiBot.openaiCredsId}`);
          return;
        }

        // Initialize OpenAI client for transcription
        this.initClient(creds.apiKey);

        // Transcribe the audio
        const transcription = await this.speechToText(msg, instance);

        if (transcription) {
          this.logger.log(`Audio transcribed: ${transcription}`);
          // Replace the audio message identifier with the transcription
          content = transcription;
        } else {
          this.logger.error('Failed to transcribe audio');
          await this.sendMessageWhatsApp(
            instance,
            remoteJid,
            "Sorry, I couldn't transcribe your audio message. Could you please type your message instead?",
            settings,
            true,
          );
          return;
        }
      } else {
        // Get the OpenAI credentials
        const creds = await this.prismaRepository.openaiCreds.findUnique({
          where: { id: openaiBot.openaiCredsId },
        });

        if (!creds) {
          this.logger.error(`OpenAI credentials not found. CredsId: ${openaiBot.openaiCredsId}`);
          return;
        }

        // Initialize OpenAI client
        this.initClient(creds.apiKey);
      }

      // Handle keyword finish
      const keywordFinish = settings?.keywordFinish || '';
      const normalizedContent = content.toLowerCase().trim();
      if (keywordFinish.length > 0 && normalizedContent === keywordFinish.toLowerCase()) {
        if (settings?.keepOpen) {
          await this.prismaRepository.integrationSession.update({
            where: {
              id: session.id,
            },
            data: {
              status: 'closed',
            },
          });
        } else {
          await this.prismaRepository.integrationSession.delete({
            where: {
              id: session.id,
            },
          });
        }

        await sendTelemetry('/openai/session/finish');
        return;
      }

      // If session is new or doesn't exist
      if (!session) {
        const data = {
          remoteJid,
          pushName,
          botId: openaiBot.id,
        };

        const createSession = await this.createNewSession(
          { instanceName: instance.instanceName, instanceId: instance.instanceId },
          data,
          this.getBotType(),
        );

        await this.initNewSession(
          instance,
          remoteJid,
          openaiBot,
          settings,
          createSession.session,
          content,
          pushName,
          msg,
        );

        await sendTelemetry('/openai/session/start');
        return;
      }

      // If session exists but is paused
      if (session.status === 'paused') {
        await this.prismaRepository.integrationSession.update({
          where: {
            id: session.id,
          },
          data: {
            status: 'opened',
            awaitUser: true,
          },
        });

        return;
      }

      // Process with the appropriate API based on bot type
      await this.sendMessageToBot(instance, session, settings, openaiBot, remoteJid, pushName || '', content, msg);
    } catch (error) {
      this.logger.error(`Error in process: ${error.message || JSON.stringify(error)}`);
      return;
    }
  }

  /**
   * Send message to OpenAI - this handles both Assistant API and ChatCompletion API
   */
  protected async sendMessageToBot(
    instance: any,
    session: IntegrationSession,
    settings: OpenaiSetting,
    openaiBot: OpenaiBot,
    remoteJid: string,
    pushName: string,
    content: string,
    msg?: any,
  ): Promise<void> {
    this.logger.log(`Sending message to bot for remoteJid: ${remoteJid}, bot type: ${openaiBot.botType}`);

    if (!this.client) {
      this.logger.log('Client not initialized, initializing now');
      const creds = await this.prismaRepository.openaiCreds.findUnique({
        where: { id: openaiBot.openaiCredsId },
      });

      if (!creds) {
        this.logger.error(`OpenAI credentials not found in sendMessageToBot. CredsId: ${openaiBot.openaiCredsId}`);
        return;
      }

      this.initClient(creds.apiKey);
    }

    try {
      let message: string;

      // Handle different bot types
      if (openaiBot.botType === 'assistant') {
        this.logger.log('Processing with Assistant API');
        message = await this.processAssistantMessage(
          instance,
          session,
          openaiBot,
          remoteJid,
          pushName,
          false, // Not fromMe
          content,
          msg,
        );
      } else {
        this.logger.log('Processing with ChatCompletion API');
        message = await this.processChatCompletionMessage(instance, openaiBot, remoteJid, content, msg);
      }

      this.logger.log(`Got response from OpenAI: ${message?.substring(0, 50)}${message?.length > 50 ? '...' : ''}`);

      // Send the response
      if (message) {
        this.logger.log('Sending message to WhatsApp');
        await this.sendMessageWhatsApp(instance, remoteJid, message, settings, true);
      } else {
        this.logger.error('No message to send to WhatsApp');
      }

      // Update session status
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
      this.logger.error(`Error in sendMessageToBot: ${error.message || JSON.stringify(error)}`);
      if (error.response) {
        this.logger.error(`API Response data: ${JSON.stringify(error.response.data || {})}`);
      }
      return;
    }
  }

  /**
   * Process message using the OpenAI Assistant API
   */
  private async processAssistantMessage(
    instance: any,
    session: IntegrationSession,
    openaiBot: OpenaiBot,
    remoteJid: string,
    pushName: string,
    fromMe: boolean,
    content: string,
    msg?: any,
  ): Promise<string> {
    const messageData: any = {
      role: fromMe ? 'assistant' : 'user',
      content: [{ type: 'text', text: content }],
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
          messageData.content = [
            { type: 'text', text: media[2] || content },
            { type: 'image_url', image_url: { url: mediaBase64 } },
          ];
        }
      } else {
        const url = media[1].split('?')[0];

        messageData.content = [
          { type: 'text', text: media[2] || content },
          {
            type: 'image_url',
            image_url: {
              url: url,
            },
          },
        ];
      }
    }

    // Get thread ID from session or create new thread
    let threadId = session.sessionId;

    // Create a new thread if one doesn't exist or invalid format
    if (!threadId || threadId === remoteJid) {
      const newThread = await this.client.beta.threads.create();
      threadId = newThread.id;

      // Save the new thread ID to the session
      await this.prismaRepository.integrationSession.update({
        where: {
          id: session.id,
        },
        data: {
          sessionId: threadId,
        },
      });
      this.logger.log(`Created new thread ID: ${threadId} for session: ${session.id}`);
    }

    // Add message to thread
    await this.client.beta.threads.messages.create(threadId, messageData);

    if (fromMe) {
      sendTelemetry('/message/sendText');
      return '';
    }

    // Run the assistant
    const runAssistant = await this.client.beta.threads.runs.create(threadId, {
      assistant_id: openaiBot.assistantId,
    });

    if (instance.integration === Integration.WHATSAPP_BAILEYS) {
      await instance.client.presenceSubscribe(remoteJid);
      await instance.client.sendPresenceUpdate('composing', remoteJid);
    }

    // Wait for the assistant to complete
    const response = await this.getAIResponse(threadId, runAssistant.id, openaiBot.functionUrl, remoteJid, pushName);

    if (instance.integration === Integration.WHATSAPP_BAILEYS) {
      await instance.client.sendPresenceUpdate('paused', remoteJid);
    }

    // Extract the response text safely with type checking
    let responseText = "I couldn't generate a proper response. Please try again.";
    try {
      const messages = response?.data || [];
      if (messages.length > 0) {
        const messageContent = messages[0]?.content || [];
        if (messageContent.length > 0) {
          const textContent = messageContent[0];
          if (textContent && 'text' in textContent && textContent.text && 'value' in textContent.text) {
            responseText = textContent.text.value;
          }
        }
      }
    } catch (error) {
      this.logger.error(`Error extracting response text: ${error}`);
    }

    // Update session with the thread ID to ensure continuity
    await this.prismaRepository.integrationSession.update({
      where: {
        id: session.id,
      },
      data: {
        status: 'opened',
        awaitUser: true,
        sessionId: threadId, // Ensure thread ID is saved consistently
      },
    });

    // Return fallback message if unable to extract text
    return responseText;
  }

  /**
   * Process message using the OpenAI ChatCompletion API
   */
  private async processChatCompletionMessage(
    instance: any,
    openaiBot: OpenaiBot,
    remoteJid: string,
    content: string,
    msg?: any,
  ): Promise<string> {
    this.logger.log('Starting processChatCompletionMessage');

    // Check if client is initialized
    if (!this.client) {
      this.logger.log('Client not initialized in processChatCompletionMessage, initializing now');
      const creds = await this.prismaRepository.openaiCreds.findUnique({
        where: { id: openaiBot.openaiCredsId },
      });

      if (!creds) {
        this.logger.error(`OpenAI credentials not found. CredsId: ${openaiBot.openaiCredsId}`);
        return 'Error: OpenAI credentials not found';
      }

      this.initClient(creds.apiKey);
    }

    // Check if model is defined
    if (!openaiBot.model) {
      this.logger.error('OpenAI model not defined');
      return 'Error: OpenAI model not configured';
    }

    this.logger.log(`Using model: ${openaiBot.model}, max tokens: ${openaiBot.maxTokens || 500}`);

    // Get existing conversation history from the session
    const session = await this.prismaRepository.integrationSession.findFirst({
      where: {
        remoteJid,
        botId: openaiBot.id,
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
        // Continue with empty history if we can't parse the session data
        conversationHistory = [];
      }
    }

    // Log bot data
    this.logger.log(`Bot data - systemMessages: ${JSON.stringify(openaiBot.systemMessages || [])}`);
    this.logger.log(`Bot data - assistantMessages: ${JSON.stringify(openaiBot.assistantMessages || [])}`);
    this.logger.log(`Bot data - userMessages: ${JSON.stringify(openaiBot.userMessages || [])}`);

    // Prepare system messages
    const systemMessages: any = openaiBot.systemMessages || [];
    const messagesSystem: any[] = systemMessages.map((message) => {
      return {
        role: 'system',
        content: message,
      };
    });

    // Prepare assistant messages
    const assistantMessages: any = openaiBot.assistantMessages || [];
    const messagesAssistant: any[] = assistantMessages.map((message) => {
      return {
        role: 'assistant',
        content: message,
      };
    });

    // Prepare user messages
    const userMessages: any = openaiBot.userMessages || [];
    const messagesUser: any[] = userMessages.map((message) => {
      return {
        role: 'user',
        content: message,
      };
    });

    // Prepare current message
    const messageData: any = {
      role: 'user',
      content: [{ type: 'text', text: content }],
    };

    // Handle image messages
    if (this.isImageMessage(content)) {
      this.logger.log('Found image message');
      const media = content.split('|');

      if (msg.message.mediaUrl || msg.message.base64) {
        messageData.content = [
          { type: 'text', text: media[2] || content },
          { type: 'image_url', image_url: { url: msg.message.base64 || msg.message.mediaUrl } },
        ];
      } else {
        const url = media[1].split('?')[0];

        messageData.content = [
          { type: 'text', text: media[2] || content },
          {
            type: 'image_url',
            image_url: {
              url: url,
            },
          },
        ];
      }
    }

    // Combine all messages: system messages, pre-defined messages, conversation history, and current message
    const messages: any[] = [
      ...messagesSystem,
      ...messagesAssistant,
      ...messagesUser,
      ...conversationHistory,
      messageData,
    ];

    this.logger.log(`Final messages payload: ${JSON.stringify(messages)}`);

    if (instance.integration === Integration.WHATSAPP_BAILEYS) {
      this.logger.log('Setting typing indicator');
      await instance.client.presenceSubscribe(remoteJid);
      await instance.client.sendPresenceUpdate('composing', remoteJid);
    }

    // Send the request to OpenAI
    try {
      this.logger.log('Sending request to OpenAI API');
      const completions = await this.client.chat.completions.create({
        model: openaiBot.model,
        messages: messages,
        max_tokens: openaiBot.maxTokens || 500, // Add default if maxTokens is missing
      });

      if (instance.integration === Integration.WHATSAPP_BAILEYS) {
        await instance.client.sendPresenceUpdate('paused', remoteJid);
      }

      const responseContent = completions.choices[0].message.content;
      this.logger.log(`Received response from OpenAI: ${JSON.stringify(completions.choices[0])}`);

      // Add the current exchange to the conversation history and update the session
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
            context: JSON.stringify({
              history: conversationHistory,
            }),
          },
        });
        this.logger.log(`Updated session with conversation history, now ${conversationHistory.length} messages`);
      }

      return responseContent;
    } catch (error) {
      this.logger.error(`Error calling OpenAI: ${error.message || JSON.stringify(error)}`);
      if (error.response) {
        this.logger.error(`API Response status: ${error.response.status}`);
        this.logger.error(`API Response data: ${JSON.stringify(error.response.data || {})}`);
      }
      return `Sorry, there was an error: ${error.message || 'Unknown error'}`;
    }
  }

  /**
   * Wait for and retrieve the AI response
   */
  private async getAIResponse(
    threadId: string,
    runId: string,
    functionUrl: string | null,
    remoteJid: string,
    pushName: string,
  ) {
    let status = await this.client.beta.threads.runs.retrieve(threadId, runId);

    let maxRetries = 60; // 1 minute with 1s intervals
    const checkInterval = 1000; // 1 second

    while (
      status.status !== 'completed' &&
      status.status !== 'failed' &&
      status.status !== 'cancelled' &&
      status.status !== 'expired' &&
      maxRetries > 0
    ) {
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
      status = await this.client.beta.threads.runs.retrieve(threadId, runId);

      // Handle tool calls
      if (status.status === 'requires_action' && status.required_action?.type === 'submit_tool_outputs') {
        const toolCalls = status.required_action.submit_tool_outputs.tool_calls;
        const toolOutputs = [];

        for (const toolCall of toolCalls) {
          if (functionUrl) {
            try {
              const payloadData = JSON.parse(toolCall.function.arguments);

              // Add context
              payloadData.remoteJid = remoteJid;
              payloadData.pushName = pushName;

              const response = await axios.post(functionUrl, {
                functionName: toolCall.function.name,
                functionArguments: payloadData,
              });

              toolOutputs.push({
                tool_call_id: toolCall.id,
                output: JSON.stringify(response.data),
              });
            } catch (error) {
              this.logger.error(`Error calling function: ${error}`);
              toolOutputs.push({
                tool_call_id: toolCall.id,
                output: JSON.stringify({ error: 'Function call failed' }),
              });
            }
          } else {
            toolOutputs.push({
              tool_call_id: toolCall.id,
              output: JSON.stringify({ error: 'No function URL configured' }),
            });
          }
        }

        await this.client.beta.threads.runs.submitToolOutputs(threadId, runId, {
          tool_outputs: toolOutputs,
        });
      }

      maxRetries--;
    }

    if (status.status === 'completed') {
      const messages = await this.client.beta.threads.messages.list(threadId);
      return messages;
    } else {
      this.logger.error(`Assistant run failed with status: ${status.status}`);
      return { data: [{ content: [{ text: { value: 'Failed to get a response from the assistant.' } }] }] };
    }
  }

  protected isImageMessage(content: string): boolean {
    return content.includes('imageMessage');
  }

  /**
   * Implementation of speech-to-text transcription for audio messages
   */
  public async speechToText(msg: any, instance: any): Promise<string | null> {
    const settings = await this.prismaRepository.openaiSetting.findFirst({
      where: {
        instanceId: instance.instanceId,
      },
    });

    if (!settings) {
      this.logger.error(`OpenAI settings not found. InstanceId: ${instance.instanceId}`);
      return null;
    }

    const creds = await this.prismaRepository.openaiCreds.findUnique({
      where: { id: settings.openaiCredsId },
    });

    if (!creds) {
      this.logger.error(`OpenAI credentials not found. CredsId: ${settings.openaiCredsId}`);
      return null;
    }

    let audio: Buffer;

    if (msg.message.mediaUrl) {
      audio = await axios.get(msg.message.mediaUrl, { responseType: 'arraybuffer' }).then((response) => {
        return Buffer.from(response.data, 'binary');
      });
    } else if (msg.message.base64) {
      audio = Buffer.from(msg.message.base64, 'base64');
    } else {
      // Fallback for raw WhatsApp audio messages that need downloadMediaMessage
      audio = await downloadMediaMessage(
        { key: msg.key, message: msg?.message },
        'buffer',
        {},
        {
          logger: P({ level: 'error' }) as any,
          reuploadRequest: instance,
        },
      );
    }

    const lang = this.configService.get<Language>('LANGUAGE').includes('pt')
      ? 'pt'
      : this.configService.get<Language>('LANGUAGE');

    const formData = new FormData();
    formData.append('file', audio, 'audio.ogg');
    formData.append('model', 'whisper-1');
    formData.append('language', lang);

    const apiKey = creds?.apiKey || this.configService.get<OpenaiConfig>('OPENAI').API_KEY_GLOBAL;

    const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
        Authorization: `Bearer ${apiKey}`,
      },
    });

    return response?.data?.text;
  }
}
