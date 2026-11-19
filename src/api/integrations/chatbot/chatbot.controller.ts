import { InstanceDto } from '@api/dto/instance.dto';
import { PrismaRepository } from '@api/repository/repository.service';
import {
  difyController,
  evoaiController,
  evolutionBotController,
  flowiseController,
  n8nController,
  openaiController,
  typebotController,
} from '@api/server.module';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Logger } from '@config/logger.config';
import { IntegrationSession } from '@prisma/client';
import { findBotByTrigger } from '@utils/findBotByTrigger';

export type EmitData = {
  instance: InstanceDto;
  remoteJid: string;
  msg: any;
  pushName?: string;
};

export interface ChatbotControllerInterface {
  integrationEnabled: boolean;
  botRepository: any;
  settingsRepository: any;
  sessionRepository: any;
  userMessageDebounce: { [key: string]: { message: string; timeoutId: NodeJS.Timeout } };

  createBot(instance: InstanceDto, data: any): Promise<any>;
  findBot(instance: InstanceDto): Promise<any>;
  fetchBot(instance: InstanceDto, botId: string): Promise<any>;
  updateBot(instance: InstanceDto, botId: string, data: any): Promise<any>;
  deleteBot(instance: InstanceDto, botId: string): Promise<any>;

  settings(instance: InstanceDto, data: any): Promise<any>;
  fetchSettings(instance: InstanceDto): Promise<any>;

  changeStatus(instance: InstanceDto, botId: string, status: string): Promise<any>;
  fetchSessions(instance: InstanceDto, botId: string, remoteJid?: string): Promise<any>;
  ignoreJid(instance: InstanceDto, data: any): Promise<any>;

  emit(data: EmitData): Promise<void>;
}

export class ChatbotController {
  public prismaRepository: PrismaRepository;
  public waMonitor: WAMonitoringService;

  public readonly logger = new Logger('ChatbotController');

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    this.prisma = prismaRepository;
    this.monitor = waMonitor;
  }

  public set prisma(prisma: PrismaRepository) {
    this.prismaRepository = prisma;
  }

  public get prisma() {
    return this.prismaRepository;
  }

  public set monitor(waMonitor: WAMonitoringService) {
    this.waMonitor = waMonitor;
  }

  public get monitor() {
    return this.waMonitor;
  }

  public async emit({
    instance,
    remoteJid,
    msg,
    pushName,
    isIntegration = false,
  }: {
    instance: InstanceDto;
    remoteJid: string;
    msg: any;
    pushName?: string;
    isIntegration?: boolean;
  }): Promise<void> {
    const emitData = {
      instance,
      remoteJid,
      msg,
      pushName,
      isIntegration,
    };
    evolutionBotController.emit(emitData);

    typebotController.emit(emitData);

    openaiController.emit(emitData);

    difyController.emit(emitData);

    n8nController.emit(emitData);

    evoaiController.emit(emitData);

    flowiseController.emit(emitData);
  }

  public processDebounce(
    userMessageDebounce: any,
    content: string,
    remoteJid: string,
    debounceTime: number,
    callback: any,
  ) {
    if (userMessageDebounce[remoteJid]) {
      userMessageDebounce[remoteJid].message += `\n${content}`;
      this.logger.log('message debounced: ' + userMessageDebounce[remoteJid].message);
      clearTimeout(userMessageDebounce[remoteJid].timeoutId);
    } else {
      userMessageDebounce[remoteJid] = {
        message: content,
        timeoutId: null,
      };
    }

    userMessageDebounce[remoteJid].timeoutId = setTimeout(() => {
      const myQuestion = userMessageDebounce[remoteJid].message;
      this.logger.log('Debounce complete. Processing message: ' + myQuestion);

      delete userMessageDebounce[remoteJid];
      callback(myQuestion);
    }, debounceTime * 1000);
  }

  public checkIgnoreJids(ignoreJids: any, remoteJid: string) {
    if (ignoreJids && ignoreJids.length > 0) {
      let ignoreGroups = false;
      let ignoreContacts = false;

      if (ignoreJids.includes('@g.us')) {
        ignoreGroups = true;
      }

      if (ignoreJids.includes('@s.whatsapp.net')) {
        ignoreContacts = true;
      }

      if (ignoreGroups && remoteJid.endsWith('@g.us')) {
        this.logger.warn('Ignoring message from group: ' + remoteJid);
        return true;
      }

      if (ignoreContacts && remoteJid.endsWith('@s.whatsapp.net')) {
        this.logger.warn('Ignoring message from contact: ' + remoteJid);
        return true;
      }

      if (ignoreJids.includes(remoteJid)) {
        this.logger.warn('Ignoring message from jid: ' + remoteJid);
        return true;
      }

      return false;
    }

    return false;
  }

  public async getSession(remoteJid: string, instance: InstanceDto) {
    let session = await this.prismaRepository.integrationSession.findFirst({
      where: {
        remoteJid: remoteJid,
        instanceId: instance.instanceId,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (session) {
      if (session.status !== 'closed' && !session.botId) {
        this.logger.warn('Session is already opened in another integration');
        return null;
      } else if (!session.botId) {
        session = null;
      }
    }

    return session;
  }

  public async findBotTrigger(
    botRepository: any,
    content: string,
    instance: InstanceDto,
    session?: IntegrationSession,
  ) {
    let findBot: any = null;

    if (!session) {
      findBot = await findBotByTrigger(botRepository, content, instance.instanceId);

      if (!findBot) {
        return null;
      }
    } else {
      findBot = await botRepository.findFirst({
        where: {
          id: session.botId,
        },
      });
    }

    return findBot;
  }
}
