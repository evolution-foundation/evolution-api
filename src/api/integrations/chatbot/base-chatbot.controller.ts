import { IgnoreJidDto } from '@api/dto/chatbot.dto';
import { InstanceDto } from '@api/dto/instance.dto';
import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Events } from '@api/types/wa.types';
import { Logger } from '@config/logger.config';
import { BadRequestException } from '@exceptions';
import { TriggerOperator, TriggerType } from '@prisma/client';
import { getConversationMessage } from '@utils/getConversationMessage';

import { BaseChatbotDto } from './base-chatbot.dto';
import { ChatbotController, ChatbotControllerInterface, EmitData } from './chatbot.controller';

// Common settings interface for all chatbot integrations
export interface ChatbotSettings {
  expire: number;
  keywordFinish: string;
  delayMessage: number;
  unknownMessage: string;
  listeningFromMe: boolean;
  stopBotFromMe: boolean;
  keepOpen: boolean;
  debounceTime: number;
  ignoreJids: string[];
  splitMessages: boolean;
  timePerChar: number;
  [key: string]: any;
}

// Common bot properties for all chatbot integrations
export interface BaseBotData {
  enabled?: boolean;
  description: string;
  expire?: number;
  keywordFinish?: string;
  delayMessage?: number;
  unknownMessage?: string;
  listeningFromMe?: boolean;
  stopBotFromMe?: boolean;
  keepOpen?: boolean;
  debounceTime?: number;
  triggerType: string | TriggerType;
  triggerOperator?: string | TriggerOperator;
  triggerValue?: string;
  ignoreJids?: string[];
  splitMessages?: boolean;
  timePerChar?: number;
  [key: string]: any;
}

export abstract class BaseChatbotController<BotType = any, BotData extends BaseChatbotDto = BaseChatbotDto>
  extends ChatbotController
  implements ChatbotControllerInterface
{
  public readonly logger: Logger;

  integrationEnabled: boolean;
  botRepository: any;
  settingsRepository: any;
  sessionRepository: any;
  userMessageDebounce: { [key: string]: { message: string; timeoutId: NodeJS.Timeout } } = {};

  // Name of the integration, to be set by the derived class
  protected abstract readonly integrationName: string;

  // Method to process bot-specific logic
  protected abstract processBot(
    waInstance: any,
    remoteJid: string,
    bot: BotType,
    session: any,
    settings: ChatbotSettings,
    content: string,
    pushName?: string,
    msg?: any,
  ): Promise<void>;

  // Method to get the fallback bot ID from settings
  protected abstract getFallbackBotId(settings: any): string | undefined;

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor);

    this.sessionRepository = this.prismaRepository.integrationSession;
  }

  // Base create bot implementation
  public async createBot(instance: InstanceDto, data: BotData) {
    if (!this.integrationEnabled) throw new BadRequestException(`${this.integrationName} is disabled`);

    const instanceId = await this.prismaRepository.instance
      .findFirst({
        where: {
          name: instance.instanceName,
        },
      })
      .then((instance) => instance.id);

    // Set default settings if not provided
    if (
      !data.expire ||
      !data.keywordFinish ||
      !data.delayMessage ||
      !data.unknownMessage ||
      !data.listeningFromMe ||
      !data.stopBotFromMe ||
      !data.keepOpen ||
      !data.debounceTime ||
      !data.ignoreJids ||
      !data.splitMessages ||
      !data.timePerChar
    ) {
      const defaultSettingCheck = await this.settingsRepository.findFirst({
        where: {
          instanceId: instanceId,
        },
      });

      if (data.expire === undefined || data.expire === null) data.expire = defaultSettingCheck?.expire;
      if (data.keywordFinish === undefined || data.keywordFinish === null)
        data.keywordFinish = defaultSettingCheck?.keywordFinish;
      if (data.delayMessage === undefined || data.delayMessage === null)
        data.delayMessage = defaultSettingCheck?.delayMessage;
      if (data.unknownMessage === undefined || data.unknownMessage === null)
        data.unknownMessage = defaultSettingCheck?.unknownMessage;
      if (data.listeningFromMe === undefined || data.listeningFromMe === null)
        data.listeningFromMe = defaultSettingCheck?.listeningFromMe;
      if (data.stopBotFromMe === undefined || data.stopBotFromMe === null)
        data.stopBotFromMe = defaultSettingCheck?.stopBotFromMe;
      if (data.keepOpen === undefined || data.keepOpen === null) data.keepOpen = defaultSettingCheck?.keepOpen;
      if (data.debounceTime === undefined || data.debounceTime === null)
        data.debounceTime = defaultSettingCheck?.debounceTime;
      if (data.ignoreJids === undefined || data.ignoreJids === null) data.ignoreJids = defaultSettingCheck?.ignoreJids;
      if (data.splitMessages === undefined || data.splitMessages === null)
        data.splitMessages = defaultSettingCheck?.splitMessages ?? false;
      if (data.timePerChar === undefined || data.timePerChar === null)
        data.timePerChar = defaultSettingCheck?.timePerChar ?? 0;

      if (!defaultSettingCheck) {
        await this.settings(instance, {
          expire: data.expire,
          keywordFinish: data.keywordFinish,
          delayMessage: data.delayMessage,
          unknownMessage: data.unknownMessage,
          listeningFromMe: data.listeningFromMe,
          stopBotFromMe: data.stopBotFromMe,
          keepOpen: data.keepOpen,
          debounceTime: data.debounceTime,
          ignoreJids: data.ignoreJids,
          splitMessages: data.splitMessages,
          timePerChar: data.timePerChar,
        });
      }
    }

    const checkTriggerAll = await this.botRepository.findFirst({
      where: {
        enabled: true,
        triggerType: 'all',
        instanceId: instanceId,
      },
    });

    if (checkTriggerAll && data.triggerType === 'all') {
      throw new Error(
        `You already have a ${this.integrationName} with an "All" trigger, you cannot have more bots while it is active`,
      );
    }

    // Check for trigger keyword duplicates
    if (data.triggerType === 'keyword') {
      if (!data.triggerOperator || !data.triggerValue) {
        throw new Error('Trigger operator and value are required');
      }

      const checkDuplicate = await this.botRepository.findFirst({
        where: {
          triggerOperator: data.triggerOperator,
          triggerValue: data.triggerValue,
          instanceId: instanceId,
        },
      });

      if (checkDuplicate) {
        throw new Error('Trigger already exists');
      }
    }

    // Check for trigger advanced duplicates
    if (data.triggerType === 'advanced') {
      if (!data.triggerValue) {
        throw new Error('Trigger value is required');
      }

      const checkDuplicate = await this.botRepository.findFirst({
        where: {
          triggerValue: data.triggerValue,
          instanceId: instanceId,
        },
      });

      if (checkDuplicate) {
        throw new Error('Trigger already exists');
      }
    }

    // Derived classes should implement the specific duplicate checking before calling this method
    // and add bot-specific fields to the data object

    try {
      const botData = {
        enabled: data?.enabled,
        description: data.description,
        expire: data.expire,
        keywordFinish: data.keywordFinish,
        delayMessage: data.delayMessage,
        unknownMessage: data.unknownMessage,
        listeningFromMe: data.listeningFromMe,
        stopBotFromMe: data.stopBotFromMe,
        keepOpen: data.keepOpen,
        debounceTime: data.debounceTime,
        instanceId: instanceId,
        triggerType: data.triggerType,
        triggerOperator: data.triggerOperator,
        triggerValue: data.triggerValue,
        ignoreJids: data.ignoreJids,
        splitMessages: data.splitMessages,
        timePerChar: data.timePerChar,
        ...this.getAdditionalBotData(data),
      };

      const bot = await this.botRepository.create({
        data: botData,
      });

      return bot;
    } catch (error) {
      this.logger.error(error);
      throw new Error(`Error creating ${this.integrationName}`);
    }
  }

  // Additional fields needed for specific bot types
  protected abstract getAdditionalBotData(data: BotData): Record<string, any>;

  // Common implementation for findBot
  public async findBot(instance: InstanceDto) {
    if (!this.integrationEnabled) throw new BadRequestException(`${this.integrationName} is disabled`);

    const instanceId = await this.prismaRepository.instance
      .findFirst({
        where: {
          name: instance.instanceName,
        },
      })
      .then((instance) => instance.id);

    try {
      const bots = await this.botRepository.findMany({
        where: {
          instanceId: instanceId,
        },
      });

      return bots;
    } catch (error) {
      this.logger.error(error);
      throw new Error(`Error finding ${this.integrationName}`);
    }
  }

  // Common implementation for fetchBot
  public async fetchBot(instance: InstanceDto, botId: string) {
    if (!this.integrationEnabled) throw new BadRequestException(`${this.integrationName} is disabled`);

    try {
      const bot = await this.botRepository.findUnique({
        where: {
          id: botId,
        },
      });

      if (!bot) {
        return null;
      }

      return bot;
    } catch (error) {
      this.logger.error(error);
      throw new Error(`Error fetching ${this.integrationName}`);
    }
  }

  // Common implementation for settings
  public async settings(instance: InstanceDto, data: any) {
    if (!this.integrationEnabled) throw new BadRequestException(`${this.integrationName} is disabled`);

    try {
      const instanceId = await this.prismaRepository.instance
        .findFirst({
          where: {
            name: instance.instanceName,
          },
        })
        .then((instance) => instance.id);

      const existingSettings = await this.settingsRepository.findFirst({
        where: {
          instanceId: instanceId,
        },
      });

      // Get the name of the fallback field for this integration type
      const fallbackFieldName = this.getFallbackFieldName();

      const settingsData = {
        expire: data.expire,
        keywordFinish: data.keywordFinish,
        delayMessage: data.delayMessage,
        unknownMessage: data.unknownMessage,
        listeningFromMe: data.listeningFromMe,
        stopBotFromMe: data.stopBotFromMe,
        keepOpen: data.keepOpen,
        debounceTime: data.debounceTime,
        ignoreJids: data.ignoreJids,
        splitMessages: data.splitMessages,
        timePerChar: data.timePerChar,
        [fallbackFieldName]: data.fallbackId, // Use the correct field name dynamically
      };

      if (existingSettings) {
        const settings = await this.settingsRepository.update({
          where: {
            id: existingSettings.id,
          },
          data: settingsData,
        });

        // Map the specific fallback field to a generic 'fallbackId' in the response
        return {
          ...settings,
          fallbackId: settings[fallbackFieldName],
        };
      } else {
        const settings = await this.settingsRepository.create({
          data: {
            ...settingsData,
            Instance: {
              connect: {
                id: instanceId,
              },
            },
          },
        });

        // Map the specific fallback field to a generic 'fallbackId' in the response
        return {
          ...settings,
          fallbackId: settings[fallbackFieldName],
        };
      }
    } catch (error) {
      this.logger.error(error);
      throw new Error('Error setting default settings');
    }
  }

  // Abstract method to get the field name for the fallback ID
  protected abstract getFallbackFieldName(): string;

  // Abstract method to get the integration type (dify, n8n, evoai, etc.)
  protected abstract getIntegrationType(): string;

  // Common implementation for fetchSettings
  public async fetchSettings(instance: InstanceDto) {
    if (!this.integrationEnabled) throw new BadRequestException(`${this.integrationName} is disabled`);

    try {
      const instanceId = await this.prismaRepository.instance
        .findFirst({
          where: {
            name: instance.instanceName,
          },
        })
        .then((instance) => instance.id);

      const settings = await this.settingsRepository.findFirst({
        where: {
          instanceId: instanceId,
        },
        include: {
          Fallback: true,
        },
      });

      // Get the name of the fallback field for this integration type
      const fallbackFieldName = this.getFallbackFieldName();

      if (!settings) {
        return {
          expire: 300,
          keywordFinish: 'bye',
          delayMessage: 1000,
          unknownMessage: 'Sorry, I dont understand',
          listeningFromMe: true,
          stopBotFromMe: true,
          keepOpen: false,
          debounceTime: 1,
          ignoreJids: [],
          splitMessages: false,
          timePerChar: 0,
          fallbackId: '',
          fallback: null,
        };
      }

      // Return with standardized fallbackId field
      return {
        ...settings,
        fallbackId: settings[fallbackFieldName],
        fallback: settings.Fallback,
      };
    } catch (error) {
      this.logger.error(error);
      throw new Error('Error fetching settings');
    }
  }

  // Common implementation for changeStatus
  public async changeStatus(instance: InstanceDto, data: any) {
    if (!this.integrationEnabled) throw new BadRequestException(`${this.integrationName} is disabled`);

    try {
      const instanceId = await this.prismaRepository.instance
        .findFirst({
          where: {
            name: instance.instanceName,
          },
        })
        .then((instance) => instance.id);

      const defaultSettingCheck = await this.settingsRepository.findFirst({
        where: {
          instanceId,
        },
      });

      const remoteJid = data.remoteJid;
      const status = data.status;
      const session = await this.getSession(remoteJid, instance);

      if (this.integrationName === 'Typebot') {
        const typebotData = {
          remoteJid: remoteJid,
          status: status,
          session,
        };
        this.waMonitor.waInstances[instance.instanceName].sendDataWebhook(Events.TYPEBOT_CHANGE_STATUS, typebotData);
      }

      if (status === 'delete') {
        await this.sessionRepository.deleteMany({
          where: {
            remoteJid: remoteJid,
            botId: { not: null },
          },
        });

        return { bot: { remoteJid: remoteJid, status: status } };
      }

      if (status === 'closed') {
        if (defaultSettingCheck?.keepOpen) {
          await this.sessionRepository.updateMany({
            where: {
              remoteJid: remoteJid,
              botId: { not: null },
            },
            data: {
              status: 'closed',
            },
          });
        } else {
          await this.sessionRepository.deleteMany({
            where: {
              remoteJid: remoteJid,
              botId: { not: null },
            },
          });
        }

        return { bot: { ...instance, bot: { remoteJid: remoteJid, status: status } } };
      } else {
        const session = await this.sessionRepository.updateMany({
          where: {
            instanceId: instanceId,
            remoteJid: remoteJid,
            botId: { not: null },
          },
          data: {
            status: status,
          },
        });

        const botData = {
          remoteJid: remoteJid,
          status: status,
          session,
        };

        return { bot: { ...instance, bot: botData } };
      }
    } catch (error) {
      this.logger.error(error);
      throw new Error(`Error changing ${this.integrationName} status`);
    }
  }

  // Common implementation for fetchSessions
  public async fetchSessions(instance: InstanceDto, botId: string, remoteJid?: string) {
    if (!this.integrationEnabled) throw new BadRequestException(`${this.integrationName} is disabled`);

    try {
      const instanceId = await this.prismaRepository.instance
        .findFirst({
          where: {
            name: instance.instanceName,
          },
        })
        .then((instance) => instance.id);

      const bot = await this.botRepository.findFirst({
        where: {
          id: botId,
        },
      });

      if (bot && bot.instanceId !== instanceId) {
        throw new Error(`${this.integrationName} not found`);
      }

      // Get the integration type (dify, n8n, evoai, etc.)
      const integrationType = this.getIntegrationType();

      return await this.sessionRepository.findMany({
        where: {
          instanceId: instanceId,
          remoteJid,
          botId: bot ? botId : { not: null },
          type: integrationType,
        },
      });
    } catch (error) {
      this.logger.error(error);
      throw new Error('Error fetching sessions');
    }
  }

  // Common implementation for ignoreJid
  public async ignoreJid(instance: InstanceDto, data: IgnoreJidDto) {
    if (!this.integrationEnabled) throw new BadRequestException(`${this.integrationName} is disabled`);

    try {
      const instanceId = await this.prismaRepository.instance
        .findFirst({
          where: {
            name: instance.instanceName,
          },
        })
        .then((instance) => instance.id);

      const settings = await this.settingsRepository.findFirst({
        where: {
          instanceId: instanceId,
        },
      });

      if (!settings) {
        throw new Error('Settings not found');
      }

      let ignoreJids: any = settings?.ignoreJids || [];

      if (data.action === 'add') {
        if (ignoreJids.includes(data.remoteJid)) return { ignoreJids: ignoreJids };

        ignoreJids.push(data.remoteJid);
      } else {
        ignoreJids = ignoreJids.filter((jid) => jid !== data.remoteJid);
      }

      const updateSettings = await this.settingsRepository.update({
        where: {
          id: settings.id,
        },
        data: {
          ignoreJids: ignoreJids,
        },
      });

      return {
        ignoreJids: updateSettings.ignoreJids,
      };
    } catch (error) {
      this.logger.error(error);
      throw new Error('Error setting default settings');
    }
  }

  // Base implementation for updateBot
  public async updateBot(instance: InstanceDto, botId: string, data: BotData) {
    if (!this.integrationEnabled) throw new BadRequestException(`${this.integrationName} is disabled`);

    try {
      const instanceId = await this.prismaRepository.instance
        .findFirst({
          where: {
            name: instance.instanceName,
          },
        })
        .then((instance) => instance.id);

      const bot = await this.botRepository.findFirst({
        where: {
          id: botId,
        },
      });

      if (!bot) {
        throw new Error(`${this.integrationName} not found`);
      }

      if (bot.instanceId !== instanceId) {
        throw new Error(`${this.integrationName} not found`);
      }

      // Check for "all" trigger type conflicts
      if (data.triggerType === 'all') {
        const checkTriggerAll = await this.botRepository.findFirst({
          where: {
            enabled: true,
            triggerType: 'all',
            id: {
              not: botId,
            },
            instanceId: instanceId,
          },
        });

        if (checkTriggerAll) {
          throw new Error(
            `You already have a ${this.integrationName} with an "All" trigger, you cannot have more bots while it is active`,
          );
        }
      }

      // Let subclasses check for integration-specific duplicates
      await this.validateNoDuplicatesOnUpdate(botId, instanceId, data);

      // Check for keyword trigger duplicates
      if (data.triggerType === 'keyword') {
        if (!data.triggerOperator || !data.triggerValue) {
          throw new Error('Trigger operator and value are required');
        }

        const checkDuplicate = await this.botRepository.findFirst({
          where: {
            triggerOperator: data.triggerOperator,
            triggerValue: data.triggerValue,
            id: { not: botId },
            instanceId: instanceId,
          },
        });

        if (checkDuplicate) {
          throw new Error('Trigger already exists');
        }
      }

      // Check for advanced trigger duplicates
      if (data.triggerType === 'advanced') {
        if (!data.triggerValue) {
          throw new Error('Trigger value is required');
        }

        const checkDuplicate = await this.botRepository.findFirst({
          where: {
            triggerValue: data.triggerValue,
            id: { not: botId },
            instanceId: instanceId,
          },
        });

        if (checkDuplicate) {
          throw new Error('Trigger already exists');
        }
      }

      // Combine common fields with bot-specific fields
      const updateData = {
        enabled: data?.enabled,
        description: data.description,
        expire: data.expire,
        keywordFinish: data.keywordFinish,
        delayMessage: data.delayMessage,
        unknownMessage: data.unknownMessage,
        listeningFromMe: data.listeningFromMe,
        stopBotFromMe: data.stopBotFromMe,
        keepOpen: data.keepOpen,
        debounceTime: data.debounceTime,
        instanceId: instanceId,
        triggerType: data.triggerType,
        triggerOperator: data.triggerOperator,
        triggerValue: data.triggerValue,
        ignoreJids: data.ignoreJids,
        splitMessages: data.splitMessages,
        timePerChar: data.timePerChar,
        ...this.getAdditionalUpdateFields(data),
      };

      const updatedBot = await this.botRepository.update({
        where: {
          id: botId,
        },
        data: updateData,
      });

      return updatedBot;
    } catch (error) {
      this.logger.error(error);
      throw new Error(`Error updating ${this.integrationName}`);
    }
  }

  // Abstract method for validating bot-specific duplicates on update
  protected abstract validateNoDuplicatesOnUpdate(botId: string, instanceId: string, data: BotData): Promise<void>;

  // Abstract method for getting additional fields for update
  protected abstract getAdditionalUpdateFields(data: BotData): Record<string, any>;

  // Base implementation for deleteBot
  public async deleteBot(instance: InstanceDto, botId: string) {
    if (!this.integrationEnabled) throw new BadRequestException(`${this.integrationName} is disabled`);

    try {
      const instanceId = await this.prismaRepository.instance
        .findFirst({
          where: {
            name: instance.instanceName,
          },
        })
        .then((instance) => instance.id);

      const bot = await this.botRepository.findFirst({
        where: {
          id: botId,
        },
      });

      if (!bot) {
        throw new Error(`${this.integrationName} not found`);
      }

      if (bot.instanceId !== instanceId) {
        throw new Error(`${this.integrationName} not found`);
      }

      await this.prismaRepository.integrationSession.deleteMany({
        where: {
          botId: botId,
        },
      });

      await this.botRepository.delete({
        where: {
          id: botId,
        },
      });

      return { bot: { id: botId } };
    } catch (error) {
      this.logger.error(error);
      throw new Error(`Error deleting ${this.integrationName} bot`);
    }
  }

  // Base implementation for emit
  public async emit({ instance, remoteJid, msg }: EmitData) {
    if (!this.integrationEnabled) return;

    try {
      const settings = await this.settingsRepository.findFirst({
        where: {
          instanceId: instance.instanceId,
        },
      });

      if (this.checkIgnoreJids(settings?.ignoreJids, remoteJid)) return;

      const session = await this.getSession(remoteJid, instance);

      const content = getConversationMessage(msg);

      // Get integration type
      // const integrationType = this.getIntegrationType();

      // Find a bot for this message
      let findBot: any = await this.findBotTrigger(this.botRepository, content, instance, session);

      // If no bot is found, try to use fallback
      if (!findBot) {
        const fallback = await this.settingsRepository.findFirst({
          where: {
            instanceId: instance.instanceId,
          },
        });

        // Get the fallback ID for this integration type
        const fallbackId = this.getFallbackBotId(fallback);

        if (fallbackId) {
          const findFallback = await this.botRepository.findFirst({
            where: {
              id: fallbackId,
            },
          });

          findBot = findFallback;
        } else {
          return;
        }
      }

      // If we still don't have a bot, return
      if (!findBot) {
        return;
      }

      // Collect settings with fallbacks to default settings
      let expire = findBot.expire;
      let keywordFinish = findBot.keywordFinish;
      let delayMessage = findBot.delayMessage;
      let unknownMessage = findBot.unknownMessage;
      let listeningFromMe = findBot.listeningFromMe;
      let stopBotFromMe = findBot.stopBotFromMe;
      let keepOpen = findBot.keepOpen;
      let debounceTime = findBot.debounceTime;
      let ignoreJids = findBot.ignoreJids;
      let splitMessages = findBot.splitMessages;
      let timePerChar = findBot.timePerChar;

      if (expire === undefined || expire === null) expire = settings.expire;
      if (keywordFinish === undefined || keywordFinish === null) keywordFinish = settings.keywordFinish;
      if (delayMessage === undefined || delayMessage === null) delayMessage = settings.delayMessage;
      if (unknownMessage === undefined || unknownMessage === null) unknownMessage = settings.unknownMessage;
      if (listeningFromMe === undefined || listeningFromMe === null) listeningFromMe = settings.listeningFromMe;
      if (stopBotFromMe === undefined || stopBotFromMe === null) stopBotFromMe = settings.stopBotFromMe;
      if (keepOpen === undefined || keepOpen === null) keepOpen = settings.keepOpen;
      if (debounceTime === undefined || debounceTime === null) debounceTime = settings.debounceTime;
      if (ignoreJids === undefined || ignoreJids === null) ignoreJids = settings.ignoreJids;
      if (splitMessages === undefined || splitMessages === null) splitMessages = settings?.splitMessages ?? false;
      if (timePerChar === undefined || timePerChar === null) timePerChar = settings?.timePerChar ?? 0;

      const key = msg.key as {
        id: string;
        remoteJid: string;
        fromMe: boolean;
        participant: string;
      };

      // Handle stopping the bot if message is from me
      if (stopBotFromMe && key.fromMe && session) {
        await this.prismaRepository.integrationSession.update({
          where: {
            id: session.id,
          },
          data: {
            status: 'paused',
          },
        });

        if (this.integrationName === 'Typebot') {
          const typebotData = {
            remoteJid: remoteJid,
            status: 'paused',
            session,
          };
          this.waMonitor.waInstances[instance.instanceName].sendDataWebhook(Events.TYPEBOT_CHANGE_STATUS, typebotData);
        }

        return;
      }

      // Skip if not listening to messages from me
      if (!listeningFromMe && key.fromMe) {
        return;
      }

      // Skip if session exists but not awaiting user input
      if (session && session.status === 'closed') {
        return;
      }

      // Merged settings
      const mergedSettings = {
        ...settings,
        expire,
        keywordFinish,
        delayMessage,
        unknownMessage,
        listeningFromMe,
        stopBotFromMe,
        keepOpen,
        debounceTime,
        ignoreJids,
        splitMessages,
        timePerChar,
      };

      // Process with debounce if needed
      if (debounceTime && debounceTime > 0) {
        this.processDebounce(this.userMessageDebounce, content, remoteJid, debounceTime, async (debouncedContent) => {
          await this.processBot(
            this.waMonitor.waInstances[instance.instanceName],
            remoteJid,
            findBot,
            session,
            mergedSettings,
            debouncedContent,
            msg?.pushName,
            msg,
          );
        });
      } else {
        await this.processBot(
          this.waMonitor.waInstances[instance.instanceName],
          remoteJid,
          findBot,
          session,
          mergedSettings,
          content,
          msg?.pushName,
          msg,
        );
      }
    } catch (error) {
      this.logger.error(error);
    }
  }
}
