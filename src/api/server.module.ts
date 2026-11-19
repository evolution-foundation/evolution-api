import { CacheEngine } from '@cache/cacheengine';
import { Chatwoot, configService, ProviderSession } from '@config/env.config';
import { eventEmitter } from '@config/event.config';
import { Logger } from '@config/logger.config';

import { BusinessController } from './controllers/business.controller';
import { CallController } from './controllers/call.controller';
import { ChatController } from './controllers/chat.controller';
import { GroupController } from './controllers/group.controller';
import { InstanceController } from './controllers/instance.controller';
import { LabelController } from './controllers/label.controller';
import { ProxyController } from './controllers/proxy.controller';
import { SendMessageController } from './controllers/sendMessage.controller';
import { SettingsController } from './controllers/settings.controller';
import { TemplateController } from './controllers/template.controller';
import { ChannelController } from './integrations/channel/channel.controller';
import { EvolutionController } from './integrations/channel/evolution/evolution.controller';
import { MetaController } from './integrations/channel/meta/meta.controller';
import { BaileysController } from './integrations/channel/whatsapp/baileys.controller';
import { ChatbotController } from './integrations/chatbot/chatbot.controller';
import { ChatwootController } from './integrations/chatbot/chatwoot/controllers/chatwoot.controller';
import { ChatwootService } from './integrations/chatbot/chatwoot/services/chatwoot.service';
import { DifyController } from './integrations/chatbot/dify/controllers/dify.controller';
import { DifyService } from './integrations/chatbot/dify/services/dify.service';
import { EvoaiController } from './integrations/chatbot/evoai/controllers/evoai.controller';
import { EvoaiService } from './integrations/chatbot/evoai/services/evoai.service';
import { EvolutionBotController } from './integrations/chatbot/evolutionBot/controllers/evolutionBot.controller';
import { EvolutionBotService } from './integrations/chatbot/evolutionBot/services/evolutionBot.service';
import { FlowiseController } from './integrations/chatbot/flowise/controllers/flowise.controller';
import { FlowiseService } from './integrations/chatbot/flowise/services/flowise.service';
import { N8nController } from './integrations/chatbot/n8n/controllers/n8n.controller';
import { N8nService } from './integrations/chatbot/n8n/services/n8n.service';
import { OpenaiController } from './integrations/chatbot/openai/controllers/openai.controller';
import { OpenaiService } from './integrations/chatbot/openai/services/openai.service';
import { TypebotController } from './integrations/chatbot/typebot/controllers/typebot.controller';
import { TypebotService } from './integrations/chatbot/typebot/services/typebot.service';
import { EventManager } from './integrations/event/event.manager';
import { S3Controller } from './integrations/storage/s3/controllers/s3.controller';
import { S3Service } from './integrations/storage/s3/services/s3.service';
import { ProviderFiles } from './provider/sessions';
import { PrismaRepository } from './repository/repository.service';
import { CacheService } from './services/cache.service';
import { WAMonitoringService } from './services/monitor.service';
import { ProxyService } from './services/proxy.service';
import { SettingsService } from './services/settings.service';
import { TemplateService } from './services/template.service';

const logger = new Logger('WA MODULE');

let chatwootCache: CacheService = null;
if (configService.get<Chatwoot>('CHATWOOT').ENABLED) {
  chatwootCache = new CacheService(new CacheEngine(configService, ChatwootService.name).getEngine());
}

export const cache = new CacheService(new CacheEngine(configService, 'instance').getEngine());
const baileysCache = new CacheService(new CacheEngine(configService, 'baileys').getEngine());

let providerFiles: ProviderFiles = null;
if (configService.get<ProviderSession>('PROVIDER').ENABLED) {
  providerFiles = new ProviderFiles(configService);
}

export const prismaRepository = new PrismaRepository(configService);

export const waMonitor = new WAMonitoringService(
  eventEmitter,
  configService,
  prismaRepository,
  providerFiles,
  cache,
  chatwootCache,
  baileysCache,
);

const s3Service = new S3Service(prismaRepository);
export const s3Controller = new S3Controller(s3Service);

const templateService = new TemplateService(waMonitor, prismaRepository, configService);
export const templateController = new TemplateController(templateService);

const proxyService = new ProxyService(waMonitor);
export const proxyController = new ProxyController(proxyService, waMonitor);

const chatwootService = new ChatwootService(waMonitor, configService, prismaRepository, chatwootCache);
export const chatwootController = new ChatwootController(chatwootService, configService);

const settingsService = new SettingsService(waMonitor);
export const settingsController = new SettingsController(settingsService);

export const instanceController = new InstanceController(
  waMonitor,
  configService,
  prismaRepository,
  eventEmitter,
  chatwootService,
  settingsService,
  proxyController,
  cache,
  chatwootCache,
  baileysCache,
  providerFiles,
);
export const sendMessageController = new SendMessageController(waMonitor);
export const callController = new CallController(waMonitor);
export const chatController = new ChatController(waMonitor);
export const businessController = new BusinessController(waMonitor);
export const groupController = new GroupController(waMonitor);
export const labelController = new LabelController(waMonitor);

export const eventManager = new EventManager(prismaRepository, waMonitor);
export const chatbotController = new ChatbotController(prismaRepository, waMonitor);
export const channelController = new ChannelController(prismaRepository, waMonitor);

// channels
export const evolutionController = new EvolutionController(prismaRepository, waMonitor);
export const metaController = new MetaController(prismaRepository, waMonitor);
export const baileysController = new BaileysController(waMonitor);

const openaiService = new OpenaiService(waMonitor, prismaRepository, configService);
export const openaiController = new OpenaiController(openaiService, prismaRepository, waMonitor);

// chatbots
const typebotService = new TypebotService(waMonitor, configService, prismaRepository, openaiService);
export const typebotController = new TypebotController(typebotService, prismaRepository, waMonitor);

const difyService = new DifyService(waMonitor, prismaRepository, configService, openaiService);
export const difyController = new DifyController(difyService, prismaRepository, waMonitor);

const evolutionBotService = new EvolutionBotService(waMonitor, prismaRepository, configService, openaiService);
export const evolutionBotController = new EvolutionBotController(evolutionBotService, prismaRepository, waMonitor);

const flowiseService = new FlowiseService(waMonitor, prismaRepository, configService, openaiService);
export const flowiseController = new FlowiseController(flowiseService, prismaRepository, waMonitor);

const n8nService = new N8nService(waMonitor, prismaRepository, configService, openaiService);
export const n8nController = new N8nController(n8nService, prismaRepository, waMonitor);

const evoaiService = new EvoaiService(waMonitor, prismaRepository, configService, openaiService);
export const evoaiController = new EvoaiController(evoaiService, prismaRepository, waMonitor);

logger.info('Module - ON');
