import { InstanceDto } from '@api/dto/instance.dto';
import { MinimaxCredsDto, MinimaxDto } from '@api/integrations/chatbot/minimax/dto/minimax.dto';
import { MinimaxService } from '@api/integrations/chatbot/minimax/services/minimax.service';
import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { configService, Minimax } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BadRequestException } from '@exceptions';
import { IntegrationSession } from '@prisma/client';

import { BaseChatbotController } from '../../base-chatbot.controller';

// MiniMax bot type
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

export class MinimaxController extends BaseChatbotController<MinimaxBot, MinimaxDto> {
  constructor(
    private readonly minimaxService: MinimaxService,
    prismaRepository: PrismaRepository,
    waMonitor: WAMonitoringService,
  ) {
    super(prismaRepository, waMonitor);

    this.botRepository = this.prismaRepository.minimaxBot;
    this.settingsRepository = this.prismaRepository.minimaxSetting;
    this.sessionRepository = this.prismaRepository.integrationSession;
    this.credsRepository = this.prismaRepository.minimaxCreds;
  }

  public readonly logger = new Logger('MinimaxController');
  protected readonly integrationName = 'Minimax';

  integrationEnabled = configService.get<Minimax>('MINIMAX').ENABLED;
  botRepository: any;
  settingsRepository: any;
  sessionRepository: any;
  userMessageDebounce: { [key: string]: { message: string; timeoutId: NodeJS.Timeout } } = {};
  private credsRepository: any;

  protected getFallbackBotId(settings: any): string | undefined {
    return settings?.minimaxIdFallback;
  }

  protected getFallbackFieldName(): string {
    return 'minimaxIdFallback';
  }

  protected getIntegrationType(): string {
    return 'minimax';
  }

  protected getAdditionalBotData(data: MinimaxDto): Record<string, any> {
    return {
      minimaxCredsId: data.minimaxCredsId,
      model: data.model,
      systemMessages: data.systemMessages,
      assistantMessages: data.assistantMessages,
      userMessages: data.userMessages,
      maxTokens: data.maxTokens,
    };
  }

  protected getAdditionalUpdateFields(data: MinimaxDto): Record<string, any> {
    return {
      minimaxCredsId: data.minimaxCredsId,
      model: data.model,
      systemMessages: data.systemMessages,
      assistantMessages: data.assistantMessages,
      userMessages: data.userMessages,
      maxTokens: data.maxTokens,
    };
  }

  protected async validateNoDuplicatesOnUpdate(botId: string, instanceId: string, data: MinimaxDto): Promise<void> {
    if (!data.model) throw new Error('Model is required');

    const checkDuplicate = await this.botRepository.findFirst({
      where: {
        id: { not: botId },
        instanceId: instanceId,
        model: data.model,
        maxTokens: data.maxTokens,
      },
    });

    if (checkDuplicate) {
      throw new Error('MiniMax Bot already exists');
    }
  }

  public async createBot(instance: InstanceDto, data: MinimaxDto) {
    if (!this.integrationEnabled) throw new BadRequestException('MiniMax is disabled');

    const instanceId = await this.prismaRepository.instance
      .findFirst({
        where: { name: instance.instanceName },
      })
      .then((instance) => instance.id);

    // MiniMax-specific validation
    if (!data.model) throw new Error('Model is required');

    const checkDuplicate = await this.botRepository.findFirst({
      where: {
        instanceId: instanceId,
        model: data.model,
        maxTokens: data.maxTokens,
      },
    });

    if (checkDuplicate) {
      throw new Error('MiniMax Bot already exists');
    }

    // Check if settings exist and create them if not
    const existingSettings = await this.settingsRepository.findFirst({
      where: { instanceId: instanceId },
    });

    if (!existingSettings) {
      await this.settings(instance, {
        minimaxCredsId: data.minimaxCredsId,
        expire: data.expire || 300,
        keywordFinish: data.keywordFinish || 'bye',
        delayMessage: data.delayMessage || 1000,
        unknownMessage: data.unknownMessage || 'Sorry, I dont understand',
        listeningFromMe: data.listeningFromMe !== undefined ? data.listeningFromMe : true,
        stopBotFromMe: data.stopBotFromMe !== undefined ? data.stopBotFromMe : true,
        keepOpen: data.keepOpen !== undefined ? data.keepOpen : false,
        debounceTime: data.debounceTime || 1,
        ignoreJids: data.ignoreJids || [],
      });
    } else if (!existingSettings.minimaxCredsId && data.minimaxCredsId) {
      await this.settingsRepository.update({
        where: { id: existingSettings.id },
        data: {
          MinimaxCreds: {
            connect: { id: data.minimaxCredsId },
          },
        },
      });
    }

    return super.createBot(instance, data);
  }

  protected async processBot(
    instance: any,
    remoteJid: string,
    bot: MinimaxBot,
    session: IntegrationSession,
    settings: any,
    content: string,
    pushName?: string,
    msg?: any,
  ) {
    await this.minimaxService.process(instance, remoteJid, bot, session, settings, content, pushName, msg);
  }

  // Credentials management
  public async createMinimaxCreds(instance: InstanceDto, data: MinimaxCredsDto) {
    if (!this.integrationEnabled) throw new BadRequestException('MiniMax is disabled');

    const instanceId = await this.prismaRepository.instance
      .findFirst({
        where: { name: instance.instanceName },
      })
      .then((instance) => instance.id);

    if (!data.apiKey) throw new BadRequestException('API Key is required');
    if (!data.name) throw new BadRequestException('Name is required');

    const existingApiKey = await this.credsRepository.findFirst({
      where: { apiKey: data.apiKey },
    });

    if (existingApiKey) {
      throw new BadRequestException('This API key is already registered. Please use a different API key.');
    }

    const existingName = await this.credsRepository.findFirst({
      where: { name: data.name, instanceId: instanceId },
    });

    if (existingName) {
      throw new BadRequestException('This credential name is already in use. Please choose a different name.');
    }

    try {
      const creds = await this.credsRepository.create({
        data: {
          name: data.name,
          apiKey: data.apiKey,
          instanceId: instanceId,
        },
      });

      return creds;
    } catch (error) {
      this.logger.error(error);
      throw new Error('Error creating MiniMax creds');
    }
  }

  public async findMinimaxCreds(instance: InstanceDto) {
    if (!this.integrationEnabled) throw new BadRequestException('MiniMax is disabled');

    const instanceId = await this.prismaRepository.instance
      .findFirst({
        where: { name: instance.instanceName },
      })
      .then((instance) => instance.id);

    const creds = await this.credsRepository.findMany({
      where: { instanceId: instanceId },
      include: { MinimaxBot: true },
    });

    return creds;
  }

  public async deleteCreds(instance: InstanceDto, minimaxCredsId: string) {
    if (!this.integrationEnabled) throw new BadRequestException('MiniMax is disabled');

    const instanceId = await this.prismaRepository.instance
      .findFirst({
        where: { name: instance.instanceName },
      })
      .then((instance) => instance.id);

    const creds = await this.credsRepository.findFirst({
      where: { id: minimaxCredsId },
    });

    if (!creds) {
      throw new Error('MiniMax Creds not found');
    }

    if (creds.instanceId !== instanceId) {
      throw new Error('MiniMax Creds not found');
    }

    try {
      await this.credsRepository.delete({
        where: { id: minimaxCredsId },
      });

      return { minimaxCreds: { id: minimaxCredsId } };
    } catch (error) {
      this.logger.error(error);
      throw new Error('Error deleting MiniMax creds');
    }
  }

  // Override settings to handle MiniMax credentials
  public async settings(instance: InstanceDto, data: any) {
    if (!this.integrationEnabled) throw new BadRequestException('MiniMax is disabled');

    try {
      const instanceId = await this.prismaRepository.instance
        .findFirst({
          where: { name: instance.instanceName },
        })
        .then((instance) => instance.id);

      const existingSettings = await this.settingsRepository.findFirst({
        where: { instanceId: instanceId },
      });

      const keywordFinish = data.keywordFinish;

      const settingsData = {
        expire: data.expire,
        keywordFinish,
        delayMessage: data.delayMessage,
        unknownMessage: data.unknownMessage,
        listeningFromMe: data.listeningFromMe,
        stopBotFromMe: data.stopBotFromMe,
        keepOpen: data.keepOpen,
        debounceTime: data.debounceTime,
        ignoreJids: data.ignoreJids,
        splitMessages: data.splitMessages,
        timePerChar: data.timePerChar,
        minimaxIdFallback: data.fallbackId,
        MinimaxCreds: data.minimaxCredsId
          ? {
              connect: { id: data.minimaxCredsId },
            }
          : undefined,
      };

      if (existingSettings) {
        const settings = await this.settingsRepository.update({
          where: { id: existingSettings.id },
          data: settingsData,
        });

        return {
          ...settings,
          fallbackId: settings.minimaxIdFallback,
        };
      } else {
        const settings = await this.settingsRepository.create({
          data: {
            ...settingsData,
            Instance: {
              connect: { id: instanceId },
            },
          },
        });

        return {
          ...settings,
          fallbackId: settings.minimaxIdFallback,
        };
      }
    } catch (error) {
      this.logger.error(error);
      throw new Error('Error setting default settings');
    }
  }

  // Models - return static list of MiniMax models
  public async getModels(instance: InstanceDto) {
    if (!this.integrationEnabled) throw new BadRequestException('MiniMax is disabled');

    // Validate instance exists
    const instanceRecord = await this.prismaRepository.instance.findFirst({
      where: { name: instance.instanceName },
    });

    if (!instanceRecord) throw new Error('Instance not found');

    return [
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' },
      { id: 'MiniMax-M2.5-highspeed', name: 'MiniMax M2.5 High Speed' },
    ];
  }
}
