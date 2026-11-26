import { InstanceDto } from '@api/dto/instance.dto';
import { ChatwootDto } from '@api/integrations/chatbot/chatwoot/dto/chatwoot.dto';
import { postgresClient } from '@api/integrations/chatbot/chatwoot/libs/postgres.client';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';
import { Chatwoot, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { inbox } from '@figuro/chatwoot-sdk';
import { Chatwoot as ChatwootModel, Contact, Message } from '@prisma/client';
import { proto } from 'baileys';

type ChatwootUser = {
  user_type: string;
  user_id: number;
};

type FksChatwoot = {
  conversation_key: string;
  contact_id: string;
  conversation_id: string;
};

type firstLastTimestamp = {
  first: number;
  last: number;
};

type IWebMessageInfo = Omit<proto.IWebMessageInfo, 'key'> & Partial<Pick<proto.IWebMessageInfo, 'key'>>;

type ChatwootConversationSeed = {
  conversation_key: string;
  identifier: string;
  phone_number: string | null;
  name: string;
  created_at: number;
  last_activity_at: number;
};

class ChatwootImport {
  private logger = new Logger('ChatwootImport');
  private repositoryMessagesCache = new Map<string, Set<string>>();
  private historyMessages = new Map<string, Message[]>();
  private historyContacts = new Map<string, Contact[]>();

  public getRepositoryMessagesCache(instance: InstanceDto) {
    return this.repositoryMessagesCache.has(instance.instanceName)
      ? this.repositoryMessagesCache.get(instance.instanceName)
      : null;
  }

  public setRepositoryMessagesCache(instance: InstanceDto, repositoryMessagesCache: Set<string>) {
    this.repositoryMessagesCache.set(instance.instanceName, repositoryMessagesCache);
  }

  public deleteRepositoryMessagesCache(instance: InstanceDto) {
    this.repositoryMessagesCache.delete(instance.instanceName);
  }

  public addHistoryMessages(instance: InstanceDto, messagesRaw: Message[]) {
    const actualValue = this.historyMessages.has(instance.instanceName)
      ? this.historyMessages.get(instance.instanceName)
      : [];
    this.historyMessages.set(instance.instanceName, [...actualValue, ...messagesRaw]);
  }

  public addHistoryContacts(instance: InstanceDto, contactsRaw: Contact[]) {
    const actualValue = this.historyContacts.has(instance.instanceName)
      ? this.historyContacts.get(instance.instanceName)
      : [];
    this.historyContacts.set(instance.instanceName, actualValue.concat(contactsRaw));
  }

  public deleteHistoryMessages(instance: InstanceDto) {
    this.historyMessages.delete(instance.instanceName);
  }

  public deleteHistoryContacts(instance: InstanceDto) {
    this.historyContacts.delete(instance.instanceName);
  }

  public clearAll(instance: InstanceDto) {
    this.deleteRepositoryMessagesCache(instance);
    this.deleteHistoryMessages(instance);
    this.deleteHistoryContacts(instance);
  }

  public getHistoryMessagesLenght(instance: InstanceDto) {
    return this.historyMessages.get(instance.instanceName)?.length ?? 0;
  }

  public async importHistoryContacts(instance: InstanceDto, provider: ChatwootDto) {
    try {
      if (this.getHistoryMessagesLenght(instance) > 0) {
        return;
      }

      const pgClient = postgresClient.getChatwootConnection();

      let totalContactsImported = 0;

      const contacts = this.historyContacts.get(instance.instanceName) || [];
      if (contacts.length === 0) {
        return 0;
      }

      let contactsChunk: Contact[] = this.sliceIntoChunks(contacts, 3000);
      while (contactsChunk.length > 0) {
        const labelSql = `SELECT id FROM labels WHERE title = '${provider.nameInbox}' AND account_id = ${provider.accountId} LIMIT 1`;

        let labelId = (await pgClient.query(labelSql))?.rows[0]?.id;

        if (!labelId) {
          // creating label in chatwoot db and getting the id
          const sqlLabel = `INSERT INTO labels (title, color, show_on_sidebar, account_id, created_at, updated_at) VALUES ('${provider.nameInbox}', '#34039B', true, ${provider.accountId}, NOW(), NOW()) RETURNING id`;

          labelId = (await pgClient.query(sqlLabel))?.rows[0]?.id;
        }

        // inserting contacts in chatwoot db
        let sqlInsert = `INSERT INTO contacts
          (name, phone_number, account_id, identifier, created_at, updated_at) VALUES `;
        const bindInsert = [provider.accountId];

        for (const contact of contactsChunk) {
          const isGroup = this.isGroup(contact.remoteJid);

          const contactName = this.getContactName(contact);
          bindInsert.push(contactName);
          const bindName = `$${bindInsert.length}`;

          let bindPhoneNumber: string;
          if (!isGroup) {
            bindInsert.push(`+${contact.remoteJid.split('@')[0]}`);
            bindPhoneNumber = `$${bindInsert.length}`;
          } else {
            bindPhoneNumber = 'NULL';
          }
          bindInsert.push(contact.remoteJid);
          const bindIdentifier = `$${bindInsert.length}`;

          sqlInsert += `(${bindName}, ${bindPhoneNumber}, $1, ${bindIdentifier}, NOW(), NOW()),`;
        }
        if (sqlInsert.slice(-1) === ',') {
          sqlInsert = sqlInsert.slice(0, -1);
        }
        sqlInsert += ` ON CONFLICT (identifier, account_id)
                       DO UPDATE SET
                        name = CASE
                          WHEN contacts.identifier LIKE '%@g.us'
                            AND (
                              EXCLUDED.name IS NULL
                              OR UPPER(TRIM(EXCLUDED.name)) = 'GROUP'
                              OR TRIM(EXCLUDED.name) = SPLIT_PART(contacts.identifier, '@', 1)
                              OR TRIM(EXCLUDED.name) = SPLIT_PART(contacts.identifier, '@', 1) || ' (GROUP)'
                            )
                          THEN contacts.name
                          ELSE EXCLUDED.name
                        END,
                        phone_number = EXCLUDED.phone_number,
                        updated_at = NOW()`;

        totalContactsImported += (await pgClient.query(sqlInsert, bindInsert))?.rowCount ?? 0;

        const sqlTags = `SELECT id FROM tags WHERE name = '${provider.nameInbox}' LIMIT 1`;

        const tagData = (await pgClient.query(sqlTags))?.rows[0];
        let tagId = tagData?.id;

        const sqlTag = `INSERT INTO tags (name, taggings_count) VALUES ('${provider.nameInbox}', ${totalContactsImported}) ON CONFLICT (name) DO UPDATE SET taggings_count = tags.taggings_count + ${totalContactsImported} RETURNING id`;

        tagId = (await pgClient.query(sqlTag))?.rows[0]?.id;

        await pgClient.query(sqlTag);

        let sqlInsertLabel = `INSERT INTO taggings (tag_id, taggable_type, taggable_id, context, created_at) VALUES `;

        contactsChunk.forEach((contact) => {
          const bindTaggableId = `(SELECT id FROM contacts WHERE identifier = '${contact.remoteJid}' AND account_id = ${provider.accountId})`;
          sqlInsertLabel += `($1, $2, ${bindTaggableId}, $3, NOW()),`;
        });

        if (sqlInsertLabel.slice(-1) === ',') {
          sqlInsertLabel = sqlInsertLabel.slice(0, -1);
        }

        await pgClient.query(sqlInsertLabel, [tagId, 'Contact', 'labels']);

        contactsChunk = this.sliceIntoChunks(contacts, 3000);
      }

      this.deleteHistoryContacts(instance);

      return totalContactsImported;
    } catch (error) {
      this.logger.error(`Error on import history contacts: ${error.toString()}`);
    }
  }

  public async getExistingSourceIds(
    sourceIds: string[],
    filters?: { conversationId?: number | string; accountId?: number | string; inboxId?: number | string },
  ): Promise<Set<string>> {
    try {
      const existingSourceIdsSet = new Set<string>();

      if (sourceIds.length === 0) {
        return existingSourceIdsSet;
      }

      // Ensure all sourceIds are consistently prefixed with 'WAID:' as required by downstream systems and database queries.
      const formattedSourceIds = sourceIds.map((sourceId) => `WAID:${sourceId.replace('WAID:', '')}`);
      const pgClient = postgresClient.getChatwootConnection();

      const params: (string[] | number | string)[] = [formattedSourceIds];
      const where = ['source_id = ANY($1)'];

      if (filters?.conversationId) {
        params.push(filters.conversationId);
        where.push(`conversation_id = $${params.length}`);
      }

      if (filters?.accountId) {
        params.push(filters.accountId);
        where.push(`account_id = $${params.length}`);
      }

      if (filters?.inboxId) {
        params.push(filters.inboxId);
        where.push(`inbox_id = $${params.length}`);
      }

      const query = `SELECT source_id FROM messages WHERE ${where.join(' AND ')}`;

      const result = await pgClient.query(query, params);
      for (const row of result.rows) {
        existingSourceIdsSet.add(row.source_id);
        existingSourceIdsSet.add(row.source_id.replace('WAID:', ''));
      }

      return existingSourceIdsSet;
    } catch (error) {
      this.logger.error(`Error on getExistingSourceIds: ${error.toString()}`);
      return new Set<string>();
    }
  }

  public async importHistoryMessages(
    instance: InstanceDto,
    chatwootService: ChatwootService,
    inbox: inbox,
    provider: ChatwootModel,
  ) {
    try {
      const pgClient = postgresClient.getChatwootConnection();

      const chatwootUser = await this.getChatwootUser(provider);
      if (!chatwootUser) {
        throw new Error('User not found to import messages.');
      }

      let totalMessagesImported = 0;

      let messagesOrdered = this.historyMessages.get(instance.instanceName) || [];
      if (messagesOrdered.length === 0) {
        return 0;
      }

      // ordering messages by number and timestamp asc
      messagesOrdered.sort((a, b) => {
        const aKey = a.key as {
          remoteJid: string;
        };

        const bKey = b.key as {
          remoteJid: string;
        };

        const aMessageTimestamp = a.messageTimestamp as any as number;
        const bMessageTimestamp = b.messageTimestamp as any as number;

        return aKey.remoteJid.localeCompare(bKey.remoteJid) || aMessageTimestamp - bMessageTimestamp;
      });

      const allMessagesMappedByConversation = this.createMessagesMapByConversation(messagesOrdered);
      // Map structure: +552199999999 or 120363...@g.us => { first message timestamp, last message timestamp}
      const conversationsWithTimestamp = new Map<string, firstLastTimestamp>();
      allMessagesMappedByConversation.forEach((messages: Message[], conversationKey: string) => {
        conversationsWithTimestamp.set(conversationKey, {
          first: messages[0]?.messageTimestamp as any as number,
          last: messages[messages.length - 1]?.messageTimestamp as any as number,
        });
      });

      const existingSourceIds = await this.getExistingSourceIds(
        messagesOrdered.map((message: any) => message.key.id),
        { accountId: provider.accountId, inboxId: inbox.id },
      );
      messagesOrdered = messagesOrdered.filter((message: any) => !existingSourceIds.has(message.key.id));
      // processing messages in batch
      const batchSize = 4000;
      let messagesChunk: Message[] = this.sliceIntoChunks(messagesOrdered, batchSize);
      while (messagesChunk.length > 0) {
        // Map structure: +552199999999 or 120363...@g.us => Message[]
        const messagesByConversation = this.createMessagesMapByConversation(messagesChunk);

        if (messagesByConversation.size > 0) {
          const fksByNumber = await this.selectOrCreateFksFromChatwoot(
            provider,
            inbox,
            conversationsWithTimestamp,
            messagesByConversation,
            this.createContactNameMap(instance),
          );

          // inserting messages in chatwoot db
          let sqlInsertMsg = `INSERT INTO messages
            (content, processed_message_content, account_id, inbox_id, conversation_id, message_type, private, content_type,
            sender_type, sender_id, source_id, created_at, updated_at) VALUES `;
          const bindInsertMsg: (string | number)[] = [provider.accountId, inbox.id];

          messagesByConversation.forEach((messages: any[], conversationKey: string) => {
            const fksChatwoot = fksByNumber.get(conversationKey);

            messages.forEach((message) => {
              if (!message.message) {
                return;
              }

              if (!fksChatwoot?.conversation_id || !fksChatwoot?.contact_id) {
                return;
              }

              const contentMessage = this.getContentMessage(chatwootService, message);
              if (!contentMessage) {
                return;
              }

              bindInsertMsg.push(contentMessage);
              const bindContent = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(fksChatwoot.conversation_id);
              const bindConversationId = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(message.key.fromMe ? 1 : 0);
              const bindMessageType = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(message.key.fromMe ? chatwootUser.user_type : 'Contact');
              const bindSenderType = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(message.key.fromMe ? chatwootUser.user_id : fksChatwoot.contact_id);
              const bindSenderId = `$${bindInsertMsg.length}`;

              bindInsertMsg.push('WAID:' + message.key.id);
              const bindSourceId = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(message.messageTimestamp as number);
              const bindmessageTimestamp = `$${bindInsertMsg.length}`;

              sqlInsertMsg += `(${bindContent}, ${bindContent}, $1, $2, ${bindConversationId}, ${bindMessageType}, FALSE, 0,
                  ${bindSenderType},${bindSenderId},${bindSourceId}, to_timestamp(${bindmessageTimestamp}), to_timestamp(${bindmessageTimestamp})),`;
            });
          });
          if (bindInsertMsg.length > 2) {
            if (sqlInsertMsg.slice(-1) === ',') {
              sqlInsertMsg = sqlInsertMsg.slice(0, -1);
            }
            sqlInsertMsg += ' ON CONFLICT DO NOTHING';
            totalMessagesImported += (await pgClient.query(sqlInsertMsg, bindInsertMsg))?.rowCount ?? 0;
          }
        }
        messagesChunk = this.sliceIntoChunks(messagesOrdered, batchSize);
      }

      this.deleteHistoryMessages(instance);
      this.deleteRepositoryMessagesCache(instance);

      const providerData: ChatwootDto = {
        ...provider,
        ignoreJids: Array.isArray(provider.ignoreJids) ? provider.ignoreJids.map((event) => String(event)) : [],
      };

      await this.importHistoryContacts(instance, providerData);

      return totalMessagesImported;
    } catch (error) {
      this.logger.error(`Error on import history messages: ${error.toString()}`);

      this.deleteHistoryMessages(instance);
      this.deleteRepositoryMessagesCache(instance);
    }
  }

  public async selectOrCreateFksFromChatwoot(
    provider: ChatwootModel,
    inbox: inbox,
    conversationsWithTimestamp: Map<string, firstLastTimestamp>,
    messagesByConversation: Map<string, Message[]>,
    contactNamesByIdentifier = new Map<string, string>(),
  ): Promise<Map<string, FksChatwoot>> {
    const pgClient = postgresClient.getChatwootConnection();

    const bindValues = [provider.accountId, inbox.id];
    const conversationSeeds = Array.from(messagesByConversation.entries())
      .map(([conversationKey, messages]) => {
        const conversationTimestamp = conversationsWithTimestamp.get(conversationKey);

        if (!conversationTimestamp) {
          return null;
        }

        const seed = this.createConversationSeed(
          conversationKey,
          messages,
          conversationTimestamp,
          contactNamesByIdentifier,
        );

        bindValues.push(seed.conversation_key);
        let bindStr = `($${bindValues.length},`;

        bindValues.push(seed.identifier);
        bindStr += `$${bindValues.length},`;

        bindValues.push(seed.phone_number);
        bindStr += `$${bindValues.length},`;

        bindValues.push(seed.name);
        bindStr += `$${bindValues.length},`;

        bindValues.push(seed.created_at);
        bindStr += `$${bindValues.length},`;

        bindValues.push(seed.last_activity_at);
        return `${bindStr}$${bindValues.length})`;
      })
      .filter(Boolean)
      .join(',');

    if (!conversationSeeds) {
      return new Map();
    }

    // select (or insert when necessary) data from tables contacts, contact_inboxes, conversations from chatwoot db
    const sqlFromChatwoot = `WITH
              conversation_seed AS (
                SELECT
                  t.conversation_key,
                  t.identifier,
                  t.phone_number,
                  t.name,
                  t.created_at::INTEGER,
                  t.last_activity_at::INTEGER
                FROM (
                  VALUES 
                   ${conversationSeeds}
                 ) as t (conversation_key, identifier, phone_number, name, created_at, last_activity_at)
              ),

              upserted_contact AS (
                INSERT INTO contacts AS contact (name, phone_number, account_id, identifier, created_at, updated_at)
                SELECT
                  conversation_seed.name,
                  conversation_seed.phone_number,
                  $1,
                  conversation_seed.identifier,
                  to_timestamp(conversation_seed.created_at),
                  to_timestamp(conversation_seed.last_activity_at)
                FROM conversation_seed
                ON CONFLICT(identifier, account_id) DO UPDATE SET
                  name = CASE
                    WHEN contact.identifier LIKE '%@g.us'
                      AND (
                        EXCLUDED.name IS NULL
                        OR UPPER(TRIM(EXCLUDED.name)) = 'GROUP'
                        OR TRIM(EXCLUDED.name) = SPLIT_PART(contact.identifier, '@', 1)
                        OR TRIM(EXCLUDED.name) = SPLIT_PART(contact.identifier, '@', 1) || ' (GROUP)'
                      )
                    THEN contact.name
                    ELSE EXCLUDED.name
                  END,
                  phone_number = EXCLUDED.phone_number,
                  updated_at = EXCLUDED.updated_at
                RETURNING contact.id, contact.identifier, contact.created_at, contact.updated_at
              ),

              selected_contact AS (
                SELECT
                  conversation_seed.conversation_key,
                  conversation_seed.created_at,
                  conversation_seed.last_activity_at,
                  upserted_contact.id AS contact_id
                FROM conversation_seed
                JOIN upserted_contact ON upserted_contact.identifier = conversation_seed.identifier
              ),

              new_contact_inbox AS (
                INSERT INTO contact_inboxes (contact_id, inbox_id, source_id, created_at, updated_at)
                SELECT
                  selected_contact.contact_id,
                  $2,
                  gen_random_uuid(),
                  to_timestamp(selected_contact.created_at),
                  to_timestamp(selected_contact.last_activity_at)
                FROM selected_contact
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM contact_inboxes existing_ci
                  WHERE existing_ci.contact_id = selected_contact.contact_id
                    AND existing_ci.inbox_id = $2
                )
                RETURNING id, contact_id, created_at, updated_at
              ),

              existing_contact_inbox AS (
                SELECT
                  selected_contact.conversation_key,
                  selected_contact.contact_id,
                  selected_contact.created_at,
                  selected_contact.last_activity_at,
                  contact_inboxes.id AS contact_inbox_id,
                  contact_inboxes.created_at AS contact_inbox_created_at,
                  contact_inboxes.updated_at AS contact_inbox_updated_at
                FROM selected_contact
                JOIN contact_inboxes ON contact_inboxes.contact_id = selected_contact.contact_id
                  AND contact_inboxes.inbox_id = $2
              ),

              selected_contact_inbox AS (
                SELECT
                  existing_contact_inbox.conversation_key,
                  existing_contact_inbox.contact_id,
                  existing_contact_inbox.created_at,
                  existing_contact_inbox.last_activity_at,
                  existing_contact_inbox.contact_inbox_id
                FROM existing_contact_inbox

                UNION ALL

                SELECT
                  selected_contact.conversation_key,
                  selected_contact.contact_id,
                  selected_contact.created_at,
                  selected_contact.last_activity_at,
                  new_contact_inbox.id AS contact_inbox_id
                FROM selected_contact
                JOIN new_contact_inbox ON new_contact_inbox.contact_id = selected_contact.contact_id
              ),

              new_conversation AS (
                INSERT INTO conversations (account_id, inbox_id, status, contact_id,
                  contact_inbox_id, uuid, last_activity_at, created_at, updated_at)
                SELECT
                  $1,
                  $2,
                  0,
                  selected_contact_inbox.contact_id,
                  selected_contact_inbox.contact_inbox_id,
                  gen_random_uuid(),
                  to_timestamp(selected_contact_inbox.last_activity_at),
                  to_timestamp(selected_contact_inbox.created_at),
                  to_timestamp(selected_contact_inbox.last_activity_at)
                FROM selected_contact_inbox
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM conversations existing_conversation
                  WHERE existing_conversation.contact_inbox_id = selected_contact_inbox.contact_inbox_id
                    AND existing_conversation.account_id = $1
                    AND existing_conversation.inbox_id = $2
                    AND existing_conversation.contact_id = selected_contact_inbox.contact_id
                )
                RETURNING id, contact_id, contact_inbox_id
              ),

              selected_conversation AS (
                SELECT
                  selected_contact_inbox.conversation_key,
                  selected_contact_inbox.contact_id,
                  conversations.id AS conversation_id
                FROM selected_contact_inbox
                JOIN conversations ON conversations.contact_inbox_id = selected_contact_inbox.contact_inbox_id
                  AND conversations.account_id = $1
                  AND conversations.inbox_id = $2
                  AND conversations.contact_id = selected_contact_inbox.contact_id

                UNION ALL

                SELECT
                  selected_contact_inbox.conversation_key,
                  selected_contact_inbox.contact_id,
                  new_conversation.id AS conversation_id
                FROM selected_contact_inbox
                JOIN new_conversation ON new_conversation.contact_inbox_id = selected_contact_inbox.contact_inbox_id
              )

              SELECT
                selected_conversation.conversation_key,
                selected_conversation.contact_id,
                selected_conversation.conversation_id
              FROM selected_conversation`;

    const fksFromChatwoot = await pgClient.query(sqlFromChatwoot, bindValues);

    return new Map(fksFromChatwoot.rows.map((item: FksChatwoot) => [item.conversation_key, item]));
  }

  public async getChatwootUser(provider: ChatwootModel): Promise<ChatwootUser> {
    try {
      const pgClient = postgresClient.getChatwootConnection();

      const sqlUser = `SELECT owner_type AS user_type, owner_id AS user_id
                         FROM access_tokens
                       WHERE token = $1`;

      return (await pgClient.query(sqlUser, [provider.token]))?.rows[0] || false;
    } catch (error) {
      this.logger.error(`Error on getChatwootUser: ${error.toString()}`);
    }
  }

  public createMessagesMapByConversation(messages: Message[]): Map<string, Message[]> {
    return messages.reduce((acc: Map<string, Message[]>, message: Message) => {
      const key = message?.key as {
        remoteJid: string;
      };
      if (!this.isIgnoredRemoteJid(key?.remoteJid)) {
        const conversationKey = this.getConversationKey(key?.remoteJid);
        if (conversationKey) {
          const messages = acc.has(conversationKey) ? acc.get(conversationKey) : [];
          messages.push(message);
          acc.set(conversationKey, messages);
        }
      }

      return acc;
    }, new Map());
  }

  private createContactNameMap(instance: InstanceDto) {
    const contacts = this.historyContacts.get(instance.instanceName) || [];

    return contacts.reduce((acc, contact) => {
      acc.set(contact.remoteJid, this.getContactName(contact));

      return acc;
    }, new Map<string, string>());
  }

  private createConversationSeed(
    conversationKey: string,
    messages: Message[],
    conversationTimestamp: firstLastTimestamp,
    contactNamesByIdentifier: Map<string, string>,
  ): ChatwootConversationSeed {
    const firstMessage = messages[0] as Message & { key?: { remoteJid?: string } };
    const remoteJid = firstMessage?.key?.remoteJid || conversationKey;
    const isGroup = this.isGroup(remoteJid);
    const identifier = isGroup ? remoteJid : `${conversationKey.replace('+', '')}@s.whatsapp.net`;
    const phoneNumber = isGroup ? null : conversationKey;
    const name = isGroup
      ? this.getGroupName(remoteJid, contactNamesByIdentifier.get(remoteJid))
      : contactNamesByIdentifier.get(remoteJid) || conversationKey.replace('+', '');

    return {
      conversation_key: conversationKey,
      identifier,
      phone_number: phoneNumber,
      name,
      created_at: conversationTimestamp.first,
      last_activity_at: conversationTimestamp.last,
    };
  }

  private getConversationKey(remoteJid?: string) {
    if (!remoteJid) {
      return null;
    }

    if (this.isGroup(remoteJid)) {
      return remoteJid;
    }

    const phoneNumber = remoteJid.split('@')[0]?.split(':')[0];

    return phoneNumber ? `+${phoneNumber}` : null;
  }

  private getContactName(contact: Contact) {
    if (this.isGroup(contact.remoteJid)) {
      return this.getGroupName(contact.remoteJid, contact.pushName);
    }

    return contact.pushName || contact.remoteJid.split('@')[0];
  }

  private getGroupName(remoteJid: string, name?: string | null) {
    const cleanName = name?.trim();

    if (cleanName && cleanName.toUpperCase() !== 'GROUP') {
      return cleanName.endsWith('(GROUP)') ? cleanName : `${cleanName} (GROUP)`;
    }

    return `${remoteJid.split('@')[0]} (GROUP)`;
  }

  public async getContactsOrderByRecentConversations(
    inbox: inbox,
    provider: ChatwootModel,
    limit = 50,
  ): Promise<{ id: number; phone_number: string; identifier: string }[]> {
    try {
      const pgClient = postgresClient.getChatwootConnection();

      const sql = `SELECT contacts.id, contacts.identifier, contacts.phone_number
                     FROM conversations
                   JOIN contacts ON contacts.id = conversations.contact_id
                   WHERE conversations.account_id = $1
                     AND inbox_id = $2
                   ORDER BY conversations.last_activity_at DESC
                   LIMIT $3`;

      return (await pgClient.query(sql, [provider.accountId, inbox.id, limit]))?.rows;
    } catch (error) {
      this.logger.error(`Error on get recent conversations: ${error.toString()}`);
    }
  }

  public getContentMessage(chatwootService: ChatwootService, msg: IWebMessageInfo) {
    const contentMessage = chatwootService.getConversationMessage(msg.message);
    if (contentMessage) {
      return contentMessage;
    }

    if (!configService.get<Chatwoot>('CHATWOOT').IMPORT.PLACEHOLDER_MEDIA_MESSAGE) {
      return '';
    }

    const types = {
      documentMessage: msg.message.documentMessage,
      documentWithCaptionMessage: msg.message.documentWithCaptionMessage?.message?.documentMessage,
      imageMessage: msg.message.imageMessage,
      videoMessage: msg.message.videoMessage,
      audioMessage: msg.message.audioMessage,
      stickerMessage: msg.message.stickerMessage,
      templateMessage: msg.message.templateMessage?.hydratedTemplate?.hydratedContentText,
    };

    const typeKey = Object.keys(types).find((key) => types[key] !== undefined && types[key] !== null);
    switch (typeKey) {
      case 'documentMessage': {
        const doc = msg.message.documentMessage;
        const fileName = doc?.fileName || 'document';
        const caption = doc?.caption ? ` ${doc.caption}` : '';
        return `_<File: ${fileName}${caption}>_`;
      }

      case 'documentWithCaptionMessage': {
        const doc = msg.message.documentWithCaptionMessage?.message?.documentMessage;
        const fileName = doc?.fileName || 'document';
        const caption = doc?.caption ? ` ${doc.caption}` : '';
        return `_<File: ${fileName}${caption}>_`;
      }

      case 'templateMessage': {
        const template = msg.message.templateMessage?.hydratedTemplate;
        return (
          (template?.hydratedTitleText ? `*${template.hydratedTitleText}*\n` : '') +
          (template?.hydratedContentText || '')
        );
      }

      case 'imageMessage':
        return '_<Image Message>_';

      case 'videoMessage':
        return '_<Video Message>_';

      case 'audioMessage':
        return '_<Audio Message>_';

      case 'stickerMessage':
        return '_<Sticker Message>_';

      default:
        return '';
    }
  }

  public sliceIntoChunks(arr: any[], chunkSize: number) {
    return arr.splice(0, chunkSize);
  }

  public isGroup(remoteJid: string) {
    return remoteJid?.includes('@g.us');
  }

  public isIgnoredRemoteJid(remoteJid: string) {
    return !remoteJid || remoteJid === 'status@broadcast' || remoteJid === '0@s.whatsapp.net';
  }

  public isIgnorePhoneNumber(remoteJid: string) {
    return this.isGroup(remoteJid) || remoteJid === 'status@broadcast' || remoteJid === '0@s.whatsapp.net';
  }

  public updateMessageSourceID(messageId: string | number, sourceId: string) {
    const pgClient = postgresClient.getChatwootConnection();

    const sql = `UPDATE messages SET source_id = $1, status = 0, created_at = NOW(), updated_at = NOW() WHERE id = $2;`;

    return pgClient.query(sql, [`WAID:${sourceId}`, messageId]);
  }
}

export const chatwootImport = new ChatwootImport();
