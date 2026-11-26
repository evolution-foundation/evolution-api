import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { configService, EvolutionBot as EvolutionBotConfig } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { EvolutionBot, IntegrationSession } from '@prisma/client';

import { BaseChatbotController } from '../../base-chatbot.controller';
import { EvolutionBotDto } from '../dto/evolutionBot.dto';
import { EvolutionBotService } from '../services/evolutionBot.service';

export class EvolutionBotController extends BaseChatbotController<EvolutionBot, EvolutionBotDto> {
  constructor(
    private readonly evolutionBotService: EvolutionBotService,
    prismaRepository: PrismaRepository,
    waMonitor: WAMonitoringService,
  ) {
    super(prismaRepository, waMonitor);

    this.botRepository = this.prismaRepository.evolutionBot;
    this.settingsRepository = this.prismaRepository.evolutionBotSetting;
    this.sessionRepository = this.prismaRepository.integrationSession;
  }

  public readonly logger = new Logger('EvolutionBotController');
  protected readonly integrationName = 'EvolutionBot';

  integrationEnabled = configService.get<EvolutionBotConfig>('EVOLUTIONBOT').ENABLED ?? true;
  botRepository: any;
  settingsRepository: any;
  sessionRepository: any;
  userMessageDebounce: { [key: string]: { message: string; timeoutId: NodeJS.Timeout } } = {};

  // Implementation of abstract methods required by BaseChatbotController

  protected getFallbackBotId(settings: any): string | undefined {
    return settings?.botIdFallback;
  }

  protected getFallbackFieldName(): string {
    return 'botIdFallback';
  }

  protected getIntegrationType(): string {
    return 'evolution';
  }

  protected getAdditionalBotData(data: EvolutionBotDto): Record<string, any> {
    return {
      apiUrl: data.apiUrl,
      apiKey: data.apiKey,
    };
  }

  // Implementation for bot-specific updates
  protected getAdditionalUpdateFields(data: EvolutionBotDto): Record<string, any> {
    return {
      apiUrl: data.apiUrl,
      apiKey: data.apiKey,
    };
  }

  // Implementation for bot-specific duplicate validation on update
  protected async validateNoDuplicatesOnUpdate(
    botId: string,
    instanceId: string,
    data: EvolutionBotDto,
  ): Promise<void> {
    const checkDuplicate = await this.botRepository.findFirst({
      where: {
        id: {
          not: botId,
        },
        instanceId: instanceId,
        apiUrl: data.apiUrl,
        apiKey: data.apiKey,
      },
    });

    if (checkDuplicate) {
      throw new Error('Evolution Bot already exists');
    }
  }

  // Process bot-specific logic
  protected async processBot(
    instance: any,
    remoteJid: string,
    bot: EvolutionBot,
    session: IntegrationSession,
    settings: any,
    content: string,
    pushName?: string,
    msg?: any,
  ) {
    await this.evolutionBotService.process(instance, remoteJid, bot, session, settings, content, pushName, msg);
  }
}
