import { OfferCallDto } from '@api/dto/call.dto';
import {
  ArchiveChatDto,
  BlockUserDto,
  DeleteMessage,
  getBase64FromMediaMessageDto,
  LastMessage,
  MarkChatUnreadDto,
  NumberBusiness,
  OnWhatsAppDto,
  PrivacySettingDto,
  ReadMessageDto,
  SendPresenceDto,
  UpdateMessageDto,
  WhatsAppNumberDto,
} from '@api/dto/chat.dto';
import {
  AcceptGroupInvite,
  CreateGroupDto,
  GetParticipant,
  GroupDescriptionDto,
  GroupInvite,
  GroupJid,
  GroupPictureDto,
  GroupSendInvite,
  GroupSubjectDto,
  GroupToggleEphemeralDto,
  GroupUpdateParticipantDto,
  GroupUpdateSettingDto,
} from '@api/dto/group.dto';
import { InstanceDto, SetPresenceDto } from '@api/dto/instance.dto';
import { HandleLabelDto, LabelDto } from '@api/dto/label.dto';
import {
  Button,
  ContactMessage,
  KeyType,
  MediaMessage,
  Options,
  SendAudioDto,
  SendButtonsDto,
  SendContactDto,
  SendListDto,
  SendLocationDto,
  SendMediaDto,
  SendPollDto,
  SendPtvDto,
  SendReactionDto,
  SendStatusDto,
  SendStickerDto,
  SendTextDto,
  StatusMessage,
  TypeButton,
} from '@api/dto/sendMessage.dto';
import { chatwootImport } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
import * as s3Service from '@api/integrations/storage/s3/libs/minio.server';
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository } from '@api/repository/repository.service';
import { chatbotController, waMonitor } from '@api/server.module';
import { CacheService } from '@api/services/cache.service';
import { ChannelStartupService } from '@api/services/channel.service';
import {
  Events,
  LidContact,
  LidMessageKey,
  MessageSubtype,
  resolveLidContact,
  resolveLidJid,
  TypeMediaMessage,
  wa,
} from '@api/types/wa.types';
import { CacheEngine } from '@cache/cacheengine';
import {
  CacheConf,
  Chatwoot,
  ConfigService,
  configService,
  ConfigSessionPhone,
  Database,
  Log,
  Openai,
  ProviderSession,
  QrCode,
  S3,
} from '@config/env.config';
import { BadRequestException, InternalServerErrorException, NotFoundException } from '@exceptions';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import { Boom } from '@hapi/boom';
import { Instance } from '@prisma/client';
import { createJid } from '@utils/createJid';
import { makeProxyAgent } from '@utils/makeProxyAgent';
import { getOnWhatsappCache, saveOnWhatsappCache } from '@utils/onWhatsappCache';
import { status } from '@utils/renderStatus';
import useMultiFileAuthStatePrisma from '@utils/use-multi-file-auth-state-prisma';
import { AuthStateProvider } from '@utils/use-multi-file-auth-state-provider-files';
import { useMultiFileAuthStateRedisDb } from '@utils/use-multi-file-auth-state-redis-db';
import axios from 'axios';
import makeWASocket, {
  AnyMessageContent,
  BufferedEventData,
  BufferJSON,
  CacheStore,
  Chat,
  ConnectionState,
  Contact,
  delay,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  generateWAMessageFromContent,
  getAggregateVotesInPollMessage,
  getContentType,
  getDevice,
  GroupMetadata,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isLidUser,
  isPnUser,
  makeCacheableSignalKeyStore,
  MessageUpsertType,
  MessageUserReceiptUpdate,
  MiscMessageGenerationOptions,
  ParticipantAction,
  prepareWAMessageMedia,
  proto,
  UserFacingSocketConfig,
  WABrowserDescription,
  WAMediaUpload,
  WAMessage,
  WAMessageUpdate,
  WAPresence,
  WASocket,
} from 'baileys';
import { Label } from 'baileys/lib/Types/Label';
import { LabelAssociation } from 'baileys/lib/Types/LabelAssociation';
import { spawn } from 'child_process';
import { isArray, isBase64, isURL } from 'class-validator';
import { randomBytes } from 'crypto';
import EventEmitter2 from 'eventemitter2';
import ffmpeg from 'fluent-ffmpeg';
import FormData from 'form-data';
import { readFileSync } from 'fs';
import Long from 'long';
import mime from 'mime';
import NodeCache from 'node-cache';
import cron from 'node-cron';
import { release } from 'os';
import { join } from 'path';
import P from 'pino';
import qrcode, { QRCodeToDataURLOptions } from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import sharp from 'sharp';
import { PassThrough, Readable } from 'stream';
import { v4 } from 'uuid';

const groupMetadataCache = new CacheService(new CacheEngine(configService, 'groups').getEngine());

// Adicione a função getVideoDuration no início do arquivo
function normalizeListType(listMessage?: proto.Message.IListMessage | null): void {
  if (listMessage?.listType === proto.Message.ListMessage.ListType.PRODUCT_LIST) {
    listMessage.listType = proto.Message.ListMessage.ListType.SINGLE_SELECT;
  }
}

async function getVideoDuration(input: Buffer | string | Readable): Promise<number> {
  const MediaInfoFactory = (await import('mediainfo.js')).default;
  const mediainfo = await MediaInfoFactory({ format: 'JSON' });

  let fileSize: number;
  let readChunk: (size: number, offset: number) => Promise<Buffer>;

  if (Buffer.isBuffer(input)) {
    fileSize = input.length;
    readChunk = async (size: number, offset: number): Promise<Buffer> => {
      return input.slice(offset, offset + size);
    };
  } else if (typeof input === 'string') {
    const fs = await import('fs');
    const stat = await fs.promises.stat(input);
    fileSize = stat.size;
    const fd = await fs.promises.open(input, 'r');

    readChunk = async (size: number, offset: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(size);
      await fd.read(buffer, 0, size, offset);
      return buffer;
    };

    try {
      const result = await mediainfo.analyzeData(() => fileSize, readChunk);
      const jsonResult = JSON.parse(result);

      const generalTrack = jsonResult.media.track.find((t: any) => t['@type'] === 'General');
      const duration = generalTrack.Duration;

      return Math.round(parseFloat(duration));
    } finally {
      await fd.close();
    }
  } else if (input instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) {
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    fileSize = data.length;

    readChunk = async (size: number, offset: number): Promise<Buffer> => {
      return data.slice(offset, offset + size);
    };
  } else {
    throw new Error('Tipo de entrada não suportado');
  }

  const result = await mediainfo.analyzeData(() => fileSize, readChunk);
  const jsonResult = JSON.parse(result);

  const generalTrack = jsonResult.media.track.find((t: any) => t['@type'] === 'General');
  const duration = generalTrack.Duration;

  return Math.round(parseFloat(duration));
}

export class BaileysStartupService extends ChannelStartupService {
  constructor(
    public readonly configService: ConfigService,
    public readonly eventEmitter: EventEmitter2,
    public readonly prismaRepository: PrismaRepository,
    public readonly cache: CacheService,
    public readonly chatwootCache: CacheService,
    public readonly baileysCache: CacheService,
    private readonly providerFiles: ProviderFiles,
  ) {
    super(configService, eventEmitter, prismaRepository, chatwootCache);
    this.instance.qrcode = { count: 0 };

    this.authStateProvider = new AuthStateProvider(this.providerFiles);
  }

  private authStateProvider: AuthStateProvider;
  private readonly msgRetryCounterCache: CacheStore = new NodeCache();
  private readonly userDevicesCache: CacheStore = new NodeCache();
  private endSession = false;
  private logBaileys = this.configService.get<Log>('LOG').BAILEYS;
  private lastStream515At = 0;

  // After WhatsApp emits "stream:error 515" (restart required) it usually closes with `loggedOut`;
  // that close is not a real logout, so any close inside this window still reconnects (upstream #2509).
  private static readonly STREAM_515_RECONNECT_GRACE_MS = 30_000;

  public stateConnection: wa.StateConnection = { state: 'close' };

  public phoneNumber: string;

  public get connectionStatus() {
    return this.stateConnection;
  }

  public async logoutInstance() {
    await this.client?.logout('Log out instance: ' + this.instanceName);

    this.client?.ws?.close();

    const sessionExists = await this.prismaRepository.session.findFirst({
      where: { sessionId: this.instanceId },
    });
    if (sessionExists) {
      await this.prismaRepository.session.delete({
        where: {
          sessionId: this.instanceId,
        },
      });
    }
  }

  public async getProfileName() {
    let profileName = this.client.user?.name ?? this.client.user?.verifiedName;
    if (!profileName) {
      const data = await this.prismaRepository.session.findUnique({
        where: { sessionId: this.instanceId },
      });

      if (data) {
        const creds = JSON.parse(JSON.stringify(data.creds), BufferJSON.reviver);
        profileName = creds.me?.name || creds.me?.verifiedName;
      }
    }

    return profileName;
  }

  public async getProfileStatus() {
    const status = await this.client.fetchStatus(this.instance.wuid);

    return (status as any)?.[0]?.status;
  }

  public get profilePictureUrl() {
    return this.instance.profilePictureUrl;
  }

  public get qrCode(): wa.QrCode {
    return {
      pairingCode: this.instance.qrcode?.pairingCode,
      code: this.instance.qrcode?.code,
      base64: this.instance.qrcode?.base64,
      count: this.instance.qrcode?.count,
    };
  }

  private async connectionUpdate({ qr, connection, lastDisconnect }: Partial<ConnectionState>) {
    if (qr) {
      if (this.instance.qrcode.count === this.configService.get<QrCode>('QRCODE').LIMIT) {
        this.sendDataWebhook(Events.QRCODE_UPDATED, {
          message: 'QR code limit reached, please login again',
          statusCode: DisconnectReason.badSession,
        });

        if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
          this.chatwootService.eventWhatsapp(
            Events.QRCODE_UPDATED,
            { instanceName: this.instance.name, instanceId: this.instanceId },
            {
              message: 'QR code limit reached, please login again',
              statusCode: DisconnectReason.badSession,
            },
          );
        }

        this.sendDataWebhook(Events.CONNECTION_UPDATE, {
          instance: this.instance.name,
          state: 'refused',
          statusReason: DisconnectReason.connectionClosed,
        });

        this.endSession = true;

        return this.eventEmitter.emit('no.connection', this.instance.name);
      }

      this.instance.qrcode.count++;

      const color = this.configService.get<QrCode>('QRCODE').COLOR;

      const optsQrcode: QRCodeToDataURLOptions = {
        margin: 3,
        scale: 4,
        errorCorrectionLevel: 'H',
        color: { light: '#ffffff', dark: color },
      };

      if (this.phoneNumber) {
        await delay(1000);
        this.instance.qrcode.pairingCode = await this.client.requestPairingCode(this.phoneNumber);
      } else {
        this.instance.qrcode.pairingCode = null;
      }

      qrcode.toDataURL(qr, optsQrcode, (error, base64) => {
        if (error) {
          this.logger.error('Qrcode generate failed:' + error.toString());
          return;
        }

        this.instance.qrcode.base64 = base64;
        this.instance.qrcode.code = qr;

        this.sendDataWebhook(Events.QRCODE_UPDATED, {
          qrcode: {
            instance: this.instance.name,
            pairingCode: this.instance.qrcode.pairingCode,
            code: qr,
            base64,
          },
        });

        if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
          this.chatwootService.eventWhatsapp(
            Events.QRCODE_UPDATED,
            { instanceName: this.instance.name, instanceId: this.instanceId },
            {
              qrcode: {
                instance: this.instance.name,
                pairingCode: this.instance.qrcode.pairingCode,
                code: qr,
                base64,
              },
            },
          );
        }
      });

      qrcodeTerminal.generate(qr, { small: true }, (qrcode) =>
        this.logger.log(
          `\n{ instance: ${this.instance.name} pairingCode: ${this.instance.qrcode.pairingCode}, qrcodeCount: ${this.instance.qrcode.count} }\n` +
            qrcode,
        ),
      );

      await this.prismaRepository.instance.update({
        where: { id: this.instanceId },
        data: {
          connectionStatus: 'connecting',
        },
      });
    }

    if (connection) {
      this.stateConnection = {
        state: connection,
        statusReason: (lastDisconnect?.error as Boom)?.output?.statusCode ?? 200,
      };

      this.sendDataWebhook(Events.CONNECTION_UPDATE, {
        instance: this.instance.name,
        ...this.stateConnection,
      });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

      // Guard: if connection closed before QR was scanned (no wuid, no error code), do not reconnect
      // Without this guard, a premature close triggers infinite QR regeneration loop
      if (!this.instance.wuid && !statusCode) {
        this.logger.info('Connection closed before QR scan — skipping reconnect to prevent loop');
        return;
      }

      const codesToNotReconnect = [DisconnectReason.loggedOut, DisconnectReason.forbidden, 402, 406];
      const recentStream515 = Date.now() - this.lastStream515At < BaileysStartupService.STREAM_515_RECONNECT_GRACE_MS;
      const shouldReconnect =
        !codesToNotReconnect.includes(statusCode) || (statusCode === DisconnectReason.loggedOut && recentStream515);
      if (shouldReconnect) {
        await this.connectToWhatsapp(this.phoneNumber);
      } else {
        this.sendDataWebhook(Events.STATUS_INSTANCE, {
          instance: this.instance.name,
          status: 'closed',
          disconnectionAt: new Date(),
          disconnectionReasonCode: statusCode,
          disconnectionObject: JSON.stringify(lastDisconnect),
        });

        await this.prismaRepository.instance.update({
          where: { id: this.instanceId },
          data: {
            connectionStatus: 'close',
            disconnectionAt: new Date(),
            disconnectionReasonCode: statusCode,
            disconnectionObject: JSON.stringify(lastDisconnect),
          },
        });

        if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
          this.chatwootService.eventWhatsapp(
            Events.STATUS_INSTANCE,
            { instanceName: this.instance.name, instanceId: this.instanceId },
            {
              instance: this.instance.name,
              status: 'closed',
            },
          );
        }

        this.eventEmitter.emit('logout.instance', this.instance.name, 'inner');
        this.client?.ws?.close();
        this.client.end(new Error('Close connection'));
      }
    }

    if (connection === 'open') {
      this.instance.wuid = this.client.user.id.replace(/:\d+/, '');
      try {
        const profilePic = await this.profilePicture(this.instance.wuid);
        this.instance.profilePictureUrl = profilePic.profilePictureUrl;
      } catch {
        this.instance.profilePictureUrl = null;
      }
      const formattedWuid = this.instance.wuid.split('@')[0].padEnd(30, ' ');
      const formattedName = this.instance.name;
      this.logger.info(
        `
        ┌──────────────────────────────┐
        │    CONNECTED TO WHATSAPP     │
        └──────────────────────────────┘`.replace(/^ +/gm, '  '),
      );
      this.logger.info(
        `
        wuid: ${formattedWuid}
        name: ${formattedName}
      `,
      );

      await this.prismaRepository.instance.update({
        where: { id: this.instanceId },
        data: {
          ownerJid: this.instance.wuid,
          profileName: (await this.getProfileName()) as string,
          profilePicUrl: this.instance.profilePictureUrl,
          connectionStatus: 'open',
        },
      });

      if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
        this.chatwootService.eventWhatsapp(
          Events.CONNECTION_UPDATE,
          { instanceName: this.instance.name, instanceId: this.instanceId },
          {
            instance: this.instance.name,
            status: 'open',
          },
        );
        this.syncChatwootLostMessages();
      }
    }
  }

  private async getMessage(key: proto.IMessageKey, full = false) {
    try {
      const webMessageInfo = (await this.prismaRepository.message.findMany({
        where: {
          instanceId: this.instanceId,
          key: {
            path: ['id'],
            equals: key.id,
          },
        },
      })) as unknown as proto.IWebMessageInfo[];
      if (full) {
        return webMessageInfo[0];
      }
      if (webMessageInfo[0].message?.pollCreationMessage) {
        const messageSecretBase64 = webMessageInfo[0].message?.messageContextInfo?.messageSecret;

        if (typeof messageSecretBase64 === 'string') {
          const messageSecret = Buffer.from(messageSecretBase64, 'base64');

          const msg = {
            messageContextInfo: {
              messageSecret,
            },
            pollCreationMessage: webMessageInfo[0].message?.pollCreationMessage,
          };

          return msg;
        }
      }

      return webMessageInfo[0].message;
    } catch {
      return { conversation: '' };
    }
  }

  private async defineAuthState() {
    const db = this.configService.get<Database>('DATABASE');
    const cache = this.configService.get<CacheConf>('CACHE');

    const provider = this.configService.get<ProviderSession>('PROVIDER');

    if (provider?.ENABLED) {
      return await this.authStateProvider.authStateProvider(this.instance.id);
    }

    if (cache?.REDIS.ENABLED && cache?.REDIS.SAVE_INSTANCES) {
      this.logger.info('Redis enabled');
      return await useMultiFileAuthStateRedisDb(this.instance.id, this.cache);
    }

    if (db.SAVE_DATA.INSTANCE) {
      return await useMultiFileAuthStatePrisma(this.instance.id, this.cache);
    }
  }

  private async createClient(number?: string): Promise<WASocket> {
    this.instance.authState = await this.defineAuthState();

    const session = this.configService.get<ConfigSessionPhone>('CONFIG_SESSION_PHONE');

    let browserOptions = {};

    if (number || this.phoneNumber) {
      this.phoneNumber = number;

      this.logger.info(`Phone number: ${number}`);
    } else {
      const browser: WABrowserDescription = [session.CLIENT, session.NAME, release()];
      browserOptions = { browser };

      this.logger.info(`Browser: ${browser}`);
    }

    let version;
    let log;

    if (session.VERSION) {
      version = session.VERSION.split('.');
      log = `Baileys version env: ${version}`;
    } else {
      const baileysVersion = await fetchLatestBaileysVersion();
      version = baileysVersion.version;
      log = `Baileys version: ${version}`;
    }

    this.logger.info(log);

    this.logger.info(`Group Ignore: ${this.localSettings.groupsIgnore}`);

    let options;

    if (this.localProxy?.enabled) {
      this.logger.info('Proxy enabled: ' + this.localProxy?.host);

      if (this.localProxy?.host?.includes('proxyscrape')) {
        try {
          const response = await axios.get(this.localProxy?.host);
          const text = response.data;
          const proxyUrls = text.split('\r\n');
          const rand = Math.floor(Math.random() * Math.floor(proxyUrls.length));
          const proxyUrl = 'http://' + proxyUrls[rand];
          options = {
            agent: makeProxyAgent(proxyUrl),
            fetchAgent: makeProxyAgent(proxyUrl),
          };
        } catch {
          this.localProxy.enabled = false;
        }
      } else {
        options = {
          agent: makeProxyAgent({
            host: this.localProxy.host,
            port: this.localProxy.port,
            protocol: this.localProxy.protocol,
            username: this.localProxy.username,
            password: this.localProxy.password,
          }),
          fetchAgent: makeProxyAgent({
            host: this.localProxy.host,
            port: this.localProxy.port,
            protocol: this.localProxy.protocol,
            username: this.localProxy.username,
            password: this.localProxy.password,
          }),
        };
      }
    }

    const socketConfig: UserFacingSocketConfig = {
      ...options,
      version,
      logger: P({ level: this.logBaileys }),
      printQRInTerminal: false,
      auth: {
        creds: this.instance.authState.state.creds,
        keys: makeCacheableSignalKeyStore(this.instance.authState.state.keys, P({ level: 'error' }) as any),
      },
      msgRetryCounterCache: this.msgRetryCounterCache,
      generateHighQualityLinkPreview: true,
      getMessage: async (key) => (await this.getMessage(key)) as Promise<proto.IMessage>,
      ...browserOptions,
      markOnlineOnConnect: this.localSettings.alwaysOnline,
      retryRequestDelayMs: 350,
      maxMsgRetryCount: 4,
      fireInitQueries: true,
      connectTimeoutMs: 30_000,
      keepAliveIntervalMs: 30_000,
      qrTimeout: 45_000,
      emitOwnEvents: false,
      shouldIgnoreJid: (jid) => {
        const isGroupJid = this.localSettings.groupsIgnore && isJidGroup(jid);
        const isBroadcast = !this.localSettings.readStatus && isJidBroadcast(jid);
        const isNewsletter = isJidNewsletter(jid);

        return isGroupJid || isBroadcast || isNewsletter;
      },
      syncFullHistory: this.localSettings.syncFullHistory,
      shouldSyncHistoryMessage: (msg: proto.Message.IHistorySyncNotification) => {
        return this.historySyncNotification(msg);
      },
      cachedGroupMetadata: this.getGroupMetadataCache,
      userDevicesCache: this.userDevicesCache,
      transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 },
      patchMessageBeforeSending(message) {
        // Mutate in place: a JSON round-trip strips protobuf Long prototypes and breaks encoding (upstream #2461)
        normalizeListType(message.deviceSentMessage?.message?.listMessage);
        normalizeListType(message.listMessage);

        return message;
      },
    };

    this.endSession = false;

    this.client = makeWASocket(socketConfig);

    this.client.ws.on('CB:stream:error', (node: { attrs?: { code?: string | number } }) => {
      if (String(node?.attrs?.code) === '515') {
        this.lastStream515At = Date.now();
      }
    });

    this.eventHandler();

    this.phoneNumber = number;

    return this.client;
  }

  public async connectToWhatsapp(number?: string): Promise<WASocket> {
    try {
      this.loadChatwoot();
      this.loadSettings();
      this.loadWebhook();
      this.loadProxy();

      return await this.createClient(number);
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException(error?.toString());
    }
  }

  public async reloadConnection(): Promise<WASocket> {
    try {
      return await this.createClient(this.phoneNumber);
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException(error?.toString());
    }
  }

  private readonly chatHandle = {
    'chats.upsert': async (chats: Chat[]) => {
      const existingChatIds = await this.prismaRepository.chat.findMany({
        where: { instanceId: this.instanceId },
        select: { remoteJid: true },
      });

      const existingChatIdSet = new Set(existingChatIds.map((chat) => chat.remoteJid));

      const chatsToInsert = chats
        .filter((chat) => !existingChatIdSet?.has(chat.id))
        .map((chat) => ({
          remoteJid: chat.id,
          instanceId: this.instanceId,
          name: chat.name,
          unreadMessages: chat.unreadCount !== undefined ? chat.unreadCount : 0,
        }));

      this.sendDataWebhook(Events.CHATS_UPSERT, chatsToInsert);

      if (chatsToInsert.length > 0) {
        if (this.configService.get<Database>('DATABASE').SAVE_DATA.CHATS)
          await this.prismaRepository.chat.createMany({
            data: chatsToInsert,
            skipDuplicates: true,
          });
      }
    },

    'chats.update': async (
      chats: Partial<
        proto.IConversation & {
          lastMessageRecvTimestamp?: number;
        } & {
          conditional: (bufferedData: BufferedEventData) => boolean;
        }
      >[],
    ) => {
      const chatsRaw = chats.map((chat) => {
        return { remoteJid: chat.id, instanceId: this.instanceId };
      });

      this.sendDataWebhook(Events.CHATS_UPDATE, chatsRaw);

      for (const chat of chats) {
        await this.prismaRepository.chat.updateMany({
          where: {
            instanceId: this.instanceId,
            remoteJid: chat.id,
            name: chat.name,
          },
          data: { remoteJid: chat.id },
        });
      }
    },

    'chats.delete': async (chats: string[]) => {
      chats.forEach(
        async (chat) =>
          await this.prismaRepository.chat.deleteMany({
            where: { instanceId: this.instanceId, remoteJid: chat },
          }),
      );

      this.sendDataWebhook(Events.CHATS_DELETE, [...chats]);
    },
  };

  private readonly contactHandle = {
    'contacts.upsert': async (contacts: LidContact[]) => {
      try {
        const contactsRaw: any = contacts.map((contact) => ({
          remoteJid: resolveLidContact(contact),
          pushName: contact?.name || contact?.verifiedName || contact.id.split('@')[0],
          profilePicUrl: null,
          instanceId: this.instanceId,
        }));

        if (contactsRaw.length > 0) {
          this.sendDataWebhook(Events.CONTACTS_UPSERT, contactsRaw);

          if (this.configService.get<Database>('DATABASE').SAVE_DATA.CONTACTS)
            await this.prismaRepository.contact.createMany({
              data: contactsRaw,
              skipDuplicates: true,
            });

          const usersContacts = contactsRaw.filter((c) => c.remoteJid.includes('@s.whatsapp'));
          if (usersContacts) {
            await saveOnWhatsappCache(usersContacts.map((c) => ({ remoteJid: c.remoteJid })));
          }
        }

        if (
          this.configService.get<Chatwoot>('CHATWOOT').ENABLED &&
          this.localChatwoot?.enabled &&
          this.localChatwoot.importContacts &&
          contactsRaw.length
        ) {
          this.chatwootService.addHistoryContacts(
            { instanceName: this.instance.name, instanceId: this.instance.id },
            contactsRaw,
          );
          chatwootImport.importHistoryContacts(
            { instanceName: this.instance.name, instanceId: this.instance.id },
            this.localChatwoot,
          );
        }

        const updatedContacts = await Promise.all(
          contacts.map(async (contact: LidContact) => ({
            remoteJid: resolveLidContact(contact),
            pushName: contact?.name || contact?.verifiedName || contact.id.split('@')[0],
            profilePicUrl: (await this.profilePicture(contact.id)).profilePictureUrl,
            instanceId: this.instanceId,
          })),
        );

        if (updatedContacts.length > 0) {
          const usersContacts = updatedContacts.filter((c) => c.remoteJid.includes('@s.whatsapp'));
          if (usersContacts) {
            await saveOnWhatsappCache(usersContacts.map((c) => ({ remoteJid: c.remoteJid })));
          }

          this.sendDataWebhook(Events.CONTACTS_UPDATE, updatedContacts);
          await Promise.all(
            updatedContacts.map(async (contact) => {
              const update = this.prismaRepository.contact.updateMany({
                where: { remoteJid: contact.remoteJid, instanceId: this.instanceId },
                data: {
                  profilePicUrl: contact.profilePicUrl,
                },
              });

              if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
                const instance = { instanceName: this.instance.name, instanceId: this.instance.id };

                const findParticipant = await this.chatwootService.findContact(
                  instance,
                  contact.remoteJid.split('@')[0],
                );

                if (!findParticipant) {
                  return;
                }

                this.chatwootService.updateContact(instance, findParticipant.id, {
                  name: contact.pushName,
                  avatar_url: contact.profilePicUrl,
                });
              }

              return update;
            }),
          );
        }
      } catch (error) {
        console.error(error);
        this.logger.error(`Error: ${error.message}`);
      }
    },

    'contacts.update': async (contacts: Partial<Contact>[]) => {
      const contactsRaw: {
        remoteJid: string;
        pushName?: string;
        profilePicUrl?: string;
        instanceId: string;
      }[] = [];
      for await (const contact of contacts) {
        contactsRaw.push({
          remoteJid: contact.id,
          pushName: contact?.name ?? contact?.verifiedName,
          profilePicUrl: (await this.profilePicture(contact.id)).profilePictureUrl,
          instanceId: this.instanceId,
        });
      }

      this.sendDataWebhook(Events.CONTACTS_UPDATE, contactsRaw);

      const updateTransactions = contactsRaw.map((contact) =>
        this.prismaRepository.contact.upsert({
          where: { remoteJid_instanceId: { remoteJid: contact.remoteJid, instanceId: contact.instanceId } },
          create: contact,
          update: contact,
        }),
      );
      await this.prismaRepository.$transaction(updateTransactions);

      const usersContacts = contactsRaw.filter((c) => c.remoteJid.includes('@s.whatsapp'));
      if (usersContacts) {
        await saveOnWhatsappCache(usersContacts.map((c) => ({ remoteJid: c.remoteJid })));
      }
    },
  };

  private readonly messageHandle = {
    'messaging-history.set': async ({
      messages,
      chats,
      contacts,
      isLatest,
      progress,
      syncType,
    }: {
      chats: Chat[];
      contacts: Contact[];
      messages: proto.IWebMessageInfo[];
      isLatest?: boolean;
      progress?: number;
      syncType?: proto.HistorySync.HistorySyncType;
    }) => {
      try {
        if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
          console.log('received on-demand history sync, messages=', messages);
        }
        console.log(
          `recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest}, progress: ${progress}%), type: ${syncType}`,
        );

        const instance: InstanceDto = { instanceName: this.instance.name };

        let timestampLimitToImport = null;

        if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED) {
          const daysLimitToImport = this.localChatwoot?.enabled ? this.localChatwoot.daysLimitImportMessages : 1000;

          const date = new Date();
          timestampLimitToImport = new Date(date.setDate(date.getDate() - daysLimitToImport)).getTime() / 1000;

          const maxBatchTimestamp = Math.max(...messages.map((message) => message.messageTimestamp as number));

          const processBatch = maxBatchTimestamp >= timestampLimitToImport;

          if (!processBatch) {
            return;
          }
        }

        const chatsRaw: { remoteJid: string; instanceId: string; name?: string }[] = [];
        const chatsRepository = new Set(
          (
            await this.prismaRepository.chat.findMany({
              where: { instanceId: this.instanceId },
            })
          ).map((chat) => chat.remoteJid),
        );

        for (const chat of chats) {
          if (chatsRepository?.has(chat.id)) {
            continue;
          }

          chatsRaw.push({
            remoteJid: chat.id,
            instanceId: this.instanceId,
            name: chat.name,
          });
        }

        this.sendDataWebhook(Events.CHATS_SET, chatsRaw);

        if (this.configService.get<Database>('DATABASE').SAVE_DATA.HISTORIC) {
          await this.prismaRepository.chat.createMany({
            data: chatsRaw,
            skipDuplicates: true,
          });
        }

        const messagesRaw: any[] = [];

        const messagesRepository = new Set(
          chatwootImport.getRepositoryMessagesCache(instance) ??
            (
              await this.prismaRepository.message.findMany({
                select: { key: true },
                where: { instanceId: this.instanceId },
              })
            ).map((message) => {
              const key = message.key as {
                id: string;
              };

              return key.id;
            }),
        );

        if (chatwootImport.getRepositoryMessagesCache(instance) === null) {
          chatwootImport.setRepositoryMessagesCache(instance, messagesRepository);
        }

        for (const m of messages) {
          if (!m.message || !m.key || !m.messageTimestamp) {
            continue;
          }

          if (Long.isLong(m?.messageTimestamp)) {
            m.messageTimestamp = m.messageTimestamp?.toNumber();
          }

          if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED) {
            if (m.messageTimestamp <= timestampLimitToImport) {
              continue;
            }
          }

          if (messagesRepository?.has(m.key.id)) {
            continue;
          }

          messagesRaw.push(this.prepareMessage(m));
        }

        this.sendDataWebhook(Events.MESSAGES_SET, [...messagesRaw]);

        if (this.configService.get<Database>('DATABASE').SAVE_DATA.HISTORIC) {
          await this.prismaRepository.message.createMany({
            data: messagesRaw,
            skipDuplicates: true,
          });
        }

        if (
          this.configService.get<Chatwoot>('CHATWOOT').ENABLED &&
          this.localChatwoot?.enabled &&
          this.localChatwoot.importMessages &&
          messagesRaw.length > 0
        ) {
          this.chatwootService.addHistoryMessages(
            instance,
            messagesRaw.filter((msg) => !chatwootImport.isIgnorePhoneNumber(msg.key?.remoteJid)),
          );
        }

        await this.contactHandle['contacts.upsert'](
          contacts
            .filter((c) => !!c.notify || !!c.name)
            .map((c) => ({
              id: c.id,
              name: c.name ?? c.notify,
            })),
        );

        contacts = undefined;
        messages = undefined;
        chats = undefined;
      } catch (error) {
        this.logger.error(error);
      }
    },

    'messages.upsert': async (
      {
        messages,
        type,
        requestId,
      }: {
        messages: proto.IWebMessageInfo[];
        type: MessageUpsertType;
        requestId?: string;
      },
      settings: any,
    ) => {
      try {
        for (const received of messages) {
          if (received.message?.conversation || received.message?.extendedTextMessage?.text) {
            const text = received.message?.conversation || received.message?.extendedTextMessage?.text;

            if (text == 'requestPlaceholder' && !requestId) {
              const messageId = await this.client.requestPlaceholderResend(received.key);

              console.log('requested placeholder resync, id=', messageId);
            } else if (requestId) {
              console.log('Message received from phone, id=', requestId, received);
            }

            if (text == 'onDemandHistSync') {
              const messageId = await this.client.fetchMessageHistory(50, received.key, received.messageTimestamp!);
              console.log('requested on-demand sync, id=', messageId);
            }
          }

          if (received.message?.protocolMessage?.editedMessage || received.message?.editedMessage?.message) {
            const editedMessage =
              received.message?.protocolMessage || received.message?.editedMessage?.message?.protocolMessage;
            if (editedMessage) {
              if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled)
                this.chatwootService.eventWhatsapp(
                  'messages.edit',
                  { instanceName: this.instance.name, instanceId: this.instance.id },
                  editedMessage,
                );

              await this.sendDataWebhook(Events.MESSAGES_EDITED, editedMessage);
            }
          }

          if (received.messageStubParameters && received.messageStubParameters[0] === 'Message absent from node') {
            this.logger.info(`Recovering message lost messageId: ${received.key.id}`);

            await this.baileysCache.set(received.key.id, {
              message: received,
              retry: 0,
            });

            continue;
          }

          const retryCache = (await this.baileysCache.get(received.key.id)) || null;

          if (retryCache) {
            this.logger.info('Recovered message lost');
            await this.baileysCache.delete(received.key.id);
          }

          if (
            (type !== 'notify' && type !== 'append') ||
            received.message?.protocolMessage ||
            received.message?.pollUpdateMessage ||
            !received?.message
          ) {
            continue;
          }

          if (Long.isLong(received.messageTimestamp)) {
            received.messageTimestamp = received.messageTimestamp?.toNumber();
          }

          // Resolve @lid to @s.whatsapp.net so all downstream uses (prepareMessage, chatbot, contact) get the correct JID
          if (received.key.remoteJid?.includes('@lid') && (received.key as LidMessageKey)?.remoteJidAlt) {
            received.key.remoteJid = (received.key as LidMessageKey).remoteJidAlt;
          }

          if (settings?.groupsIgnore && received.key.remoteJid.includes('@g.us')) {
            continue;
          }
          const existingChat = await this.prismaRepository.chat.findFirst({
            where: { instanceId: this.instanceId, remoteJid: received.key.remoteJid },
            select: { id: true, name: true },
          });

          if (
            existingChat &&
            received.pushName &&
            existingChat.name !== received.pushName &&
            received.pushName.trim().length > 0 &&
            !received.key.fromMe &&
            !received.key.remoteJid.includes('@g.us')
          ) {
            this.sendDataWebhook(Events.CHATS_UPSERT, [{ ...existingChat, name: received.pushName }]);
            if (this.configService.get<Database>('DATABASE').SAVE_DATA.CHATS) {
              try {
                await this.prismaRepository.chat.update({
                  where: { id: existingChat.id },
                  data: { name: received.pushName },
                });
              } catch {
                console.log(`Chat insert record ignored: ${received.key.remoteJid} - ${this.instanceId}`);
              }
            }
          }

          const messageRaw = this.prepareMessage(received);

          const isMedia =
            received?.message?.imageMessage ||
            received?.message?.videoMessage ||
            received?.message?.stickerMessage ||
            received?.message?.documentMessage ||
            received?.message?.documentWithCaptionMessage ||
            received?.message?.ptvMessage ||
            received?.message?.audioMessage;

          if (this.localSettings.readMessages && received.key.id !== 'status@broadcast') {
            await this.client.readMessages([received.key]);
          }

          if (this.localSettings.readStatus && received.key.id === 'status@broadcast') {
            await this.client.readMessages([received.key]);
          }

          if (
            this.configService.get<Chatwoot>('CHATWOOT').ENABLED &&
            this.localChatwoot?.enabled &&
            !received.key.id.includes('@broadcast')
          ) {
            const chatwootSentMessage = await this.chatwootService.eventWhatsapp(
              Events.MESSAGES_UPSERT,
              { instanceName: this.instance.name, instanceId: this.instance.id },
              messageRaw,
            );

            if (chatwootSentMessage?.id) {
              messageRaw.chatwootMessageId = chatwootSentMessage.id;
              messageRaw.chatwootInboxId = chatwootSentMessage.inbox_id;
              messageRaw.chatwootConversationId = chatwootSentMessage.conversation_id;
            }
          }

          if (this.configService.get<Openai>('OPENAI').ENABLED && received?.message?.audioMessage) {
            const openAiDefaultSettings = await this.prismaRepository.openaiSetting.findFirst({
              where: {
                instanceId: this.instanceId,
              },
              include: {
                OpenaiCreds: true,
              },
            });

            if (openAiDefaultSettings && openAiDefaultSettings.openaiCredsId && openAiDefaultSettings.speechToText) {
              messageRaw.message.speechToText = await this.openaiService.speechToText(
                openAiDefaultSettings.OpenaiCreds,
                received,
              );
            }
          }

          if (this.configService.get<Database>('DATABASE').SAVE_DATA.NEW_MESSAGE) {
            const msg = await this.prismaRepository.message.create({
              data: messageRaw,
            });

            if (received.key.fromMe === false) {
              if (msg.status === status[3]) {
                this.logger.log(`Update not read messages ${received.key.remoteJid}`);

                await this.updateChatUnreadMessages(received.key.remoteJid);
              } else if (msg.status === status[4]) {
                this.logger.log(`Update readed messages ${received.key.remoteJid} - ${msg.messageTimestamp}`);

                await this.updateMessagesReadedByTimestamp(received.key.remoteJid, msg.messageTimestamp);
              }
            } else {
              // is send message by me
              this.logger.log(`Update readed messages ${received.key.remoteJid} - ${msg.messageTimestamp}`);

              await this.updateMessagesReadedByTimestamp(received.key.remoteJid, msg.messageTimestamp);
            }

            if (isMedia) {
              if (this.configService.get<S3>('S3').ENABLE) {
                try {
                  const message: any = received;
                  const media = await this.getBase64FromMediaMessage(
                    {
                      message,
                    },
                    true,
                  );

                  const { buffer, mediaType, fileName, size } = media;
                  const mimetype = mime.getType(fileName).toString();
                  const fullName = join(`${this.instance.id}`, received.key.remoteJid, mediaType, fileName);
                  await s3Service.uploadFile(fullName, buffer, size.fileLength?.low, {
                    'Content-Type': mimetype,
                  });

                  await this.prismaRepository.media.create({
                    data: {
                      messageId: msg.id,
                      instanceId: this.instanceId,
                      type: mediaType,
                      fileName: fullName,
                      mimetype,
                    },
                  });

                  const mediaUrl = await s3Service.getObjectUrl(fullName);

                  messageRaw.message.mediaUrl = mediaUrl;

                  await this.prismaRepository.message.update({
                    where: { id: msg.id },
                    data: messageRaw,
                  });
                } catch (error) {
                  this.logger.error(['Error on upload file to minio', error?.message, error?.stack]);
                }
              }
            }
          }

          if (this.localWebhook.enabled) {
            if (isMedia && this.localWebhook.webhookBase64) {
              const buffer = await downloadMediaMessage(
                { key: received.key, message: received?.message },
                'buffer',
                {},
                {
                  logger: P({ level: 'error' }) as any,
                  reuploadRequest: this.client.updateMediaMessage,
                },
              );

              messageRaw.message.base64 = buffer ? buffer.toString('base64') : undefined;
            }
          }

          this.logger.log(messageRaw);

          this.sendDataWebhook(Events.MESSAGES_UPSERT, messageRaw);

          await chatbotController.emit({
            instance: { instanceName: this.instance.name, instanceId: this.instanceId },
            remoteJid: messageRaw.key.remoteJid,
            msg: messageRaw,
            pushName: messageRaw.pushName,
          });

          const contact = await this.prismaRepository.contact.findFirst({
            where: { remoteJid: received.key.remoteJid, instanceId: this.instanceId },
          });

          const contactRaw: { remoteJid: string; pushName: string; profilePicUrl?: string; instanceId: string } = {
            remoteJid: received.key.remoteJid,
            pushName: received.key.fromMe ? '' : received.key.fromMe == null ? '' : received.pushName,
            profilePicUrl: (await this.profilePicture(received.key.remoteJid)).profilePictureUrl,
            instanceId: this.instanceId,
          };

          if (contactRaw.remoteJid === 'status@broadcast') {
            continue;
          }

          if (contact) {
            this.sendDataWebhook(Events.CONTACTS_UPDATE, contactRaw);

            if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
              await this.chatwootService.eventWhatsapp(
                Events.CONTACTS_UPDATE,
                { instanceName: this.instance.name, instanceId: this.instanceId },
                contactRaw,
              );
            }

            if (this.configService.get<Database>('DATABASE').SAVE_DATA.CONTACTS)
              await this.prismaRepository.contact.upsert({
                where: { remoteJid_instanceId: { remoteJid: contactRaw.remoteJid, instanceId: contactRaw.instanceId } },
                create: contactRaw,
                update: contactRaw,
              });

            continue;
          }

          this.sendDataWebhook(Events.CONTACTS_UPSERT, contactRaw);

          if (this.configService.get<Database>('DATABASE').SAVE_DATA.CONTACTS)
            await this.prismaRepository.contact.upsert({
              where: {
                remoteJid_instanceId: {
                  remoteJid: contactRaw.remoteJid,
                  instanceId: contactRaw.instanceId,
                },
              },
              update: contactRaw,
              create: contactRaw,
            });

          if (contactRaw.remoteJid.includes('@s.whatsapp')) {
            await saveOnWhatsappCache([{ remoteJid: contactRaw.remoteJid }]);
          }
        }
      } catch (error) {
        this.logger.error(error);
      }
    },

    'messages.update': async (args: WAMessageUpdate[], settings: any) => {
      this.logger.log(`Update messages ${JSON.stringify(args, undefined, 2)}`);

      const readChatToUpdate: Record<string, true> = {}; // {remoteJid: true}

      for await (const { key, update } of args) {
        if (settings?.groupsIgnore && key.remoteJid?.includes('@g.us')) {
          continue;
        }

        if (status[update.status] === 'READ' && key.fromMe) {
          if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
            this.chatwootService.eventWhatsapp(
              'messages.read',
              { instanceName: this.instance.name, instanceId: this.instanceId },
              { key: key },
            );
          }
        }

        if (key.remoteJid !== 'status@broadcast') {
          let pollUpdates: any;

          if (update.pollUpdates) {
            const pollCreation = await this.getMessage(key);

            if (pollCreation) {
              pollUpdates = getAggregateVotesInPollMessage({
                message: pollCreation as proto.IMessage,
                pollUpdates: update.pollUpdates,
              });
            }
          }

          const findMessage = await this.prismaRepository.message.findFirst({
            where: {
              instanceId: this.instanceId,
              key: {
                path: ['id'],
                equals: key.id,
              },
            },
          });

          if (!findMessage) {
            continue;
          }

          // Resolve @lid to @s.whatsapp.net using the stored message key as source of truth
          const lidKey = key as LidMessageKey;
          const resolvedRemoteJid: string = key.remoteJid?.includes('@lid')
            ? (lidKey.remoteJidAlt ?? (findMessage.key as LidMessageKey)?.remoteJid ?? key.remoteJid)
            : key.remoteJid;

          if (update.message === null && update.status === undefined) {
            this.sendDataWebhook(Events.MESSAGES_DELETE, key);

            const message: any = {
              messageId: findMessage.id,
              keyId: key.id,
              remoteJid: resolvedRemoteJid,
              fromMe: key.fromMe,
              participant: resolvedRemoteJid,
              status: 'DELETED',
              instanceId: this.instanceId,
            };

            if (this.configService.get<Database>('DATABASE').SAVE_DATA.MESSAGE_UPDATE)
              await this.prismaRepository.messageUpdate.create({
                data: message,
              });

            if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
              this.chatwootService.eventWhatsapp(
                Events.MESSAGES_DELETE,
                { instanceName: this.instance.name, instanceId: this.instanceId },
                { key: key },
              );
            }

            continue;
          } else if (update.status !== undefined && status[update.status] !== findMessage.status) {
            if (!key.fromMe && resolvedRemoteJid) {
              readChatToUpdate[resolvedRemoteJid] = true;

              if (status[update.status] === status[4]) {
                this.logger.log(`Update as read ${resolvedRemoteJid} - ${findMessage.messageTimestamp}`);
                this.updateMessagesReadedByTimestamp(resolvedRemoteJid, findMessage.messageTimestamp);
              }
            }

            await this.prismaRepository.message.update({
              where: { id: findMessage.id },
              data: { status: status[update.status] },
            });
          }

          const message: any = {
            messageId: findMessage.id,
            keyId: key.id,
            remoteJid: resolvedRemoteJid,
            fromMe: key.fromMe,
            participant: resolvedRemoteJid,
            status: status[update.status],
            pollUpdates,
            instanceId: this.instanceId,
          };

          this.sendDataWebhook(Events.MESSAGES_UPDATE, message);

          if (this.configService.get<Database>('DATABASE').SAVE_DATA.MESSAGE_UPDATE)
            await this.prismaRepository.messageUpdate.create({
              data: message,
            });

          const existingChat = await this.prismaRepository.chat.findFirst({
            where: { instanceId: this.instanceId, remoteJid: message.remoteJid },
          });

          if (existingChat) {
            // The chat already exists: update it instead of creating a duplicate, which always hit the
            // (instanceId, remoteJid) unique constraint. Name is left untouched so status updates can't blank it.
            const chatToUpdate = { remoteJid: message.remoteJid, instanceId: this.instanceId, unreadMessages: 0 };

            this.sendDataWebhook(Events.CHATS_UPSERT, [chatToUpdate]);
            if (this.configService.get<Database>('DATABASE').SAVE_DATA.CHATS) {
              await this.prismaRepository.chat.update({ where: { id: existingChat.id }, data: chatToUpdate });
            }
          }
        }
      }

      await Promise.all(Object.keys(readChatToUpdate).map((remoteJid) => this.updateChatUnreadMessages(remoteJid)));
    },
  };

  private readonly groupHandler = {
    'groups.upsert': (groupMetadata: GroupMetadata[]) => {
      this.sendDataWebhook(Events.GROUPS_UPSERT, groupMetadata);
    },

    'groups.update': (groupMetadataUpdate: Partial<GroupMetadata>[]) => {
      this.sendDataWebhook(Events.GROUPS_UPDATE, groupMetadataUpdate);

      groupMetadataUpdate.forEach((group) => {
        if (isJidGroup(group.id)) {
          this.updateGroupMetadataCache(group.id);
        }
      });
    },

    'group-participants.update': (participantsUpdate: {
      id: string;
      participants: string[] | any[];
      action: ParticipantAction;
      author?: string;
    }) => {
      this.sendDataWebhook(Events.GROUP_PARTICIPANTS_UPDATE, participantsUpdate);

      this.updateGroupMetadataCache(participantsUpdate.id);
    },
  };

  private readonly labelHandle = {
    [Events.LABELS_EDIT]: async (label: Label) => {
      const labelsRepository = await this.prismaRepository.label.findMany({
        where: { instanceId: this.instanceId },
      });

      const savedLabel = labelsRepository.find((l) => l.labelId === label.id);
      if (label.deleted && savedLabel) {
        await this.prismaRepository.label.delete({
          where: { labelId_instanceId: { instanceId: this.instanceId, labelId: label.id } },
        });
        this.sendDataWebhook(Events.LABELS_EDIT, { ...label, instance: this.instance.name });
        return;
      }

      const labelName = label.name.replace(/[^\x20-\x7E]/g, '');
      if (!savedLabel || savedLabel.color !== `${label.color}` || savedLabel.name !== labelName) {
        if (this.configService.get<Database>('DATABASE').SAVE_DATA.LABELS) {
          const labelData = {
            color: `${label.color}`,
            name: labelName,
            labelId: label.id,
            predefinedId: label.predefinedId,
            instanceId: this.instanceId,
          };
          await this.prismaRepository.label.upsert({
            where: {
              labelId_instanceId: {
                instanceId: labelData.instanceId,
                labelId: labelData.labelId,
              },
            },
            update: labelData,
            create: labelData,
          });
        }
        this.sendDataWebhook(Events.LABELS_EDIT, { ...label, instance: this.instance.name });
      }
    },

    [Events.LABELS_ASSOCIATION]: async (
      data: { association: LabelAssociation; type: 'remove' | 'add' },
      database: Database,
    ) => {
      if (database.SAVE_DATA.CHATS) {
        const chats = await this.prismaRepository.chat.findMany({
          where: { instanceId: this.instanceId },
        });
        const chat = chats.find((c) => c.remoteJid === data.association.chatId);
        if (chat) {
          const labelsArray = Array.isArray(chat.labels) ? chat.labels.map((event) => String(event)) : [];
          let labels = [...labelsArray];

          if (data.type === 'remove') {
            labels = labels.filter((label) => label !== data.association.labelId);
          } else if (data.type === 'add') {
            labels = [...labels, data.association.labelId];
          }
          await this.prismaRepository.chat.update({
            where: { id: chat.id },
            data: {
              labels,
            },
          });
        }
      }

      this.sendDataWebhook(Events.LABELS_ASSOCIATION, {
        instance: this.instance.name,
        type: data.type,
        chatId: data.association.chatId,
        labelId: data.association.labelId,
      });
    },
  };

  private eventHandler() {
    this.client.ev.process(async (events) => {
      if (!this.endSession) {
        const database = this.configService.get<Database>('DATABASE');
        const settings = await this.findSettings();

        if (events.call) {
          const call = events.call[0];

          if (settings?.rejectCall && call.status == 'offer') {
            this.client.rejectCall(call.id, call.from);
          }

          if (settings?.msgCall?.trim().length > 0 && call.status == 'offer') {
            const msg = await this.client.sendMessage(call.from, {
              text: settings.msgCall,
            });

            this.client.ev.emit('messages.upsert', {
              messages: [msg],
              type: 'notify',
            });
          }

          this.sendDataWebhook(Events.CALL, call);
        }

        if (events['connection.update']) {
          this.connectionUpdate(events['connection.update']);
        }

        if (events['creds.update']) {
          this.instance.authState.saveCreds();
        }

        if (events['messaging-history.set']) {
          const payload = events['messaging-history.set'];
          this.messageHandle['messaging-history.set'](payload);
        }

        if (events['messages.upsert']) {
          const payload = events['messages.upsert'];
          this.messageHandle['messages.upsert'](payload, settings);
        }

        if (events['messages.update']) {
          const payload = events['messages.update'];
          this.messageHandle['messages.update'](payload, settings);
        }

        if (events['message-receipt.update']) {
          const payload = events['message-receipt.update'] as MessageUserReceiptUpdate[];
          const remotesJidMap: Record<string, number> = {};

          for (const event of payload) {
            if (typeof event.key.remoteJid === 'string' && typeof event.receipt.readTimestamp === 'number') {
              // Resolve @lid to @s.whatsapp.net so read receipts match stored messages
              const jid = resolveLidJid(event.key as LidMessageKey);
              remotesJidMap[jid] = event.receipt.readTimestamp;
            }
          }

          await Promise.all(
            Object.keys(remotesJidMap).map(async (remoteJid) =>
              this.updateMessagesReadedByTimestamp(remoteJid, remotesJidMap[remoteJid]),
            ),
          );
        }

        if (events['presence.update']) {
          const payload = events['presence.update'];

          if (settings?.groupsIgnore && payload.id.includes('@g.us')) {
            return;
          }

          this.sendDataWebhook(Events.PRESENCE_UPDATE, payload);
        }

        if (!settings?.groupsIgnore) {
          if (events['groups.upsert']) {
            const payload = events['groups.upsert'];
            this.groupHandler['groups.upsert'](payload);
          }

          if (events['groups.update']) {
            const payload = events['groups.update'];
            this.groupHandler['groups.update'](payload);
          }

          if (events['group-participants.update']) {
            const payload = events['group-participants.update'];
            this.groupHandler['group-participants.update'](payload);
          }
        }

        if (events['chats.upsert']) {
          const payload = events['chats.upsert'];
          this.chatHandle['chats.upsert'](payload);
        }

        if (events['chats.update']) {
          const payload = events['chats.update'];
          this.chatHandle['chats.update'](payload);
        }

        if (events['chats.delete']) {
          const payload = events['chats.delete'];
          this.chatHandle['chats.delete'](payload);
        }

        if (events['contacts.upsert']) {
          const payload = events['contacts.upsert'];
          this.contactHandle['contacts.upsert'](payload);
        }

        if (events['contacts.update']) {
          const payload = events['contacts.update'];
          this.contactHandle['contacts.update'](payload);
        }

        if (events[Events.LABELS_ASSOCIATION]) {
          const payload = events[Events.LABELS_ASSOCIATION];
          this.labelHandle[Events.LABELS_ASSOCIATION](payload, database);
          return;
        }

        if (events[Events.LABELS_EDIT]) {
          const payload = events[Events.LABELS_EDIT];
          this.labelHandle[Events.LABELS_EDIT](payload);
          return;
        }
      }
    });
  }

  private historySyncNotification(msg: proto.Message.IHistorySyncNotification) {
    const instance: InstanceDto = { instanceName: this.instance.name };

    if (
      this.configService.get<Chatwoot>('CHATWOOT').ENABLED &&
      this.localChatwoot?.enabled &&
      this.localChatwoot.importMessages &&
      this.isSyncNotificationFromUsedSyncType(msg)
    ) {
      if (msg.chunkOrder === 1) {
        this.chatwootService.startImportHistoryMessages(instance);
      }

      if (msg.progress === 100) {
        setTimeout(() => {
          this.chatwootService.importHistoryMessages(instance);
        }, 10000);
      }
    }

    return true;
  }

  private isSyncNotificationFromUsedSyncType(msg: proto.Message.IHistorySyncNotification) {
    return (
      (this.localSettings.syncFullHistory && msg?.syncType === 2) ||
      (!this.localSettings.syncFullHistory && msg?.syncType === 3)
    );
  }

  public async profilePicture(number: string) {
    const jid = createJid(number);

    try {
      const profilePictureUrl = await this.client.profilePictureUrl(jid, 'image');

      return {
        wuid: jid,
        profilePictureUrl,
      };
    } catch {
      return {
        wuid: jid,
        profilePictureUrl: null,
      };
    }
  }

  public async getStatus(number: string) {
    const jid = createJid(number);

    try {
      return {
        wuid: jid,
        status: ((await this.client.fetchStatus(jid)) as any)?.[0]?.status,
      };
    } catch {
      return {
        wuid: jid,
        status: null,
      };
    }
  }

  public async fetchProfile(instanceName: string, number?: string) {
    const jid = number ? createJid(number) : this.client?.user?.id;

    const onWhatsapp = (await this.whatsappNumber({ numbers: [jid] }))?.shift();

    if (!onWhatsapp.exists) {
      throw new BadRequestException(onWhatsapp);
    }

    try {
      if (number) {
        const info = (await this.whatsappNumber({ numbers: [jid] }))?.shift();
        const picture = await this.profilePicture(info?.jid);
        const status = await this.getStatus(info?.jid);
        const business = await this.fetchBusinessProfile(info?.jid);

        return {
          wuid: info?.jid || jid,
          name: info?.name,
          numberExists: info?.exists,
          picture: picture?.profilePictureUrl,
          status: status?.status,
          isBusiness: business.isBusiness,
          email: business?.email,
          description: business?.description,
          website: business?.website?.shift(),
        };
      } else {
        const instanceNames = instanceName ? [instanceName] : null;
        const info: Instance = await waMonitor.instanceInfo(instanceNames);
        const business = await this.fetchBusinessProfile(jid);

        return {
          wuid: jid,
          name: info?.profileName,
          numberExists: true,
          picture: info?.profilePicUrl,
          status: info?.connectionStatus,
          isBusiness: business.isBusiness,
          email: business?.email,
          description: business?.description,
          website: business?.website?.shift(),
        };
      }
    } catch {
      return {
        wuid: jid,
        name: null,
        picture: null,
        status: null,
        os: null,
        isBusiness: false,
      };
    }
  }

  public async offerCall({ number, isVideo, callDuration }: OfferCallDto) {
    const jid = createJid(number);

    try {
      const call = await (this.client as any).offerCall(jid, isVideo);
      setTimeout(() => (this.client as any).terminateCall(call.id, call.to), callDuration * 1000);

      return call;
    } catch (error) {
      return error;
    }
  }

  private async sendMessage(
    sender: string,
    message: any,
    mentions: any,
    linkPreview: any,
    quoted: any,
    messageId?: string,
    ephemeralExpiration?: number,
    // participants?: GroupParticipant[],
  ) {
    sender = sender.toLowerCase();

    const option: any = {
      quoted,
    };

    if (isJidGroup(sender)) {
      option.useCachedGroupMetadata = true;
      // if (participants)
      //   option.cachedGroupMetadata = async () => {
      //     return { participants: participants as GroupParticipant[] };
      //   };
    }

    if (ephemeralExpiration) option.ephemeralExpiration = ephemeralExpiration;

    if (messageId) option.messageId = messageId;
    else option.messageId = '3EB0' + randomBytes(18).toString('hex').toUpperCase();

    if (message['viewOnceMessage']) {
      const m = generateWAMessageFromContent(sender, message, {
        timestamp: new Date(),
        userJid: this.instance.wuid,
        messageId,
        quoted,
      });
      const id = await this.client.relayMessage(sender, message, { messageId });
      m.key = {
        id: id,
        remoteJid: sender,
        participant: isPnUser(sender) || isLidUser(sender) ? sender : undefined,
        fromMe: true,
      };
      for (const [key, value] of Object.entries(m)) {
        if (!value || (isArray(value) && value.length) === 0) {
          delete m[key];
        }
      }
      return m;
    }

    if (
      !message['audio'] &&
      !message['poll'] &&
      !message['sticker'] &&
      !message['conversation'] &&
      sender !== 'status@broadcast'
    ) {
      if (message['reactionMessage']) {
        return await this.client.sendMessage(
          sender,
          {
            react: {
              text: message['reactionMessage']['text'],
              key: message['reactionMessage']['key'],
            },
          } as unknown as AnyMessageContent,
          option as unknown as MiscMessageGenerationOptions,
        );
      }
    }

    if (message['conversation']) {
      return await this.client.sendMessage(
        sender,
        {
          text: message['conversation'],
          mentions,
          linkPreview: linkPreview,
        } as unknown as AnyMessageContent,
        option as unknown as MiscMessageGenerationOptions,
      );
    }

    if (!message['audio'] && !message['poll'] && !message['sticker'] && sender != 'status@broadcast') {
      return await this.client.sendMessage(
        sender,
        {
          forward: {
            key: { remoteJid: this.instance.wuid, fromMe: true },
            message,
          },
          mentions,
        },
        option as unknown as MiscMessageGenerationOptions,
      );
    }

    if (sender === 'status@broadcast') {
      let jidList;
      if (message['status'].option.allContacts) {
        const contacts = await this.prismaRepository.contact.findMany({
          where: {
            instanceId: this.instanceId,
            remoteJid: {
              not: {
                endsWith: '@g.us',
              },
            },
          },
        });

        jidList = contacts.map((contact) => contact.remoteJid);
      } else {
        jidList = message['status'].option.statusJidList;
      }

      const batchSize = 10;

      const batches = Array.from({ length: Math.ceil(jidList.length / batchSize) }, (_, i) =>
        jidList.slice(i * batchSize, i * batchSize + batchSize),
      );

      let msgId: string | null = null;

      let firstMessage: WAMessage;

      const firstBatch = batches.shift();

      if (firstBatch) {
        firstMessage = await this.client.sendMessage(
          sender,
          message['status'].content as unknown as AnyMessageContent,
          {
            backgroundColor: message['status'].option.backgroundColor,
            font: message['status'].option.font,
            statusJidList: firstBatch,
          } as unknown as MiscMessageGenerationOptions,
        );

        msgId = firstMessage.key.id;
      }

      if (batches.length === 0) return firstMessage;

      await Promise.allSettled(
        batches.map(async (batch) => {
          const messageSent = await this.client.sendMessage(
            sender,
            message['status'].content as unknown as AnyMessageContent,
            {
              backgroundColor: message['status'].option.backgroundColor,
              font: message['status'].option.font,
              statusJidList: batch,
              messageId: msgId,
            } as unknown as MiscMessageGenerationOptions,
          );

          return messageSent;
        }),
      );

      return firstMessage;
    }

    return await this.client.sendMessage(
      sender,
      message as unknown as AnyMessageContent,
      option as unknown as MiscMessageGenerationOptions,
    );
  }

  private async sendMessageWithTyping<T = proto.IMessage>(
    number: string,
    message: T,
    options?: Options,
    isIntegration = false,
  ) {
    const isWA = (await this.whatsappNumber({ numbers: [number] }))?.shift();

    if (!isWA.exists && !isJidGroup(isWA.jid) && !isWA.jid.includes('@broadcast') && !isWA.jid.includes('@lid')) {
      throw new BadRequestException(isWA);
    }

    const sender = isWA.jid.toLowerCase();

    this.logger.verbose(`Sending message to ${sender}`);

    try {
      if (options?.delay) {
        this.logger.verbose(`Typing for ${options.delay}ms to ${sender}`);
        if (options.delay > 20000) {
          let remainingDelay = options.delay;
          while (remainingDelay > 20000) {
            await this.client.presenceSubscribe(sender);

            await this.client.sendPresenceUpdate((options.presence as WAPresence) ?? 'composing', sender);

            await delay(20000);

            await this.client.sendPresenceUpdate('paused', sender);

            remainingDelay -= 20000;
          }
          if (remainingDelay > 0) {
            await this.client.presenceSubscribe(sender);

            await this.client.sendPresenceUpdate((options.presence as WAPresence) ?? 'composing', sender);

            await delay(remainingDelay);

            await this.client.sendPresenceUpdate('paused', sender);
          }
        } else {
          await this.client.presenceSubscribe(sender);

          await this.client.sendPresenceUpdate((options.presence as WAPresence) ?? 'composing', sender);

          await delay(options.delay);

          await this.client.sendPresenceUpdate('paused', sender);
        }
      }

      const linkPreview = options?.linkPreview != false ? undefined : false;

      let quoted: WAMessage;

      if (options?.quoted) {
        const m = options?.quoted;

        const msg = m?.message ? m : ((await this.getMessage(m.key, true)) as proto.IWebMessageInfo);

        if (msg) {
          quoted = msg as WAMessage;
        }
      }

      let messageSent: WAMessage;

      let mentions: string[];
      if (isJidGroup(sender)) {
        let group;
        try {
          const cache = this.configService.get<CacheConf>('CACHE');
          if (!cache.REDIS.ENABLED && !cache.LOCAL.ENABLED) group = await this.findGroup({ groupJid: sender }, 'inner');
          else group = await this.getGroupMetadataCache(sender);
        } catch {
          throw new NotFoundException('Group not found');
        }

        if (!group) {
          throw new NotFoundException('Group not found');
        }

        if (options?.mentionsEveryOne === true) {
          mentions = group.participants.map((participant) => participant.id);
        } else if (options.mentioned?.length) {
          mentions = options.mentioned.map((mention) => {
            const jid = createJid(mention);
            if (isJidGroup(jid)) {
              return null;
            }
            return jid;
          });
        }

        messageSent = await this.sendMessage(
          sender,
          message,
          mentions,
          linkPreview,
          quoted,
          null,
          group?.ephemeralDuration,
          // group?.participants,
        );
      } else {
        messageSent = await this.sendMessage(sender, message, mentions, linkPreview, quoted);
      }

      if (Long.isLong(messageSent?.messageTimestamp)) {
        messageSent.messageTimestamp = messageSent.messageTimestamp?.toNumber();
      }

      const messageRaw = this.prepareMessage(messageSent);

      const isMedia =
        messageSent?.message?.imageMessage ||
        messageSent?.message?.videoMessage ||
        messageSent?.message?.stickerMessage ||
        messageSent?.message?.ptvMessage ||
        messageSent?.message?.documentMessage ||
        messageSent?.message?.documentWithCaptionMessage ||
        messageSent?.message?.ptvMessage ||
        messageSent?.message?.audioMessage;

      if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled && !isIntegration) {
        this.chatwootService.eventWhatsapp(
          Events.SEND_MESSAGE,
          { instanceName: this.instance.name, instanceId: this.instanceId },
          messageRaw,
        );
      }

      if (this.configService.get<Openai>('OPENAI').ENABLED && messageRaw?.message?.audioMessage) {
        const openAiDefaultSettings = await this.prismaRepository.openaiSetting.findFirst({
          where: {
            instanceId: this.instanceId,
          },
          include: {
            OpenaiCreds: true,
          },
        });

        if (openAiDefaultSettings && openAiDefaultSettings.openaiCredsId && openAiDefaultSettings.speechToText) {
          messageRaw.message.speechToText = await this.openaiService.speechToText(
            openAiDefaultSettings.OpenaiCreds,
            messageRaw,
          );
        }
      }

      if (this.configService.get<Database>('DATABASE').SAVE_DATA.NEW_MESSAGE) {
        const msg = await this.prismaRepository.message.create({
          data: messageRaw,
        });

        if (isMedia && this.configService.get<S3>('S3').ENABLE) {
          try {
            const message: any = messageRaw;
            const media = await this.getBase64FromMediaMessage(
              {
                message,
              },
              true,
            );

            const { buffer, mediaType, fileName, size } = media;

            const mimetype = mime.getType(fileName).toString();

            const fullName = join(
              `${this.instance.id}`,
              messageRaw.key.remoteJid,
              `${messageRaw.key.id}`,
              mediaType,
              fileName,
            );

            await s3Service.uploadFile(fullName, buffer, size.fileLength?.low, {
              'Content-Type': mimetype,
            });

            await this.prismaRepository.media.create({
              data: {
                messageId: msg.id,
                instanceId: this.instanceId,
                type: mediaType,
                fileName: fullName,
                mimetype,
              },
            });

            const mediaUrl = await s3Service.getObjectUrl(fullName);

            messageRaw.message.mediaUrl = mediaUrl;

            await this.prismaRepository.message.update({
              where: { id: msg.id },
              data: messageRaw,
            });
          } catch (error) {
            this.logger.error(['Error on upload file to minio', error?.message, error?.stack]);
          }
        }
      }

      if (this.localWebhook.enabled) {
        if (isMedia && this.localWebhook.webhookBase64) {
          const buffer = await downloadMediaMessage(
            { key: messageRaw.key, message: messageRaw?.message },
            'buffer',
            {},
            {
              logger: P({ level: 'error' }) as any,
              reuploadRequest: this.client.updateMediaMessage,
            },
          );

          messageRaw.message.base64 = buffer ? buffer.toString('base64') : undefined;
        }
      }

      this.logger.log(messageRaw);

      this.sendDataWebhook(Events.SEND_MESSAGE, messageRaw);

      if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled && isIntegration) {
        await chatbotController.emit({
          instance: { instanceName: this.instance.name, instanceId: this.instanceId },
          remoteJid: messageRaw.key.remoteJid,
          msg: messageRaw,
          pushName: messageRaw.pushName,
          isIntegration,
        });
      }

      return messageRaw;
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  // Instance Controller
  public async sendPresence(data: SendPresenceDto) {
    try {
      const { number } = data;

      const isWA = (await this.whatsappNumber({ numbers: [number] }))?.shift();

      if (!isWA.exists && !isJidGroup(isWA.jid) && !isWA.jid.includes('@broadcast') && !isWA.jid.includes('@lid')) {
        throw new BadRequestException(isWA);
      }

      const sender = isWA.jid;

      if (data?.delay && data?.delay > 20000) {
        let remainingDelay = data?.delay;
        while (remainingDelay > 20000) {
          await this.client.presenceSubscribe(sender);

          await this.client.sendPresenceUpdate((data?.presence as WAPresence) ?? 'composing', sender);

          await delay(20000);

          await this.client.sendPresenceUpdate('paused', sender);

          remainingDelay -= 20000;
        }
        if (remainingDelay > 0) {
          await this.client.presenceSubscribe(sender);

          await this.client.sendPresenceUpdate((data?.presence as WAPresence) ?? 'composing', sender);

          await delay(remainingDelay);

          await this.client.sendPresenceUpdate('paused', sender);
        }
      } else {
        await this.client.presenceSubscribe(sender);

        await this.client.sendPresenceUpdate((data?.presence as WAPresence) ?? 'composing', sender);

        await delay(data?.delay);

        await this.client.sendPresenceUpdate('paused', sender);
      }

      return { presence: data.presence };
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  // Presence Controller
  public async setPresence(data: SetPresenceDto) {
    try {
      await this.client.sendPresenceUpdate(data.presence);

      return { presence: data.presence };
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  // Send Message Controller
  public async textMessage(data: SendTextDto, isIntegration = false) {
    const text = data.text;

    if (!text || text.trim().length === 0) {
      throw new BadRequestException('Text is required');
    }

    return await this.sendMessageWithTyping(
      data.number,
      {
        conversation: data.text,
      },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        linkPreview: data?.linkPreview,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
      isIntegration,
    );
  }

  public async pollMessage(data: SendPollDto) {
    return await this.sendMessageWithTyping(
      data.number,
      {
        poll: {
          name: data.name,
          selectableCount: data.selectableCount,
          values: data.values,
        },
      },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        linkPreview: data?.linkPreview,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
    );
  }

  private async formatStatusMessage(status: StatusMessage) {
    if (!status.type) {
      throw new BadRequestException('Type is required');
    }

    if (!status.content) {
      throw new BadRequestException('Content is required');
    }

    if (status.allContacts) {
      const contacts = await this.prismaRepository.contact.findMany({
        where: { instanceId: this.instanceId },
      });

      if (!contacts.length) {
        throw new BadRequestException('Contacts not found');
      }

      status.statusJidList = contacts.filter((contact) => contact.pushName).map((contact) => contact.remoteJid);
    }

    if (!status.statusJidList?.length && !status.allContacts) {
      throw new BadRequestException('StatusJidList is required');
    }

    if (status.type === 'text') {
      if (!status.backgroundColor) {
        throw new BadRequestException('Background color is required');
      }

      if (!status.font) {
        throw new BadRequestException('Font is required');
      }

      return {
        content: {
          text: status.content,
        },
        option: {
          backgroundColor: status.backgroundColor,
          font: status.font,
          statusJidList: status.statusJidList,
        },
      };
    }
    if (status.type === 'image') {
      return {
        content: {
          image: {
            url: status.content,
          },
          caption: status.caption,
        },
        option: {
          statusJidList: status.statusJidList,
        },
      };
    }

    if (status.type === 'video') {
      return {
        content: {
          video: {
            url: status.content,
          },
          caption: status.caption,
        },
        option: {
          statusJidList: status.statusJidList,
        },
      };
    }

    if (status.type === 'audio') {
      const convert = await this.processAudioMp4(status.content);
      if (Buffer.isBuffer(convert)) {
        const result = {
          content: {
            audio: convert,
            ptt: true,
            mimetype: 'audio/ogg; codecs=opus',
          },
          option: {
            statusJidList: status.statusJidList,
          },
        };

        return result;
      } else {
        throw new InternalServerErrorException(convert);
      }
    }

    throw new BadRequestException('Type not found');
  }

  public async statusMessage(data: SendStatusDto, file?: any) {
    const mediaData: SendStatusDto = { ...data };

    if (file) mediaData.content = file.buffer.toString('base64');

    const status = await this.formatStatusMessage(mediaData);

    const statusSent = await this.sendMessageWithTyping('status@broadcast', {
      status,
    });

    return statusSent;
  }

  private async prepareMediaMessage(mediaMessage: MediaMessage) {
    try {
      const type = mediaMessage.mediatype === 'ptv' ? 'video' : mediaMessage.mediatype;

      const prepareMedia = await prepareWAMessageMedia(
        {
          [type]: isURL(mediaMessage.media) ? { url: mediaMessage.media } : Buffer.from(mediaMessage.media, 'base64'),
        } as any,
        { upload: this.client.waUploadToServer },
      );

      const mediaType = mediaMessage.mediatype + 'Message';

      if (mediaMessage.mediatype === 'document' && !mediaMessage.fileName) {
        const regex = new RegExp(/.*\/(.+?)\./);
        const arrayMatch = regex.exec(mediaMessage.media);
        mediaMessage.fileName = arrayMatch[1];
      }

      if (mediaMessage.mediatype === 'image' && !mediaMessage.fileName) {
        mediaMessage.fileName = 'image.png';
      }

      if (mediaMessage.mediatype === 'video' && !mediaMessage.fileName) {
        mediaMessage.fileName = 'video.mp4';
      }

      let mimetype: string;

      if (mediaMessage.mimetype) {
        mimetype = mediaMessage.mimetype;
      } else {
        mimetype = mime.getType(mediaMessage.fileName);

        if (!mimetype && isURL(mediaMessage.media)) {
          let config: any = {
            responseType: 'arraybuffer',
          };

          if (this.localProxy?.enabled) {
            config = {
              ...config,
              httpsAgent: makeProxyAgent({
                host: this.localProxy.host,
                port: this.localProxy.port,
                protocol: this.localProxy.protocol,
                username: this.localProxy.username,
                password: this.localProxy.password,
              }),
            };
          }

          const response = await axios.get(mediaMessage.media, config);

          mimetype = response.headers['content-type'] as string;
        }
      }

      if (mediaMessage.mediatype === 'ptv') {
        prepareMedia[mediaType] = prepareMedia[type + 'Message'];
        mimetype = 'video/mp4';

        if (!prepareMedia[mediaType]) {
          throw new Error('Failed to prepare video message');
        }

        try {
          let mediaInput;
          if (isURL(mediaMessage.media)) {
            mediaInput = mediaMessage.media;
          } else {
            const mediaBuffer = Buffer.from(mediaMessage.media, 'base64');
            if (!mediaBuffer || mediaBuffer.length === 0) {
              throw new Error('Invalid media buffer');
            }
            mediaInput = mediaBuffer;
          }

          const duration = await getVideoDuration(mediaInput);
          if (!duration || duration <= 0) {
            throw new Error('Invalid media duration');
          }

          this.logger.verbose(`Video duration: ${duration} seconds`);
          prepareMedia[mediaType].seconds = duration;
        } catch (error) {
          this.logger.error('Error getting video duration:');
          this.logger.error(error);
          throw new Error(`Failed to get video duration: ${error.message}`);
        }
      }

      prepareMedia[mediaType].caption = mediaMessage?.caption;
      prepareMedia[mediaType].mimetype = mimetype;
      prepareMedia[mediaType].fileName = mediaMessage.fileName;

      if (mediaMessage.mediatype === 'video') {
        prepareMedia[mediaType].jpegThumbnail = Uint8Array.from(
          readFileSync(join(process.cwd(), 'public', 'images', 'video-cover.png')),
        );
        prepareMedia[mediaType].gifPlayback = false;
      }

      return generateWAMessageFromContent(
        '',
        { [mediaType]: { ...prepareMedia[mediaType] } },
        { userJid: this.instance.wuid },
      );
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException(error?.toString() || error);
    }
  }

  private async convertToWebP(image: string): Promise<Buffer> {
    try {
      let imageBuffer: Buffer;

      if (isBase64(image)) {
        const base64Data = image.replace(/^data:image\/(jpeg|png|gif);base64,/, '');
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else {
        const timestamp = new Date().getTime();
        const url = `${image}?timestamp=${timestamp}`;

        let config: any = {
          responseType: 'arraybuffer',
        };

        if (this.localProxy?.enabled) {
          config = {
            ...config,
            httpsAgent: makeProxyAgent({
              host: this.localProxy.host,
              port: this.localProxy.port,
              protocol: this.localProxy.protocol,
              username: this.localProxy.username,
              password: this.localProxy.password,
            }),
          };
        }

        const response = await axios.get(url, config);
        imageBuffer = Buffer.from(response.data, 'binary');
      }

      const webpBuffer = await sharp(imageBuffer).webp().toBuffer();

      return webpBuffer;
    } catch (error) {
      console.error('Erro ao converter a imagem para WebP:', error);
      throw error;
    }
  }

  public async mediaSticker(data: SendStickerDto, file?: any) {
    const mediaData: SendStickerDto = { ...data };

    if (file) mediaData.sticker = file.buffer.toString('base64');

    const convert = await this.convertToWebP(data.sticker);
    const gifPlayback = data.sticker.includes('.gif');
    const result = await this.sendMessageWithTyping(
      data.number,
      {
        sticker: convert,
        gifPlayback,
      },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
    );

    return result;
  }

  public async mediaMessage(data: SendMediaDto, file?: any, isIntegration = false) {
    const mediaData: SendMediaDto = { ...data };

    if (file) mediaData.media = file.buffer.toString('base64');

    const generate = await this.prepareMediaMessage(mediaData);

    const mediaSent = await this.sendMessageWithTyping(
      data.number,
      { ...generate.message },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
      isIntegration,
    );

    return mediaSent;
  }

  public async ptvMessage(data: SendPtvDto, file?: any, isIntegration = false) {
    const mediaData: SendMediaDto = {
      number: data.number,
      media: data.video,
      mediatype: 'ptv',
      delay: data?.delay,
      quoted: data?.quoted,
      mentionsEveryOne: data?.mentionsEveryOne,
      mentioned: data?.mentioned,
    };

    if (file) mediaData.media = file.buffer.toString('base64');

    const generate = await this.prepareMediaMessage(mediaData);

    const mediaSent = await this.sendMessageWithTyping(
      data.number,
      { ...generate.message },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
      isIntegration,
    );

    return mediaSent;
  }

  public async processAudioMp4(audio: string) {
    let inputStream: PassThrough;

    if (isURL(audio)) {
      const response = await axios.get(audio, { responseType: 'stream' });
      inputStream = response.data;
    } else {
      const audioBuffer = Buffer.from(audio, 'base64');
      inputStream = new PassThrough();
      inputStream.end(audioBuffer);
    }

    return new Promise<Buffer>((resolve, reject) => {
      const ffmpegProcess = spawn(ffmpegPath.path, [
        '-i',
        'pipe:0',
        '-vn',
        '-ab',
        '128k',
        '-ar',
        '44100',
        '-f',
        'mp4',
        '-movflags',
        'frag_keyframe+empty_moov',
        'pipe:1',
      ]);

      const outputChunks: Buffer[] = [];
      let stderrData = '';

      ffmpegProcess.stdout.on('data', (chunk) => {
        outputChunks.push(chunk);
      });

      ffmpegProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
        this.logger.verbose(`ffmpeg stderr: ${data}`);
      });

      ffmpegProcess.on('error', (error) => {
        console.error('Error in ffmpeg process', error);
        reject(error);
      });

      ffmpegProcess.on('close', (code) => {
        if (code === 0) {
          this.logger.verbose('Audio converted to mp4');
          const outputBuffer = Buffer.concat(outputChunks);
          resolve(outputBuffer);
        } else {
          this.logger.error(`ffmpeg exited with code ${code}`);
          this.logger.error(`ffmpeg stderr: ${stderrData}`);
          reject(new Error(`ffmpeg exited with code ${code}: ${stderrData}`));
        }
      });

      inputStream.pipe(ffmpegProcess.stdin);

      inputStream.on('error', (err) => {
        console.error('Error in inputStream', err);
        ffmpegProcess.stdin.end();
        reject(err);
      });
    });
  }

  public async processAudio(audio: string): Promise<Buffer> {
    if (process.env.API_AUDIO_CONVERTER) {
      this.logger.verbose('Using audio converter API');
      const formData = new FormData();

      if (isURL(audio)) {
        formData.append('url', audio);
      } else {
        formData.append('base64', audio);
      }

      const { data } = await axios.post(process.env.API_AUDIO_CONVERTER, formData, {
        headers: {
          ...formData.getHeaders(),
          apikey: process.env.API_AUDIO_CONVERTER_KEY,
        },
      });

      if (!data.audio) {
        throw new InternalServerErrorException('Failed to convert audio');
      }

      this.logger.verbose('Audio converted');
      return Buffer.from(data.audio, 'base64');
    } else {
      let inputAudioStream: PassThrough;

      if (isURL(audio)) {
        const timestamp = new Date().getTime();
        const url = `${audio}?timestamp=${timestamp}`;

        const config: any = {
          responseType: 'stream',
        };

        const response = await axios.get(url, config);
        inputAudioStream = response.data.pipe(new PassThrough());
      } else {
        const audioBuffer = Buffer.from(audio, 'base64');
        inputAudioStream = new PassThrough();
        inputAudioStream.end(audioBuffer);
      }

      return new Promise((resolve, reject) => {
        const outputAudioStream = new PassThrough();
        const chunks: Buffer[] = [];

        outputAudioStream.on('data', (chunk) => chunks.push(chunk));
        outputAudioStream.on('end', () => {
          const outputBuffer = Buffer.concat(chunks);
          resolve(outputBuffer);
        });

        outputAudioStream.on('error', (error) => {
          console.log('error', error);
          reject(error);
        });

        ffmpeg.setFfmpegPath(ffmpegPath.path);

        ffmpeg(inputAudioStream)
          .outputFormat('ogg')
          .noVideo()
          .audioCodec('libopus')
          .addOutputOptions('-avoid_negative_ts make_zero')
          .audioChannels(1)
          .pipe(outputAudioStream, { end: true })
          .on('error', function (error) {
            console.log('error', error);
            reject(error);
          });
      });
    }
  }

  public async audioWhatsapp(data: SendAudioDto, file?: any, isIntegration = false) {
    const mediaData: SendAudioDto = { ...data };

    if (file?.buffer) {
      mediaData.audio = file.buffer.toString('base64');
    } else if (!isURL(data.audio) && !isBase64(data.audio)) {
      console.error('Invalid file or audio source');
      throw new BadRequestException('File buffer, URL, or base64 audio is required');
    }

    if (!data?.encoding && data?.encoding !== false) {
      data.encoding = true;
    }

    if (data?.encoding) {
      const convert = await this.processAudio(mediaData.audio);

      if (Buffer.isBuffer(convert)) {
        const result = this.sendMessageWithTyping<AnyMessageContent>(
          data.number,
          {
            audio: convert,
            ptt: true,
            mimetype: 'audio/ogg; codecs=opus',
          },
          { presence: 'recording', delay: data?.delay, quoted: data?.quoted },
          isIntegration,
        );

        return result;
      } else {
        throw new InternalServerErrorException('Failed to convert audio');
      }
    }

    return await this.sendMessageWithTyping<AnyMessageContent>(
      data.number,
      {
        audio: isURL(data.audio) ? { url: data.audio } : Buffer.from(data.audio, 'base64'),
        ptt: true,
        mimetype: 'audio/ogg; codecs=opus',
      },
      { presence: 'recording', delay: data?.delay, quoted: data?.quoted },
      isIntegration,
    );
  }

  private generateRandomId(length = 11) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
  }

  private toJSONString(button: Button): string {
    const toString = (obj: any) => JSON.stringify(obj);

    const json = {
      call: () => toString({ display_text: button.displayText, phone_number: button.phoneNumber }),
      reply: () => toString({ display_text: button.displayText, id: button.id }),
      copy: () => toString({ display_text: button.displayText, copy_code: button.copyCode }),
      url: () =>
        toString({
          display_text: button.displayText,
          url: button.url,
          merchant_url: button.url,
        }),
      pix: () =>
        toString({
          currency: button.currency,
          total_amount: {
            value: 0,
            offset: 100,
          },
          reference_id: this.generateRandomId(),
          type: 'physical-goods',
          order: {
            status: 'pending',
            subtotal: {
              value: 0,
              offset: 100,
            },
            order_type: 'ORDER',
            items: [
              {
                name: '',
                amount: {
                  value: 0,
                  offset: 100,
                },
                quantity: 0,
                sale_amount: {
                  value: 0,
                  offset: 100,
                },
              },
            ],
          },
          payment_settings: [
            {
              type: 'pix_static_code',
              pix_static_code: {
                merchant_name: button.name,
                key: button.key,
                key_type: this.mapKeyType.get(button.keyType),
              },
            },
          ],
          share_payment_status: false,
        }),
    };

    return json[button.type]?.() || '';
  }

  private readonly mapType = new Map<TypeButton, string>([
    ['reply', 'quick_reply'],
    ['copy', 'cta_copy'],
    ['url', 'cta_url'],
    ['call', 'cta_call'],
    ['pix', 'payment_info'],
  ]);

  private readonly mapKeyType = new Map<KeyType, string>([
    ['phone', 'PHONE'],
    ['email', 'EMAIL'],
    ['cpf', 'CPF'],
    ['cnpj', 'CNPJ'],
    ['random', 'EVP'],
  ]);

  public async buttonMessage(data: SendButtonsDto) {
    if (data.buttons.length === 0) {
      throw new BadRequestException('At least one button is required');
    }

    const hasReplyButtons = data.buttons.some((btn) => btn.type === 'reply');

    const hasPixButton = data.buttons.some((btn) => btn.type === 'pix');

    const hasOtherButtons = data.buttons.some((btn) => btn.type !== 'reply' && btn.type !== 'pix');

    if (hasReplyButtons) {
      if (data.buttons.length > 3) {
        throw new BadRequestException('Maximum of 3 reply buttons allowed');
      }
      if (hasOtherButtons) {
        throw new BadRequestException('Reply buttons cannot be mixed with other button types');
      }
    }

    if (hasPixButton) {
      if (data.buttons.length > 1) {
        throw new BadRequestException('Only one PIX button is allowed');
      }
      if (hasOtherButtons) {
        throw new BadRequestException('PIX button cannot be mixed with other button types');
      }

      const message: proto.IMessage = {
        viewOnceMessage: {
          message: {
            interactiveMessage: {
              nativeFlowMessage: {
                buttons: [
                  {
                    name: this.mapType.get('pix'),
                    buttonParamsJson: this.toJSONString(data.buttons[0]),
                  },
                ],
                messageParamsJson: JSON.stringify({
                  from: 'api',
                  templateId: v4(),
                }),
              },
            },
          },
        },
      };

      return await this.sendMessageWithTyping(data.number, message, {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      });
    }

    const generate = await (async () => {
      if (data?.thumbnailUrl) {
        return await this.prepareMediaMessage({
          mediatype: 'image',
          media: data.thumbnailUrl,
        });
      }
    })();

    const buttons = data.buttons.map((value) => {
      return {
        name: this.mapType.get(value.type),
        buttonParamsJson: this.toJSONString(value),
      };
    });

    const message: proto.IMessage = {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            body: {
              text: (() => {
                let t = '*' + data.title + '*';
                if (data?.description) {
                  t += '\n\n';
                  t += data.description;
                  t += '\n';
                }
                return t;
              })(),
            },
            footer: {
              text: data?.footer,
            },
            header: (() => {
              if (generate?.message?.imageMessage) {
                return {
                  hasMediaAttachment: !!generate.message.imageMessage,
                  imageMessage: generate.message.imageMessage,
                };
              }
            })(),
            nativeFlowMessage: {
              buttons: buttons,
              messageParamsJson: JSON.stringify({
                from: 'api',
                templateId: v4(),
              }),
            },
          },
        },
      },
    };

    return await this.sendMessageWithTyping(data.number, message, {
      delay: data?.delay,
      presence: 'composing',
      quoted: data?.quoted,
      mentionsEveryOne: data?.mentionsEveryOne,
      mentioned: data?.mentioned,
    });
  }

  public async locationMessage(data: SendLocationDto) {
    return await this.sendMessageWithTyping(
      data.number,
      {
        locationMessage: {
          degreesLatitude: data.latitude,
          degreesLongitude: data.longitude,
          name: data?.name,
          address: data?.address,
        },
      },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
    );
  }

  public async listMessage(data: SendListDto) {
    return await this.sendMessageWithTyping(
      data.number,
      {
        listMessage: {
          title: data.title,
          description: data.description,
          buttonText: data?.buttonText,
          footerText: data?.footerText,
          sections: data.sections,
          listType: 2,
        },
      },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
    );
  }

  public async contactMessage(data: SendContactDto) {
    const message: proto.IMessage = {};

    const vcard = (contact: ContactMessage) => {
      let result = 'BEGIN:VCARD\n' + 'VERSION:3.0\n' + `N:${contact.fullName}\n` + `FN:${contact.fullName}\n`;

      if (contact.organization) {
        result += `ORG:${contact.organization};\n`;
      }

      if (contact.email) {
        result += `EMAIL:${contact.email}\n`;
      }

      if (contact.url) {
        result += `URL:${contact.url}\n`;
      }

      if (!contact.wuid) {
        contact.wuid = createJid(contact.phoneNumber);
      }

      result += `item1.TEL;waid=${contact.wuid}:${contact.phoneNumber}\n` + 'item1.X-ABLabel:Celular\n' + 'END:VCARD';

      return result;
    };

    if (data.contact.length === 1) {
      message.contactMessage = {
        displayName: data.contact[0].fullName,
        vcard: vcard(data.contact[0]),
      };
    } else {
      message.contactsArrayMessage = {
        displayName: `${data.contact.length} contacts`,
        contacts: data.contact.map((contact) => {
          return {
            displayName: contact.fullName,
            vcard: vcard(contact),
          };
        }),
      };
    }

    return await this.sendMessageWithTyping(data.number, { ...message }, {});
  }

  public async reactionMessage(data: SendReactionDto) {
    return await this.sendMessageWithTyping(data.key.remoteJid, {
      reactionMessage: {
        key: data.key,
        text: data.reaction,
      },
    });
  }

  // Chat Controller
  public async whatsappNumber(data: WhatsAppNumberDto) {
    const jids: {
      groups: { number: string; jid: string }[];
      broadcast: { number: string; jid: string }[];
      users: { number: string; jid: string; name?: string }[];
    } = {
      groups: [],
      broadcast: [],
      users: [],
    };

    data.numbers.forEach((number) => {
      const jid = createJid(number);

      if (isJidGroup(jid)) {
        jids.groups.push({ number, jid });
      } else if (jid === 'status@broadcast') {
        jids.broadcast.push({ number, jid });
      } else {
        jids.users.push({ number, jid });
      }
    });

    const onWhatsapp: OnWhatsAppDto[] = [];

    // BROADCAST
    onWhatsapp.push(...jids.broadcast.map(({ jid, number }) => new OnWhatsAppDto(jid, false, number)));

    // GROUPS
    const groups = await Promise.all(
      jids.groups.map(async ({ jid, number }) => {
        const group = await this.findGroup({ groupJid: jid }, 'inner');

        if (!group) {
          new OnWhatsAppDto(jid, false, number);
        }

        return new OnWhatsAppDto(group.id, !!group?.id, number, group?.subject);
      }),
    );
    onWhatsapp.push(...groups);

    // USERS
    const contacts: any[] = await this.prismaRepository.contact.findMany({
      where: {
        instanceId: this.instanceId,
        remoteJid: {
          in: jids.users.map(({ jid }) => jid),
        },
      },
    });

    const numbersToVerify = jids.users.map(({ jid }) => jid.replace('+', ''));

    const cachedNumbers = await getOnWhatsappCache(numbersToVerify);
    const filteredNumbers = numbersToVerify.filter(
      (jid) => !cachedNumbers.some((cached) => cached.jidOptions.includes(jid)),
    );

    const verify = await this.client.onWhatsApp(...filteredNumbers);
    const users: OnWhatsAppDto[] = await Promise.all(
      jids.users.map(async (user) => {
        let numberVerified: (typeof verify)[0] | null = null;

        const cached = cachedNumbers.find((cached) => cached.jidOptions.includes(user.jid.replace('+', '')));
        if (cached) {
          return {
            exists: true,
            jid: cached.remoteJid,
            name: contacts.find((c) => c.remoteJid === cached.remoteJid)?.pushName,
            number: user.number,
          };
        }

        // Brazilian numbers
        if (user.number.startsWith('55')) {
          const numberWithDigit =
            user.number.slice(4, 5) === '9' && user.number.length === 13
              ? user.number
              : `${user.number.slice(0, 4)}9${user.number.slice(4)}`;
          const numberWithoutDigit =
            user.number.length === 12 ? user.number : user.number.slice(0, 4) + user.number.slice(5);

          numberVerified = verify.find(
            (v) => v.jid === `${numberWithDigit}@s.whatsapp.net` || v.jid === `${numberWithoutDigit}@s.whatsapp.net`,
          );
        }

        // Mexican/Argentina numbers
        // Ref: https://faq.whatsapp.com/1294841057948784
        if (!numberVerified && (user.number.startsWith('52') || user.number.startsWith('54'))) {
          let prefix = '';
          if (user.number.startsWith('52')) {
            prefix = '';
          }
          if (user.number.startsWith('54')) {
            prefix = '9';
          }

          const numberWithDigit =
            user.number.slice(2, 3) === prefix && user.number.length === 13
              ? user.number
              : `${user.number.slice(0, 2)}${prefix}${user.number.slice(2)}`;
          const numberWithoutDigit =
            user.number.length === 12 ? user.number : user.number.slice(0, 2) + user.number.slice(3);

          numberVerified = verify.find(
            (v) => v.jid === `${numberWithDigit}@s.whatsapp.net` || v.jid === `${numberWithoutDigit}@s.whatsapp.net`,
          );
        }

        if (!numberVerified) {
          numberVerified = verify.find((v) => v.jid === user.jid);
        }

        const numberJid = numberVerified?.jid || user.jid;

        return {
          exists: !!numberVerified?.exists,
          jid: numberJid,
          name: contacts.find((c) => c.remoteJid === numberJid)?.pushName,
          number: user.number,
        };
      }),
    );

    await saveOnWhatsappCache(users.filter((user) => user.exists).map((user) => ({ remoteJid: user.jid })));

    onWhatsapp.push(...users);

    return onWhatsapp;
  }

  public async markMessageAsRead(data: ReadMessageDto) {
    try {
      const keys: proto.IMessageKey[] = [];
      data.readMessages.forEach((read) => {
        if (isJidGroup(read.remoteJid) || isPnUser(read.remoteJid) || isLidUser(read.remoteJid)) {
          keys.push({
            remoteJid: read.remoteJid,
            fromMe: read.fromMe,
            id: read.id,
          });
        }
      });
      await this.client.readMessages(keys);
      return { message: 'Read messages', read: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Read messages fail', error.toString());
    }
  }

  public async getLastMessage(number: string) {
    const where: any = {
      key: {
        remoteJid: number,
      },
      instanceId: this.instance.id,
    };

    const messages = await this.prismaRepository.message.findMany({
      where,
      orderBy: {
        messageTimestamp: 'desc',
      },
      take: 1,
    });

    if (messages.length === 0) {
      throw new NotFoundException('Messages not found');
    }

    let lastMessage = messages.pop();

    for (const message of messages) {
      if (message.messageTimestamp >= lastMessage.messageTimestamp) {
        lastMessage = message;
      }
    }

    return lastMessage as unknown as LastMessage;
  }

  public async archiveChat(data: ArchiveChatDto) {
    try {
      let last_message = data.lastMessage;
      let number = data.chat;

      if (!last_message && number) {
        last_message = await this.getLastMessage(number);
      } else {
        last_message = data.lastMessage;
        last_message.messageTimestamp = last_message?.messageTimestamp ?? Date.now();
        number = last_message?.key?.remoteJid;
      }

      if (!last_message || Object.keys(last_message).length === 0) {
        throw new NotFoundException('Last message not found');
      }

      await this.client.chatModify(
        {
          archive: data.archive,
          lastMessages: [last_message],
        },
        createJid(number),
      );

      return {
        chatId: number,
        archived: true,
      };
    } catch (error) {
      throw new InternalServerErrorException({
        archived: false,
        message: ['An error occurred while archiving the chat. Open a calling.', error.toString()],
      });
    }
  }

  public async markChatUnread(data: MarkChatUnreadDto) {
    try {
      let last_message = data.lastMessage;
      let number = data.chat;

      if (!last_message && number) {
        last_message = await this.getLastMessage(number);
      } else {
        last_message = data.lastMessage;
        last_message.messageTimestamp = last_message?.messageTimestamp ?? Date.now();
        number = last_message?.key?.remoteJid;
      }

      if (!last_message || Object.keys(last_message).length === 0) {
        throw new NotFoundException('Last message not found');
      }

      await this.client.chatModify(
        {
          markRead: false,
          lastMessages: [last_message],
        },
        createJid(number),
      );

      return {
        chatId: number,
        markedChatUnread: true,
      };
    } catch (error) {
      throw new InternalServerErrorException({
        markedChatUnread: false,
        message: ['An error occurred while marked unread the chat. Open a calling.', error.toString()],
      });
    }
  }

  public async deleteMessage(del: DeleteMessage) {
    try {
      const response = await this.client.sendMessage(del.remoteJid, { delete: del });
      if (response) {
        const messageId = response.message?.protocolMessage?.key?.id;
        if (messageId) {
          const isLogicalDeleted = configService.get<Database>('DATABASE').DELETE_DATA.LOGICAL_MESSAGE_DELETE;
          let message = await this.prismaRepository.message.findUnique({
            where: { id: messageId },
          });
          if (isLogicalDeleted) {
            if (!message) return response;
            const existingKey = typeof message?.key === 'object' && message.key !== null ? message.key : {};
            message = await this.prismaRepository.message.update({
              where: { id: messageId },
              data: {
                key: {
                  ...existingKey,
                  deleted: true,
                },
              },
            });
          } else {
            await this.prismaRepository.message.deleteMany({
              where: {
                id: messageId,
              },
            });
          }
          this.sendDataWebhook(Events.MESSAGES_DELETE, {
            id: message.id,
            instanceId: message.instanceId,
            key: message.key,
            messageType: message.messageType,
            status: message.status,
            source: message.source,
            messageTimestamp: message.messageTimestamp,
            pushName: message.pushName,
            participant: message.participant,
            message: message.message,
          });
        }
      }

      return response;
    } catch (error) {
      throw new InternalServerErrorException('Error while deleting message for everyone', error?.toString());
    }
  }

  public async getBase64FromMediaMessage(data: getBase64FromMediaMessageDto, getBuffer = false) {
    try {
      const m = data?.message;
      const convertToMp4 = data?.convertToMp4 ?? false;

      const msg = m?.message ? m : ((await this.getMessage(m.key, true)) as proto.IWebMessageInfo);

      if (!msg) {
        throw 'Message not found';
      }

      for (const subtype of MessageSubtype) {
        if (msg.message[subtype]) {
          msg.message = msg.message[subtype].message;
        }
      }

      let mediaMessage: any;
      let mediaType: string;

      for (const type of TypeMediaMessage) {
        mediaMessage = msg.message[type];
        if (mediaMessage) {
          mediaType = type;
          break;
        }
      }

      if (!mediaMessage) {
        throw 'The message is not of the media type';
      }

      if (typeof mediaMessage['mediaKey'] === 'object') {
        msg.message = JSON.parse(JSON.stringify(msg.message));
      }

      const buffer = await downloadMediaMessage(
        { key: msg?.key, message: msg?.message },
        'buffer',
        {},
        {
          logger: P({ level: 'error' }) as any,
          reuploadRequest: this.client.updateMediaMessage,
        },
      );
      const typeMessage = getContentType(msg.message);

      const ext = mime.getExtension(mediaMessage?.['mimetype']);
      const fileName = mediaMessage?.['fileName'] || `${msg.key.id}.${ext}` || `${v4()}.${ext}`;

      if (convertToMp4 && typeMessage === 'audioMessage') {
        try {
          const convert = await this.processAudioMp4(buffer.toString('base64'));

          if (Buffer.isBuffer(convert)) {
            const result = {
              mediaType,
              fileName,
              caption: mediaMessage['caption'],
              size: {
                fileLength: mediaMessage['fileLength'],
                height: mediaMessage['height'],
                width: mediaMessage['width'],
              },
              mimetype: 'audio/mp4',
              base64: convert.toString('base64'),
              buffer: getBuffer ? convert : null,
            };

            return result;
          }
        } catch (error) {
          this.logger.error('Error converting audio to mp4:');
          this.logger.error(error);
          throw new BadRequestException('Failed to convert audio to MP4');
        }
      }

      return {
        mediaType,
        fileName,
        caption: mediaMessage['caption'],
        size: {
          fileLength: mediaMessage['fileLength'],
          height: mediaMessage['height'],
          width: mediaMessage['width'],
        },
        mimetype: mediaMessage['mimetype'],
        base64: buffer.toString('base64'),
        buffer: getBuffer ? buffer : null,
      };
    } catch (error) {
      this.logger.error('Error processing media message:');
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  public async fetchPrivacySettings() {
    const privacy = await this.client.fetchPrivacySettings();

    return {
      readreceipts: privacy.readreceipts,
      profile: privacy.profile,
      status: privacy.status,
      online: privacy.online,
      last: privacy.last,
      groupadd: privacy.groupadd,
    };
  }

  public async updatePrivacySettings(settings: PrivacySettingDto) {
    try {
      await this.client.updateReadReceiptsPrivacy(settings.readreceipts);
      await this.client.updateProfilePicturePrivacy(settings.profile);
      await this.client.updateStatusPrivacy(settings.status);
      await this.client.updateOnlinePrivacy(settings.online);
      await this.client.updateLastSeenPrivacy(settings.last);
      await this.client.updateGroupsAddPrivacy(settings.groupadd);

      this.reloadConnection();

      return {
        update: 'success',
        data: {
          readreceipts: settings.readreceipts,
          profile: settings.profile,
          status: settings.status,
          online: settings.online,
          last: settings.last,
          groupadd: settings.groupadd,
        },
      };
    } catch (error) {
      throw new InternalServerErrorException('Error updating privacy settings', error.toString());
    }
  }

  public async fetchBusinessProfile(number: string): Promise<NumberBusiness> {
    try {
      const jid = number ? createJid(number) : this.instance.wuid;

      const profile = await this.client.getBusinessProfile(jid);

      if (!profile) {
        const info = await this.whatsappNumber({ numbers: [jid] });

        return {
          isBusiness: false,
          message: 'Not is business profile',
          ...info?.shift(),
        };
      }

      return {
        isBusiness: true,
        ...profile,
      };
    } catch (error) {
      throw new InternalServerErrorException('Error updating profile name', error.toString());
    }
  }

  public async updateProfileName(name: string) {
    try {
      await this.client.updateProfileName(name);

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error updating profile name', error.toString());
    }
  }

  public async updateProfileStatus(status: string) {
    try {
      await this.client.updateProfileStatus(status);

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error updating profile status', error.toString());
    }
  }

  public async updateProfilePicture(picture: string) {
    try {
      let pic: WAMediaUpload;
      if (isURL(picture)) {
        const timestamp = new Date().getTime();
        const url = `${picture}?timestamp=${timestamp}`;

        let config: any = {
          responseType: 'arraybuffer',
        };

        if (this.localProxy?.enabled) {
          config = {
            ...config,
            httpsAgent: makeProxyAgent({
              host: this.localProxy.host,
              port: this.localProxy.port,
              protocol: this.localProxy.protocol,
              username: this.localProxy.username,
              password: this.localProxy.password,
            }),
          };
        }

        pic = (await axios.get(url, config)).data;
      } else if (isBase64(picture)) {
        pic = Buffer.from(picture, 'base64');
      } else {
        throw new BadRequestException('"profilePicture" must be a url or a base64');
      }

      await this.client.updateProfilePicture(this.instance.wuid, pic);

      this.reloadConnection();

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error updating profile picture', error.toString());
    }
  }

  public async removeProfilePicture() {
    try {
      await this.client.removeProfilePicture(this.instance.wuid);

      this.reloadConnection();

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error removing profile picture', error.toString());
    }
  }

  public async blockUser(data: BlockUserDto) {
    try {
      const { number } = data;

      const isWA = (await this.whatsappNumber({ numbers: [number] }))?.shift();

      if (!isWA.exists && !isJidGroup(isWA.jid) && !isWA.jid.includes('@broadcast')) {
        throw new BadRequestException(isWA);
      }

      const sender = isWA.jid;

      await this.client.updateBlockStatus(sender, data.status);

      return { block: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error blocking user', error.toString());
    }
  }

  private async formatUpdateMessage(data: UpdateMessageDto) {
    try {
      const msg: any = await this.getMessage(data.key, true);

      if (msg?.messageType === 'conversation' || msg?.messageType === 'extendedTextMessage') {
        return {
          text: data.text,
        };
      }

      if (msg?.messageType === 'imageMessage') {
        return {
          image: msg?.message?.imageMessage,
          caption: data.text,
        };
      }

      if (msg?.messageType === 'videoMessage') {
        return {
          video: msg?.message?.videoMessage,
          caption: data.text,
        };
      }

      return null;
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  public async updateMessage(data: UpdateMessageDto) {
    const jid = createJid(data.number);

    const options = await this.formatUpdateMessage(data);

    if (!options) {
      this.logger.error('Message not compatible');
      throw new BadRequestException('Message not compatible');
    }

    try {
      return await this.client.sendMessage(jid, {
        ...(options as any),
        edit: data.key,
      });
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  public async fetchLabels(): Promise<LabelDto[]> {
    const labels = await this.prismaRepository.label.findMany({
      where: {
        instanceId: this.instanceId,
      },
    });

    return labels.map((label) => ({
      color: label.color,
      name: label.name,
      id: label.labelId,
      predefinedId: label.predefinedId,
    }));
  }

  public async handleLabel(data: HandleLabelDto) {
    const whatsappContact = await this.whatsappNumber({ numbers: [data.number] });
    if (whatsappContact.length === 0) {
      throw new NotFoundException('Number not found');
    }
    const contact = whatsappContact[0];
    if (!contact.exists) {
      throw new NotFoundException('Number is not on WhatsApp');
    }

    try {
      if (data.action === 'add') {
        await this.client.addChatLabel(contact.jid, data.labelId);

        return { numberJid: contact.jid, labelId: data.labelId, add: true };
      }
      if (data.action === 'remove') {
        await this.client.removeChatLabel(contact.jid, data.labelId);

        return { numberJid: contact.jid, labelId: data.labelId, remove: true };
      }
    } catch (error) {
      throw new BadRequestException(`Unable to ${data.action} label to chat`, error.toString());
    }
  }

  // Group
  private async updateGroupMetadataCache(groupJid: string) {
    try {
      const meta = await this.client.groupMetadata(groupJid);

      const cacheConf = this.configService.get<CacheConf>('CACHE');

      if ((cacheConf?.REDIS?.ENABLED && cacheConf?.REDIS?.URI !== '') || cacheConf?.LOCAL?.ENABLED) {
        this.logger.verbose(`Updating cache for group: ${groupJid}`);
        await groupMetadataCache.set(groupJid, {
          timestamp: Date.now(),
          data: meta,
        });
      }

      return meta;
    } catch (error) {
      this.logger.error(error);
      return null;
    }
  }

  private getGroupMetadataCache = async (groupJid: string) => {
    if (!isJidGroup(groupJid)) return null;

    const cacheConf = this.configService.get<CacheConf>('CACHE');

    if ((cacheConf?.REDIS?.ENABLED && cacheConf?.REDIS?.URI !== '') || cacheConf?.LOCAL?.ENABLED) {
      if (await groupMetadataCache?.has(groupJid)) {
        console.log(`Cache request for group: ${groupJid}`);
        const meta = await groupMetadataCache.get(groupJid);

        if (Date.now() - meta.timestamp > 3600000) {
          await this.updateGroupMetadataCache(groupJid);
        }

        return meta.data;
      }

      console.log(`Cache request for group: ${groupJid} - not found`);
      return await this.updateGroupMetadataCache(groupJid);
    }

    return await this.findGroup({ groupJid }, 'inner');
  };

  public async createGroup(create: CreateGroupDto) {
    try {
      const participants = (await this.whatsappNumber({ numbers: create.participants }))
        .filter((participant) => participant.exists)
        .map((participant) => participant.jid);
      const { id } = await this.client.groupCreate(create.subject, participants);

      if (create?.description) {
        await this.client.groupUpdateDescription(id, create.description);
      }

      if (create?.promoteParticipants) {
        await this.updateGParticipant({
          groupJid: id,
          action: 'promote',
          participants: participants,
        });
      }

      const group = await this.client.groupMetadata(id);

      return group;
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException('Error creating group', error.toString());
    }
  }

  public async updateGroupPicture(picture: GroupPictureDto) {
    try {
      let pic: WAMediaUpload;
      if (isURL(picture.image)) {
        const timestamp = new Date().getTime();
        const url = `${picture.image}?timestamp=${timestamp}`;

        let config: any = {
          responseType: 'arraybuffer',
        };

        if (this.localProxy?.enabled) {
          config = {
            ...config,
            httpsAgent: makeProxyAgent({
              host: this.localProxy.host,
              port: this.localProxy.port,
              protocol: this.localProxy.protocol,
              username: this.localProxy.username,
              password: this.localProxy.password,
            }),
          };
        }

        pic = (await axios.get(url, config)).data;
      } else if (isBase64(picture.image)) {
        pic = Buffer.from(picture.image, 'base64');
      } else {
        throw new BadRequestException('"profilePicture" must be a url or a base64');
      }
      await this.client.updateProfilePicture(picture.groupJid, pic);

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error update group picture', error.toString());
    }
  }

  public async updateGroupSubject(data: GroupSubjectDto) {
    try {
      await this.client.groupUpdateSubject(data.groupJid, data.subject);

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error updating group subject', error.toString());
    }
  }

  public async updateGroupDescription(data: GroupDescriptionDto) {
    try {
      await this.client.groupUpdateDescription(data.groupJid, data.description);

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error updating group description', error.toString());
    }
  }

  public async findGroup(id: GroupJid, reply: 'inner' | 'out' = 'out') {
    try {
      const group = await this.client.groupMetadata(id.groupJid);

      if (!group) {
        this.logger.error('Group not found');
        return null;
      }

      const picture = await this.profilePicture(group.id);

      return {
        id: group.id,
        subject: group.subject,
        subjectOwner: group.subjectOwner,
        subjectTime: group.subjectTime,
        pictureUrl: picture.profilePictureUrl,
        size: group.participants.length,
        creation: group.creation,
        owner: group.owner,
        desc: group.desc,
        descId: group.descId,
        restrict: group.restrict,
        announce: group.announce,
        participants: group.participants,
        isCommunity: group.isCommunity,
        isCommunityAnnounce: group.isCommunityAnnounce,
        linkedParent: group.linkedParent,
      };
    } catch (error) {
      if (reply === 'inner') {
        return;
      }
      throw new NotFoundException('Error fetching group', error.toString());
    }
  }

  public async fetchAllGroups(getParticipants: GetParticipant) {
    const fetch = Object.values(await this?.client?.groupFetchAllParticipating());

    let groups = [];
    for (const group of fetch) {
      const picture = await this.profilePicture(group.id);

      const result = {
        id: group.id,
        subject: group.subject,
        subjectOwner: group.subjectOwner,
        subjectTime: group.subjectTime,
        pictureUrl: picture?.profilePictureUrl,
        size: group.participants.length,
        creation: group.creation,
        owner: group.owner,
        desc: group.desc,
        descId: group.descId,
        restrict: group.restrict,
        announce: group.announce,
        isCommunity: group.isCommunity,
        isCommunityAnnounce: group.isCommunityAnnounce,
        linkedParent: group.linkedParent,
      };

      if (getParticipants.getParticipants == 'true') {
        result['participants'] = group.participants;
      }

      groups = [...groups, result];
    }

    return groups;
  }

  public async inviteCode(id: GroupJid) {
    try {
      const code = await this.client.groupInviteCode(id.groupJid);
      return { inviteUrl: `https://chat.whatsapp.com/${code}`, inviteCode: code };
    } catch (error) {
      throw new NotFoundException('No invite code', error.toString());
    }
  }

  public async inviteInfo(id: GroupInvite) {
    try {
      return await this.client.groupGetInviteInfo(id.inviteCode);
    } catch {
      throw new NotFoundException('No invite info', id.inviteCode);
    }
  }

  public async sendInvite(id: GroupSendInvite) {
    try {
      const inviteCode = await this.inviteCode({ groupJid: id.groupJid });

      const inviteUrl = inviteCode.inviteUrl;

      const numbers = id.numbers.map((number) => createJid(number));
      const description = id.description ?? '';

      const msg = `${description}\n\n${inviteUrl}`;

      const message = {
        conversation: msg,
      };

      for await (const number of numbers) {
        await this.sendMessageWithTyping(number, message);
      }

      return { send: true, inviteUrl };
    } catch {
      throw new NotFoundException('No send invite');
    }
  }

  public async acceptInviteCode(id: AcceptGroupInvite) {
    try {
      const groupJid = await this.client.groupAcceptInvite(id.inviteCode);
      return { accepted: true, groupJid: groupJid };
    } catch (error) {
      throw new NotFoundException('Accept invite error', error.toString());
    }
  }

  public async revokeInviteCode(id: GroupJid) {
    try {
      const inviteCode = await this.client.groupRevokeInvite(id.groupJid);
      return { revoked: true, inviteCode };
    } catch (error) {
      throw new NotFoundException('Revoke error', error.toString());
    }
  }

  public async findParticipants(id: GroupJid) {
    try {
      const participants = (await this.client.groupMetadata(id.groupJid)).participants;
      const contacts = await this.prismaRepository.contact.findMany({
        where: {
          instanceId: this.instanceId,
          remoteJid: {
            in: participants.map((p) => p.id),
          },
        },
      });
      const parsedParticipants = participants.map((participant) => {
        const contact = contacts.find((c) => c.remoteJid === participant.id);
        return {
          ...participant,
          name: participant.name ?? contact?.pushName,
          imgUrl: participant.imgUrl ?? contact?.profilePicUrl,
        };
      });

      const usersContacts = parsedParticipants.filter((c) => c.id.includes('@s.whatsapp'));
      if (usersContacts) {
        await saveOnWhatsappCache(usersContacts.map((c) => ({ remoteJid: c.id })));
      }

      return { participants: parsedParticipants };
    } catch (error) {
      console.error(error);
      throw new NotFoundException('No participants', error.toString());
    }
  }

  public async updateGParticipant(update: GroupUpdateParticipantDto) {
    try {
      const participants = update.participants.map((p) => createJid(p));
      const updateParticipants = await this.client.groupParticipantsUpdate(
        update.groupJid,
        participants,
        update.action,
      );
      return { updateParticipants: updateParticipants };
    } catch (error) {
      throw new BadRequestException('Error updating participants', error.toString());
    }
  }

  public async updateGSetting(update: GroupUpdateSettingDto) {
    try {
      const updateSetting = await this.client.groupSettingUpdate(update.groupJid, update.action);
      return { updateSetting: updateSetting };
    } catch (error) {
      throw new BadRequestException('Error updating setting', error.toString());
    }
  }

  public async toggleEphemeral(update: GroupToggleEphemeralDto) {
    try {
      await this.client.groupToggleEphemeral(update.groupJid, update.expiration);
      return { success: true };
    } catch (error) {
      throw new BadRequestException('Error updating setting', error.toString());
    }
  }

  public async leaveGroup(id: GroupJid) {
    try {
      await this.client.groupLeave(id.groupJid);
      return { groupJid: id.groupJid, leave: true };
    } catch (error) {
      throw new BadRequestException('Unable to leave the group', error.toString());
    }
  }
  public async templateMessage() {
    throw new Error('Method not available in the Baileys service');
  }

  private prepareMessage(message: proto.IWebMessageInfo): any {
    const contentType = getContentType(message.message);
    const contentMsg = message?.message[contentType] as any;

    const messageRaw = {
      key: message.key,
      pushName: message.pushName,
      status: status[message.status],
      message: { ...message.message },
      contextInfo: contentMsg?.contextInfo,
      messageType: contentType || 'unknown',
      messageTimestamp: message.messageTimestamp as number,
      instanceId: this.instanceId,
      source: getDevice(message.key.id),
    };

    if (!messageRaw.status && message.key.fromMe === false) {
      messageRaw.status = status[3]; // DELIVERED MESSAGE
    }

    if (messageRaw.message.extendedTextMessage) {
      messageRaw.messageType = 'conversation';
      messageRaw.message.conversation = messageRaw.message.extendedTextMessage.text;
      delete messageRaw.message.extendedTextMessage;
    }

    if (messageRaw.message.documentWithCaptionMessage) {
      messageRaw.messageType = 'documentMessage';
      messageRaw.message.documentMessage = messageRaw.message.documentWithCaptionMessage.message.documentMessage;
      delete messageRaw.message.documentWithCaptionMessage;
    }

    return messageRaw;
  }

  private async syncChatwootLostMessages() {
    if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
      const chatwootConfig = await this.findChatwoot();
      const prepare = (message: any) => this.prepareMessage(message);
      this.chatwootService.syncLostMessages({ instanceName: this.instance.name }, chatwootConfig, prepare);

      const task = cron.schedule('0,30 * * * *', async () => {
        this.chatwootService.syncLostMessages({ instanceName: this.instance.name }, chatwootConfig, prepare);
      });
      task.start();
    }
  }

  private async updateMessagesReadedByTimestamp(remoteJid: string, timestamp?: number): Promise<number> {
    if (timestamp === undefined || timestamp === null) return 0;

    const result = await this.prismaRepository.message.updateMany({
      where: {
        AND: [
          { key: { path: ['remoteJid'], equals: remoteJid } },
          { key: { path: ['fromMe'], equals: false } },
          { messageTimestamp: { lte: timestamp } },
          {
            OR: [{ status: null }, { status: status[3] }],
          },
        ],
      },
      data: { status: status[4] },
    });

    if (result) {
      if (result.count > 0) {
        this.updateChatUnreadMessages(remoteJid);
      }

      return result.count;
    }

    return 0;
  }

  private async updateChatUnreadMessages(remoteJid: string): Promise<number> {
    const [chat, unreadMessages] = await Promise.all([
      this.prismaRepository.chat.findFirst({ where: { remoteJid } }),
      this.prismaRepository.message.count({
        where: {
          AND: [
            { key: { path: ['remoteJid'], equals: remoteJid } },
            { key: { path: ['fromMe'], equals: false } },
            { status: { equals: status[3] } },
          ],
        },
      }),
    ]);

    if (chat && chat.unreadMessages !== unreadMessages) {
      await this.prismaRepository.chat.update({
        where: { id: chat.id },
        data: { unreadMessages },
      });
    }

    return unreadMessages;
  }
}
