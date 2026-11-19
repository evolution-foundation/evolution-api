# 2.3.7 (2025-12-05)

### Features

* **WhatsApp Business Meta Templates**: Add update and delete endpoints for Meta templates
  - New endpoints to edit and delete WhatsApp Business templates
  - Added DTOs and validation schemas for template management
  - Enhanced template lifecycle management capabilities

* **Events API**: Add isLatest and progress to messages.set event
  - Allows consumers to know when history sync is complete (isLatest=true)
  - Track sync progress percentage through webhooks
  - Added extra field to EmitData type for additional payload properties
  - Updated all event controllers (webhook, rabbitmq, sqs, websocket, pusher, kafka, nats)

* **N8N Integration**: Add quotedMessage to payload in sendMessageToBot
  - Support for quoted messages in N8N chatbot integration
  - Enhanced message context information

* **WebSocket**: Add wildcard "*" to allow all hosts to connect via websocket
  - More flexible host configuration for WebSocket connections
  - Improved host validation logic in WebsocketController

* **Pix Support**: Handle interactive button message for pix
  - Support for interactive Pix button messages
  - Enhanced payment flow integration

### Fixed

* **Baileys Message Processor**: Fix incoming message events not working after reconnection
  - Added cleanup logic in mount() to prevent memory leaks from multiple subscriptions
  - Recreate messageSubject if it was completed during logout
  - Remount messageProcessor in connectToWhatsapp() to ensure subscription is active
  - Fixed issue where onDestroy() calls complete() on RxJS Subject, making it permanently closed
  - Ensures old subscriptions are properly cleaned up before creating new ones

* **Baileys Authentication**: Resolve "waiting for message" state after reconnection
  - Fixed Redis keys not being properly removed during instance logout
  - Prevented loading of old/invalid cryptographic keys on reconnection
  - Fixed blocking state where instances authenticate but cannot send messages
  - Ensures new credentials (creds) are properly used after reconnection

* **OnWhatsapp Cache**: Prevent unique constraint errors and optimize database writes
  - Fixed `Unique constraint failed on the fields: (remoteJid)` error when sending to groups
  - Refactored query to use OR condition finding by jidOptions or remoteJid
  - Added deep comparison to skip unnecessary database updates
  - Replaced sequential processing with Promise.allSettled for parallel execution
  - Sorted JIDs alphabetically in jidOptions for accurate change detection
  - Added normalizeJid helper function for cleaner code

* **Proxy Integration**: Fix "Media upload failed on all hosts" error when using proxy
  - Created makeProxyAgentUndici() for Undici-compatible proxy agents
  - Fixed compatibility with Node.js 18+ native fetch() implementation
  - Replaced traditional HttpsProxyAgent/SocksProxyAgent with Undici ProxyAgent
  - Maintained legacy makeProxyAgent() for Axios compatibility
  - Fixed protocol handling in makeProxyAgent to prevent undefined errors

* **WhatsApp Business API**: Fix base64, filename and caption handling
  - Corrected base64 media conversion in Business API
  - Fixed filename handling for document messages
  - Improved caption processing for media messages
  - Enhanced remoteJid validation and processing

* **Chat Service**: Fix fetchChats and message panel errors
  - Fixed cleanMessageData errors in Manager message panel
  - Improved chat fetching reliability
  - Enhanced message data sanitization

* **Contact Filtering**: Apply where filters correctly in findContacts endpoint
  - Fixed endpoint to process all where clause fields (id, remoteJid, pushName)
  - Previously only processed remoteJid field, ignoring other filters
  - Added remoteJid field to contactValidateSchema for proper validation
  - Maintained multi-tenant isolation with instanceId filtering
  - Allows filtering contacts by any supported field instead of returning all contacts

* **Chatwoot and Baileys Integration**: Multiple integration improvements
  - Enhanced code formatting and consistency
  - Fixed integration issues between Chatwoot and Baileys services
  - Improved message handling and delivery

* **Baileys Message Loss**: Prevent message loss from WhatsApp stub placeholders
  - Fixed messages being lost and not saved to database, especially for channels/newsletters (@lid)
  - Detects WhatsApp stubs through messageStubParameters containing 'Message absent from node'
  - Prevents adding stubs to duplicate message cache
  - Allows real message to be processed when it arrives after decryption
  - Maintains stub discard to avoid saving empty placeholders

* **Database Contacts**: Respect DATABASE_SAVE_DATA_CONTACTS in contact updates
  - Added missing conditional checks for DATABASE_SAVE_DATA_CONTACTS configuration
  - Fixed profile picture updates attempting to save when database save is disabled
  - Fixed unawaited promise in contacts.upsert handler

* **Prisma/PostgreSQL**: Add unique constraint to Chat model
  - Generated migration to add unique index on instanceId and remoteJid
  - Added deduplication step before creating index to prevent constraint violations
  - Prevents chat duplication in database

* **MinIO Upload**: Handle messageContextInfo in media upload to prevent MinIO errors
  - Prevents errors when uploading media with messageContextInfo metadata
  - Improved error handling for media storage operations

* **Typebot**: Fix message routing for @lid JIDs
  - Typebot now responds to messages from JIDs ending with @lid
  - Maintains complete JID for @lid instead of extracting only number
  - Fixed condition: `remoteJid.includes('@lid') ? remoteJid : remoteJid.split('@')[0]`
  - Handles both @s.whatsapp.net and @lid message formats

* **Message Filtering**: Unify remoteJid filtering using OR with remoteJidAlt
  - Improved message filtering with alternative JID support
  - Better handling of messages with different JID formats

* **@lid Integration**: Multiple fixes for @lid problems, message events and chatwoot errors
  - Reorganized imports and improved message handling in BaileysStartupService
  - Enhanced remoteJid processing to handle @lid cases
  - Improved jid normalization and type safety in Chatwoot integration
  - Streamlined message handling logic and cache management
  - Refactored message handling and polling updates with decryption logic for poll votes
  - Improved event processing flow for various message types

* **Chatwoot Contacts**: Fix contact duplication error on import
  - Resolved 'ON CONFLICT DO UPDATE command cannot affect row a second time' error
  - Removed attempt to update identifier field in conflict (part of constraint)
  - Changed to update only updated_at field: `updated_at = NOW()`
  - Allows duplicate contacts to be updated correctly without errors

* **Chatwoot Service**: Fix async handling in update_last_seen method
  - Added missing await for chatwootRequest in read message processing
  - Prevents service failure when processing read messages

* **Metrics Access**: Fix IP validation including x-forwarded-for
  - Uses all IPs including x-forwarded-for header when checking metrics access
  - Improved security and access control for metrics endpoint

### Dependencies

* **Baileys**: Updated to version 7.0.0-rc.9
  - Latest release candidate with multiple improvements and bug fixes

* **AWS SDK**: Updated packages to version 3.936.0
  - Enhanced functionality and compatibility
  - Performance improvements

### Code Quality & Refactoring

* **Template Management**: Remove unused template edit/delete DTOs after refactoring
* **Proxy Utilities**: Improve makeProxyAgent for Undici compatibility
* **Code Formatting**: Enhance code formatting and consistency across services
* **BaileysStartupService**: Fix indentation and remove unnecessary blank lines
* **Event Controllers**: Guard extra spread and prevent core field override in all event controllers
* **Import Organization**: Reorganize imports for better code structure and maintainability

# 2.3.6 (2025-10-21)

### Features

* **Baileys, Chatwoot, OnWhatsapp Cache**: Multiple implementations and fixes
  - Fixed cache for PN, LID and g.us numbers to send correct number
  - Fixed audio and document sending via Chatwoot in Baileys channel
  - Multiple fixes in Chatwoot integration
  - Fixed ignored messages when receiving leads

### Fixed

* **Baileys**: Fix buffer storage in database
  - Correctly save Uint8Array values to database
* **Baileys**: Simplify logging of messageSent object
  - Fixed "this.isZero not is function" error

### Chore

* **Version**: Bump version to 2.3.6 and update Baileys dependency to 7.0.0-rc.6
* **Workflows**: Update checkout step to include submodules
  - Added 'submodules: recursive' option to checkout step in multiple workflow files to ensure submodules are properly initialized during CI/CD processes
* **Manager**: Update asset files and install process
  - Updated subproject reference in evolution-manager-v2 to the latest commit
  - Enhanced the manager_install.sh script to include npm install and build steps
  - Replaced old JavaScript asset file with a new version for improved performance
  - Added a new CSS file for consistent styling across the application

# 2.3.5 (2025-10-15)

### Features

* **Chatwoot Enhancements**: Comprehensive improvements to message handling, editing, deletion and i18n
* **Participants Data**: Add participantsData field maintaining backward compatibility for group participants
* **LID to Phone Number**: Convert LID to phoneNumber on group participants
* **Docker Configurations**: Add Kafka and frontend services to Docker configurations

### Fixed

* **Kafka Migration**: Fixed PostgreSQL migration error for Kafka integration
  - Corrected table reference from `"public"."Instance"` to `"Instance"` in foreign key constraint
  - Fixed `ERROR: relation "public.Instance" does not exist` issue in migration `20250918182355_add_kafka_integration`
  - Aligned table naming convention with other Evolution API migrations for consistency
  - Resolved database migration failure that prevented Kafka integration setup
* **Update Baileys Version**: v7.0.0-rc.5 with compatibility fixes
  - Fixed assertSessions signature compatibility using type assertion
  - Fixed incompatibility in voice call (wavoip) with new Baileys version
  - Handle undefined status in update by defaulting to 'DELETED'
* **Chatwoot Improvements**: Multiple fixes for enhanced reliability
  - Correct chatId extraction for non-group JIDs
  - Resolve webhook timeout on deletion with 5+ images
  - Improve error handling in Chatwoot messages
  - Adjust conversation verification logic and cache
  - Optimize conversation reopening logic and connection notification
  - Fix conversation reopening and connection loop
* **Baileys Message Handling**: Enhanced message processing
  - Add warning log for messages not found
  - Fix message verification in Baileys service
  - Simplify linkPreview handling in BaileysStartupService
* **Media Validation**: Fix media content validation
* **PostgreSQL Connection**: Refactor connection with PostgreSQL and improve message handling

### Code Quality & Refactoring

* **Exponential Backoff**: Implement exponential backoff patterns and extract magic numbers to constants
* **TypeScript Build**: Update TypeScript build process and dependencies

### 

# 2.3.4 (2025-09-23)

### Features

* **Kafka Integration**: Added Apache Kafka event integration for real-time event streaming
  - New Kafka controller, router, and schema for event publishing
  - Support for instance-specific and global event topics
  - Configurable SASL/SSL authentication and connection settings
  - Auto-creation of topics with configurable partitions and replication
  - Consumer group management for reliable event processing
  - Integration with existing event manager for seamless event distribution

* **Evolution Manager v2 Open Source**: Evolution Manager v2 is now available as open source
  - Added as git submodule with HTTPS URL for easy access
  - Complete open source setup with Apache 2.0 license + Evolution API custom conditions
  - GitHub templates for issues, pull requests, and workflows
  - Comprehensive documentation and contribution guidelines
  - Docker support for development and production environments
  - CI/CD workflows for code quality, security audits, and automated builds
  - Multi-language support (English, Portuguese, Spanish, French)
  - Modern React + TypeScript + Vite frontend with Tailwind CSS

* **EvolutionBot Enhancements**: Improved EvolutionBot functionality and message handling
  - Implemented splitMessages functionality for better message segmentation
  - Added linkPreview support for enhanced message presentation
  - Centralized split logic across chatbot services for consistency
  - Enhanced message formatting and delivery capabilities

### Fixed

* **MySQL Schema**: Fixed invalid default value errors for `createdAt` fields in `Evoai` and `EvoaiSetting` models
  - Changed `@default(now())` to `@default(dbgenerated("CURRENT_TIMESTAMP"))` for MySQL compatibility
  - Added missing relation fields (`N8n`, `N8nSetting`, `Evoai`, `EvoaiSetting`) in Instance model
  - Resolved Prisma schema validation errors for MySQL provider

* **Prisma Schema Validation**: Fixed `instanceName` field error in message creation
  - Removed invalid `instanceName` field from message objects before database insertion
  - Resolved `Unknown argument 'instanceName'` Prisma validation error
  - Streamlined message data structure to match Prisma schema requirements

* **Media Message Processing**: Enhanced media handling across chatbot services
  - Fixed base64 conversion in EvoAI service for proper image processing
  - Converted ArrayBuffer to base64 string using `Buffer.from().toString('base64')`
  - Improved media URL handling and base64 encoding for better chatbot integration
  - Enhanced image message detection and processing workflow

* **Evolution Manager v2 Linting**: Resolved ESLint configuration conflicts
  - Disabled conflicting Prettier rules in ESLint configuration
  - Added comprehensive rule overrides for TypeScript and React patterns
  - Fixed import ordering and code formatting issues
  - Updated security vulnerabilities in dependencies (Vite, esbuild)

### Code Quality & Refactoring

* **Chatbot Services**: Streamlined media message handling across all chatbot integrations
  - Standardized base64 and mediaUrl processing patterns
  - Improved code readability and maintainability in media handling logic
  - Enhanced error handling for media download and conversion processes
  - Unified image message detection across different chatbot services

* **Database Operations**: Improved data consistency and validation
  - Enhanced Prisma schema compliance across all message operations
  - Removed redundant instance name references for better data integrity
  - Optimized message creation workflow with proper field validation

### Environment Variables

* Added comprehensive Kafka configuration options:
  - `KAFKA_ENABLED`, `KAFKA_CLIENT_ID`, `KAFKA_BROKERS`
  - `KAFKA_CONSUMER_GROUP_ID`, `KAFKA_TOPIC_PREFIX`
  - `KAFKA_SASL_*` and `KAFKA_SSL_*` for authentication
  - `KAFKA_EVENTS_*` for event type configuration

# 2.3.3 (2025-09-18)

### Features

* Add extra fields to object sent to Flowise bot
* Add Prometheus-compatible /metrics endpoint (gated by PROMETHEUS_METRICS)
* Implement linkPreview support for Evolution Bot

### Fixed

* Address Path Traversal vulnerability in /assets endpoint by implementing security checks
* Configure Husky and lint-staged for automated code quality checks on commits and pushes
* Convert mediaKey from media messages to avoid bad decrypt errors
* Improve code formatting for better readability in WhatsApp service files
* Format messageGroupId assignment for improved readability
* Improve linkPreview implementation based on PR feedback
* Clean up code formatting for linkPreview implementation
* Use 'unknown' as fallback for clientName label
* Remove abort process when status is paused, allowing the chatbot return after the time expires and after being paused due to human interaction (stopBotFromMe)
* Enhance message content sanitization in Baileys service and improve message retrieval logic in Chatwoot service
* Integrate Typebot status change events for webhook in chatbot controller and service
* Mimetype of videos video

### Security

* **CRITICAL**: Fixed Path Traversal vulnerability in /assets endpoint that allowed unauthenticated local file read
* Customizable Websockets Security

### Testing

* Baileys Updates: v7.0.0-rc.3 ([Link](https://github.com/WhiskeySockets/Baileys/releases/tag/v7.0.0-rc.3))

# 2.3.2 (2025-09-02)

### Features

* Add support to socks proxy

### Fixed

* Added key id into webhook payload in n8n service
* Enhance RabbitMQ controller with improved connection management and shutdown procedures
* Convert outgoing images to JPEG before sending with Chatwoot
* Update baileys dependency to version 6.7.19

# 2.3.1 (2025-07-29)

### Feature

* Add BaileysMessageProcessor for improved message handling and integrate rxjs for asynchronous processing
* Enhance message processing with retry logic for error handling

### Fixed

* Update Baileys Version
* Update Dockerhub Repository and Delete Config Session Variable
* Fixed sending variables in typebot
* Add unreadMessages in the response
* Phone number as message ID for Evo AI
* Fix upload to s3 when media message
* Simplify edited message check in BaileysStartupService
* Avoid corrupting URLs with query strings
* Removed CONFIG_SESSION_PHONE_VERSION environment variable

# 2.3.0 (2025-06-17 09:19)

### Feature

* Add support to get Catalogs and Collections with new routes: '{{baseUrl}}/chat/fetchCatalogs' and '{{baseUrl}}/chat/fetchCollections'
* Add NATS integration support to the event system
* Add message location support meta
* Add S3_SKIP_POLICY env variable to disable setBucketPolicy for incompatible providers
* Add EvoAI integration with models, services, and routes
* Add N8n integration with models, services, and routes

### Fixed

* Shell injection vulnerability
* Update Baileys Version v6.7.18
* Audio send duplicate from chatwoot
* Chatwoot csat creating new conversation in another language
* Refactor SQS controller to correct bug in sqs events by instance
* Adjustin cloud api send audio and video
* Preserve animation in GIF and WebP stickers
* Preventing use conversation from other inbox for the same user
* Ensure full WhatsApp compatibility for audio conversion (libopus, 48kHz, mono)
* Enhance message fetching and processing logic
* Added lid on whatsapp numbers router
* Now if the CONFIG_SESSION_PHONE_VERSION variable is not filled in it automatically searches for the most updated version

### Security

* Change execSync to execFileSync
* Enhance WebSocket authentication and connection handling

# 2.2.3 (2025-02-03 11:52)

### Fixed

* Fix cache in local file system
* Update Baileys Version

# 2.2.2 (2025-01-31 06:55)

### Features

* Added prefix key to queue name in RabbitMQ

### Fixed

* Update Baileys Version

# 2.2.1 (2025-01-22 14:37)

### Features

* Retry system for send webhooks
* Message filtering to support timestamp range queries
* Chats filtering to support timestamp range queries

### Fixed

* Correction of webhook global
* Fixed send audio with whatsapp cloud api
* Refactor on fetch chats
* Refactor on Evolution Channel

# 2.2.0 (2024-10-18 10:00)

### Features

* Fake Call function
* Send List with Baileys
* Send Buttons with Baileys
* Added unreadMessages to chats
* Pusher event integration
* Add support for splitMessages and timePerChar in Integrations
* Audio Converter via API
* Send PTV messages with Baileys

### Fixed

* Fixed prefilledVariables in startTypebot
* Fix duplicate file upload
* Mark as read from me and groups
* Fetch chats query
* Ads messages in chatwoot
* Add indexes to improve performance in Evolution
* Add logical or permanent message deletion based on env config
* Add support for fetching multiple instances by key
* Update instance.controller.ts to filter by instanceName
* Receive template button reply message

# 2.1.2 (2024-10-06 10:09)

### Features

* Sync lost messages on chatwoot
* Set the maximum number of listeners that can be registered for events
* Now is possible send medias with form-data

### Fixed

* Fetch status message
* Adjusts in migrations
* Update pushName in chatwoot
* Validate message before sending chatwoot
* Adds the message status to the return of the "prepareMessage" function
* Fixed openai setting when send a message with chatwoot
* Fix buildkey function in hSet and hDelete
* Fix mexico number
* Update baileys version
* Update in Baileys version that fixes timeout when updating profile picture
* Adjusts for fix timeout error on send status message
* Chatwoot verbose logs
* Adjusts on prisma connections
* License terms updated
* Fixed send message to group without no cache (local or redis)
* Fixed startTypebot with startSession = true
* Fixed issue of always creating a new label when saving chatwoot
* Fixed getBase64FromMediaMessage with convertToMp4
* Fixed bug when send message when don't have mentionsEveryOne on payload
* Does not search message without chatwoot Message Id for reply
* Fixed bot fallback not working on integrations

# 2.1.1 (2024-09-22 10:31)

### Features

* Define a global proxy to be used if the instance does not have one
* Save is on whatsapp on the database
* Add headers to the instance's webhook registration
* Debounce message break is now "\n" instead of white space
* Single view messages are now supported in chatwoot
* Chatbots can now send any type of media

### Fixed

* Validate if cache exists before accessing it
* Missing autoCreate chatwoot in instance create
* Fixed bugs in the frontend, on the event screens
* Fixed use chatwoot with evolution channel
* Fix chatwoot reply quote with Cloud API
* Use exchange name from .env on RabbitMQ
* Fixed chatwoot screen
* It is now possible to send images via the Evolution Channel
* Removed "version" from docker-compose as it is obsolete (https://dev.to/ajeetraina/do-we-still-use-version-in-compose-3inp)
* Fixed typebot ignoreJids being used only from default settings
* Fixed Chatwoot inbox creation on save
* Changed axios timeout for manager requests for 30s
* Update in Baileys version that fixes timeout when updating profile picture
* Fixed issue when sending links in markdown by chatbots like Dify
* Fixed issue with chatbots not respecting settings

# 2.1.0 (2024-08-26 15:33)

### Features

* Improved layout manager
* Translation in manager: English, Portuguese, Spanish and French
* Evolution Bot Integration
* Option to disable chatwoot bot contact with CHATWOOT_BOT_CONTACT
* Added flowise integration
* Added evolution channel on instance create
* Change in license to Apache-2.0
* Mark All in events

### Fixed

* Refactor integrations structure for modular system
* Fixed dify agent integration
* Update Baileys Version
* Fixed proxy config in manager
* Fixed send messages in groups
* S3 saving media sent from me
* Fixed duplication bot when use startTypebot

### Break Changes

* Payloads for events changed (create Instance and set events). Check postman to understand

# 2.0.10 (2024-08-16 16:23)

### Features

* OpenAI send images when markdown
* Dify send images when markdown
* Sentry implemented

### Fixed

* Fix on get profilePicture
* Added S3_REGION on minio settings

# 2.0.9 (2024-08-15 12:31)

### Features

* Added ignoreJids in chatwoot settings
* Dify now identifies images
* Openai now identifies images

### Fixed

* Path mapping & deps fix & bundler changed to tsup
* Improve database scripts to retrieve the provider from env file
* Update contacts database with unique index
* Save chat name
* Correction of media as attachments in chatwoot when using a Meta API Instance and not Baileys
* Update Baileys version 6.7.6
* Deprecate buttons and list in new Baileys version
* Changed labels to be unique on the same instance
* Remove instance from redis even if using database
* Unified integration session system so they don't overlap
* Temporary fix for pictureUrl bug in groups
* Fix on migrations

# 2.0.9-rc (2024-08-09 18:00)

### Features

* Added general session button in typebot, dify and openai in manager
* Added compatibility with mysql through prisma

### Fixed

* Import contacts with image in chatwoot
* Fix conversationId when is dify agent
* Fixed loading of selects in the manager
* Add restart button to sessions screen
* Adjustments to docker files
* StopBotFromMe working with chatwoot

# 2.0.8-rc (2024-08-08 20:23)

### Features

* Variables passed to the input in dify
* OwnerJid passed to typebot
* Function for openai assistant added

### Fixed

* Adjusts in telemetry

# 2.0.7-rc (2024-08-03 14:04)

### Fixed

* BusinessId added on create instances in manager
* Adjusts in restart instance
* Resolve issue with connecting to instance
* Session is now individual per instance and remoteJid
* Credentials verify on manager login
* Added description column on typebot, dify and openai
* Fixed dify agent integration

# 2.0.6-rc (2024-08-02 19:23)

### Features

* Get models for OpenAI

### Fixed

* fetchInstances with clientName parameter
* fixed update typebot, openai and dify

# 2.0.5-rc (2024-08-01 18:01)

### Features

* Speech to Text with Openai

### Fixed

* ClientName on infos
* Instance screen scroll bar in manager

# 2.0.4-rc (2024-07-30 14:13)

### Features

* New manager v2.0
* Dify integration

### Fixed

* Update Baileys Version
* Adjusts for new manager
* Corrected openai trigger validation
* Corrected typebot trigger validation

# 2.0.3-beta (2024-07-29 09:03)

### Features

* Webhook url by submitted template to send status updates
* Sending template approval status webhook

### Fixed

* Equations and adjustments for the new manager
* Adjust TriggerType for OpenAI and Typebot integrations
* Fixed Typebot start call with active session

# 2.0.2-beta (2024-07-18 21:33)

### Feature

* Open AI implemented

### Fixed

* Fixed the function of saving or not saving data in the database
* Resolve not find name
* Removed DEL_TEMP_INSTANCES as it is not being used
* Fixed global exchange name
* Add apiKey and serverUrl to prefilledVariables in typebot service
* Correction in start typebot, if it doesn't exist, create it

# 2.0.1-beta (2024-07-17 17:01)

### Fixed

* Resolved issue with Chatwoot not receiving messages sent by Typebot

# 2.0.0-beta (2024-07-14 17:00)

### Feature

* Added prisma orm, connection to postgres and mysql
* Added chatwoot integration activation
* Added typebot integration activation
* Now you can register several typebots with triggers
* Media sent to typebot now goes as a template string, example: imageMessage|MESSAGE_ID
* Organization configuration and logo in chatwoot bot contact
* Added debounce time for typebot messages
* Tagging in chatwoot contact by instance
* Add support for managing WhatsApp templates via official API
* Fixes and implementation of regex and fallback in typebot
* Ignore jids configuration added to typebot (will be used for both groups and contacts)
* Minio and S3 integration
* When S3 integration enabled, the media sent to typebot now goes as a template string, example: imageMessage|MEDIA_URL

### Fixed

* Removed excessive verbose logs
* Optimization in instance registration
* Now in typebot we wait until the terminal block to accept the user's message, if it arrives before the block is sent, it is ignored
* Correction of audio sending, now we can speed it up and have the audio wireframe
* Reply with media message on Chatwoot
* improvements in sending status and groups
* Correction in response returns from buttons, lists and templates
* EvolutionAPI/Baileys implemented

### Break changes

* jwt authentication removed
* Connection to mongodb removed
* Standardized all request bodies to use camelCase
* Change in webhook information from owner to instanceId
* Changed the .env file configuration, removed the yml version and added .env to the repository root
* Removed the mobile type connection with Baileys
* Simplified payloads and endpoints
* Improved Typebot
  - Now you can register several typebots
  - Start configuration by trigger or for all
  - Session search by typebot or remoteJid
  - KeepOpen configuration (keeps the session even when the bot ends, to run once per contact)
  - StopBotFromMe configuration, allows me to stop the bot if I send a chat message.
* Changed the way the goal webhook is configured

# 1.8.2 (2024-07-03 13:50)

### Fixed

* Corretion in globall rabbitmq queue name
* Improvement in the use of mongodb database for credentials
* Fixed base64 in webhook for documentWithCaption
* Fixed Generate pairing code

# 1.8.1 (2024-06-08 21:32)

### Feature

* New method of saving sessions to a file using worker, made in partnership with [codechat](https://github.com/code-chat-br/whatsapp-api)

### Fixed

* Correction of variables breaking lines in typebot

### Fixed

* Correction of variables breaking lines in typebot

# 1.8.0 (2024-05-27 16:10)

### Feature

* Now in the manager, when logging in with the client's apikey, the listing only shows the instance corresponding to the provided apikey (only with MongoDB)
* New global mode for rabbitmq events
* Build in docker for linux/amd64, linux/arm64 platforms

### Fixed

* Correction in message formatting when generated by AI as markdown in typebot
* Security fix in fetch instance with client key when not connected to mongodb

# 1.7.5 (2024-05-21 08:50)

### Fixed

* Add merge_brazil_contacts function to solve nine digit in brazilian numbers
* Optimize ChatwootService method for updating contact
* Fix swagger auth
* Update aws sdk v3
* Fix getOpenConversationByContact and init queries error
* Method to mark chat as unread
* Added environment variable to manually select the WhatsApp web version for the baileys lib (optional)

# 1.7.4 (2024-04-28 09:46)

### Fixed

* Adjusts in proxy on fetchAgent
* Recovering messages lost with redis cache
* Log when init redis cache service
* Recovering messages lost with redis cache
* Chatwoot inbox name
* Update Baileys version

# 1.7.3 (2024-04-18 12:07)

### Fixed

* Revert fix audio encoding
* Recovering messages lost with redis cache
* Adjusts in redis for save instances
* Adjusts in proxy
* Revert pull request #523
* Added instance name on logs
* Added support for Spanish
* Fix error: invalid operator. The allowed operators for identifier are equal_to,not_equal_to in chatwoot

# 1.7.2 (2024-04-12 17:31)

### Feature

* Mobile connection via sms (test)

### Fixed

* Adjusts in redis
* Send global event in websocket
* Adjusts in proxy
* Fix audio encoding
* Fix conversation read on chatwoot version 3.7
* Fix when receiving/sending messages from whatsapp desktop with ephemeral messages enabled
* Changed returned sessions on typebot status change
* Reorganization of files and folders

# 1.7.1 (2024-04-03 10:19)

### Fixed

* Correction when sending files with captions on Whatsapp Business
* Correction in receiving messages with response on WhatsApp Business
* Correction when sending a reaction to a message on WhatsApp Business
* Correction of receiving reactions on WhatsApp business
* Removed mandatory description of rows from sendList
* Feature to collect message type in typebot

# 1.7.0 (2024-03-11 18:23)

### Feature

* Added update message endpoint
* Add translate capabilities to QRMessages in CW
* Join in Group by Invite Code
* Read messages from whatsapp in chatwoot
* Add support to use use redis in cacheservice
* Add support for labels
* Command to clearcache from chatwoot inbox
* Whatsapp Cloud API Oficial

### Fixed

* Proxy configuration improvements
* Correction in sending lists
* Adjust in webhook_base64
* Correction in typebot text formatting
* Correction in chatwoot text formatting and render list message
* Only use a axios request to get file mimetype if necessary
* When possible use the original file extension
* When receiving a file from whatsapp, use the original filename in chatwoot if possible
* Remove message ids cache in chatwoot to use chatwoot's api itself
* Adjusts the quoted message, now has contextInfo in the message Raw
* Collecting responses with text or numbers in Typebot
* Added sendList endpoint to swagger documentation
* Implemented a function to synchronize message deletions on WhatsApp, automatically reflecting in Chatwoot.
* Improvement on numbers validation
* Fix polls in message sending
* Sending status message
* Message 'connection successfully' spamming
* Invalidate the conversation cache if reopen_conversation is false and the conversation was resolved
* Fix looping when deleting a message in chatwoot
* When receiving a file from whatsapp, use the original filename in chatwoot if possible
* Correction in the sendList Function
* Implement contact upsert in messaging-history.set
* Improve proxy error handling
* Refactor fetching participants for group in WhatsApp service
* Fixed problem where the typebot final keyword did not work
* Typebot's wait now pauses the flow and composing is defined by the delay_message parameter in set typebot
* Composing over 20s now loops until finished

# 1.6.1 (2023-12-22 11:43)

### Fixed

* Fixed Lid Messages
* Fixed sending variables to typebot
* Fixed sending variables from typebot
* Correction sending s3/minio media to chatwoot and typebot
* Fixed the problem with typebot closing at the end of the flow, now this is optional with the TYPEBOT_KEEP_OPEN variable
* Fixed chatwoot Bold, Italic and Underline formatting using Regex
* Added the sign_delimiter property to the Chatwoot configuration, allowing you to set a different delimiter for the signature. Default when not defined \n
* Include instance Id field in the instance configuration
* Fixed the pairing code
* Adjusts in typebot
* Fix the problem when disconnecting the instance and connecting again using mongodb
* Options to disable docs and manager
* When deleting a message in whatsapp, delete the message in chatwoot too


# 1.6.0 (2023-12-12 17:24)

### Feature

* Added AWS SQS Integration
* Added support for new typebot API
* Added endpoint sendPresence
* New Instance Manager
* Added auto_create to the chatwoot set to create the inbox automatically or not
* Added reply, delete and message reaction in chatwoot v3.3.1

### Fixed

* Adjusts in proxy
* Adjusts in start session for Typebot
* Added mimetype field when sending media
* Ajusts in validations to messages.upsert
* Fixed messages not received: error handling when updating contact in chatwoot
* Fix workaround to manage param data as an array in mongodb
* Removed await from webhook when sending a message
* Update typebot.service.ts - element.underline change ~ for *
* Removed api restart on receiving an error
* Fixes in mongodb and chatwoot
* Adjusted return from queries in mongodb
* Added restart instance when update profile picture
* Correction of chatwoot functioning with admin flows
* Fixed problem that did not generate qrcode with the chatwoot_conversation_pending option enabled
* Fixed issue where CSAT opened a new ticket when reopen_conversation was disabled
* Fixed issue sending contact to Chatwoot via iOS

### Integrations

* Chatwoot: v3.3.1
* Typebot: v2.20.0

# 1.5.4 (2023-10-09 20:43)

### Fixed

* Baileys logger typing issue resolved
* Solved problem with duplicate messages in chatwoot

# 1.5.3 (2023-10-06 18:55)

### Feature

* Swagger documentation
* Added base 64 sending option via webhook

### Fixed

* Remove rabbitmq queues when delete instances
* Improvement in restart instance to completely redo the connection
* Update node version: v20
* Correction of messages sent by the api and typebot not appearing in chatwoot
* Adjustment to start typebot, added startSession parameter
* Chatwoot now receives messages sent via api and typebot
* Fixed problem with starting with an input in typebot
* Added check to ensure variables are not empty before executing foreach in start typebot

# 1.5.2 (2023-09-28 17:56)

### Fixed

* Fix chatwootSchema in chatwoot model to store reopen_conversation and conversation_pending options
* Problem resolved when sending files from minio to typebot
* Improvement in the "startTypebot" method to create persistent session when triggered
* New manager for Evo 1.5.2 - Set Typebot update
* Resolved problems when reading/querying instances

# 1.5.1 (2023-09-17 13:50)

### Feature

* Added listening_from_me option in Set Typebot
* Added variables options in Start Typebot
* Added webhooks for typebot events
* Added ChamaAI integration
* Added webhook to send errors
* Added support for messaging with ads on chatwoot

### Fixed

* Fix looping connection messages in chatwoot
* Improved performance of fetch instances

# 1.5.0 (2023-08-18 12:47)

### Feature

* New instance manager in /manager route
* Added extra files for chatwoot and appsmith
* Added Get Last Message and Archive for Chat
* Added env var QRCODE_COLOR
* Added websocket to send events
* Added rabbitmq to send events
* Added Typebot integration
* Added proxy endpoint
* Added send and date_time in webhook data

### Fixed

* Solved problem when disconnecting from the instance the instance was deleted
* Encoded spaces in chatwoot webhook
* Adjustment in the saving of contacts, saving the information of the number and Jid
* Update Dockerfile
* If you pass empty events in create instance and set webhook it is understood as all
* Fixed issue that did not output base64 averages
* Messages sent by the api now arrive in chatwoot

### Integrations

* Chatwoot: v2.18.0 - v3.0.0
* Typebot: v2.16.0
* Manager Evolution API

# 1.4.8 (2023-07-27 10:27)

### Fixed

* Fixed error return bug

# 1.4.7 (2023-07-27 08:47)

### Fixed

* Fixed error return bug
* Fixed problem of getting message when deleting message in chatwoot
* Change in error return pattern

# 1.4.6 (2023-07-26 17:54)

### Fixed

* Fixed bug of creating new inbox by chatwoot
* When conversation reopens is pending when conversation pending is true
* Added docker-compose file with dockerhub image

# 1.4.5 (2023-07-26 09:32)

### Fixed

* Fixed problems in localization template in chatwoot
* Fix mids going duplicated in chatwoot

# 1.4.4 (2023-07-25 15:24)

### Fixed

* Fixed chatwoot line wrap issue
* Solved receive location in chatwoot
* When requesting the pairing code, it also brings the qr code
* Option reopen_conversation in chatwoot endpoint
* Option conversation_pending in chatwoot endpoint

# 1.4.3 (2023-07-25 10:51)

### Fixed

* Adjusts in settings with options always_online, read_messages and read_status
* Fixed send webhook for event CALL
* Create instance with settings

# 1.4.2 (2023-07-24 20:52)

### Fixed

* Fixed validation is set settings
* Adjusts in group validations
* Ajusts in sticker message to chatwoot

# 1.4.1 (2023-07-24 18:28)

### Fixed

* Fixed reconnect with pairing code or qrcode
* Fixed problem in createJid

# 1.4.0 (2023-07-24 17:03)

### Features

* Added connection functionality via pairing code
* Added fetch profile endpoint in chat controller
* Created settings controller
* Added reject call and send text message when receiving a call
* Added setting to ignore group messages
* Added connection with pairing code in chatwoot with command /init:{NUMBER}
* Added encoding option in endpoint sendWhatsAppAudio

### Fixed

* Added link preview option in send text message
* Fixed problem with fileSha256 appearing when sending a sticker in chatwoot
* Fixed issue where it was not possible to open a conversation when sent at first by me on my cell phone in chatwoot
* Now it only updates the contact name if it is the same as the phone number in chatwoot
* Now accepts all chatwoot inbox templates
* Command to create new instances set to /new_instance:{NAME}:{NUMBER}
* Fix in chatwoot set, sign msg can now be disabled

### Integrations

* Chatwoot: v2.18.0 - v3.0.0 (Beta)

# 1.3.2 (2023-07-21 17:19)

### Fixed

* Fix in update settings that needed to restart after updated
* Correction in the use of the api with mongodb
* Adjustments to search endpoint for contacts, chats, messages and Status messages
* Now when deleting the instance, the data referring to it in mongodb is also deleted
* It is now validated if the instance name contains uppercase and special characters
* For compatibility reasons, container mode has been removed
* Added docker-compose files example

### Integrations

* Chatwoot: v2.18.0

# 1.3.1 (2023-07-20 07:48)

### Fixed

* Adjust in create store files

### Integrations

* Chatwoot: v2.18.0

# 1.3.0 (2023-07-19 11:33)

### Features

* Added messages.delete event
* Added restart instance endpoint
* Created automation for creating instances in the chatwoot bot with the command '#inbox_whatsapp:{INSTANCE_NAME}
* Change Baileys version to: 6.4.0
* Send contact in chatwoot
* Send contact array in chatwoot
* Added apiKey in webhook and serverUrl in fetchInstance if EXPOSE_IN_FETCH_INSTANCES: true
* Translation set to default (english) in chatwoot

### Fixed

* Fixed error to send message in large groups
* Docker files adjusted
* Fixed in the postman collection the webhookByEvent parameter by webhook_by_events
* Added validations in create instance
* Removed link preview endpoint, now it's done automatically from sending conventional text
* Added group membership validation before sending message to groups
* Adjusts in docker files
* Adjusts in returns in endpoints chatwoot and webhook
* Fixed ghost mentions in send text message
* Fixed bug that saved contacts from groups came without number in chatwoot
* Fixed problem to receive csat in chatwoot
* Fixed require fileName for document only in base64 for send media message
* Bug fix when sending mobile message change contact name to number in chatwoot
* Bug fix when connecting whatsapp does not send confirmation message
* Fixed quoted message with id or message directly
* Adjust in validation for mexican and argentine numbers
* Adjust in create store files

### Integrations

* Chatwoot: v2.18.0

# 1.2.2 (2023-07-15 09:36)

### Fixed

* Tweak in route "/" with version info
* Adjusts chatwoot version

### Integrations

* Chatwoot: v2.18.0

# 1.2.1 (2023-07-14 19:04)

### Fixed

* Adjusts in docker files
* Save picture url groups in chatwoot

# 1.2.0 (2023-07-14 15:28)

### Features

* Native integration with chatwoot
* Added returning or non-returning participants option in fetchAllGroups
* Added group integration to chatwoot
* Added automation on create instance to chatwoot
* Added verbose logs and format chatwoot service

### Fixed

* Adjusts in docker-compose files
* Adjusts in number validation for AR and MX numbers
* Adjusts in env files, removed save old_messages
* Fix when sending a message to a group I don't belong returns a bad request
* Fits the format on return from the fetchAllGroups endpoint
* Adjust in send document with caption from chatwoot
* Fixed message with undefind in chatwoot
* Changed message in path /
* Test duplicate message media in groups chatwoot
* Optimize send message from group with mentions
* Fixed name of the profile status in fetchInstances
* Fixed error 500 when logout in instance with status = close

# 1.1.5 (2023-07-12 07:17)

### Fixed

* Adjusts in temp folder
* Return with event send_message

# 1.1.4 (2023-07-08 11:01)

### Features

* Route to send status broadcast
* Added verbose logs
* Insert allContacts in payload of endpoint sendStatus

### Fixed

* Adjusted set in webhook to go empty when enabled false
* Adjust in store files
* Fixed the problem when do not save contacts when receive messages
* Changed owner of the jid for instanceName
* Create .env for installation in docker

# 1.1.3 (2023-07-06 11:43)

### Features

* Added configuration for Baileys log level in env
* Added audio to mp4 converter in optionally get Base64 From MediaMessage
* Added organization name in vcard
* Added email in vcard
* Added url in vcard
* Added verbose logs

### Fixed

* Added timestamp internally in urls to avoid caching
* Correction in decryption of poll votes
* Change in the way the api sent and saved the sent messages, now it goes in the messages.upsert event
* Fixed cash when sending stickers via url
* Improved how Redis works for instances
* Fixed problem when disconnecting the instance it removes the instance
* Fixed problem sending ack when preview is done by me
* Adjust in store files

# 1.1.2 (2023-06-28 13:43)

### Fixed

* Fixed baileys version in package.json
* Fixed problem that did not validate if the token passed in create instance already existed
* Fixed problem that does not delete instance files in server mode

# 1.1.1 (2023-06-28 10:27)

### Features

* Added group invitation sending
* Added webhook configuration per event in the individual instance registration

### Fixed

* Adjust dockerfile variables

# 1.1.0 (2023-06-21 11:17)

### Features

* Improved fetch instances endpoint, now it also fetch other instances even if they are not connected
* Added conversion of audios for sending recorded audio, now it is possible to send mp3 audios and not just ogg
* Route to fetch all groups that the connection is part of
* Route to fetch all privacy settings
* Route to update the privacy settings
* Route to update group subject
* Route to update group description
* Route to accept invite code
* Added configuration of events by webhook of instances
* Now the api key can be exposed in fetch instances if the EXPOSE_IN_FETCH_INSTANCES variable is set to true
* Added option to generate qrcode as soon as the instance is created
* The created instance token can now also be optionally defined manually in the creation endpoint
* Route to send Sticker

### Fixed

* Adjust dockerfile variables
* tweaks in docker-compose to pass variables
* Adjust the route getProfileBusiness to fetchProfileBusiness
* fix error after logout and try to get status or to connect again
* fix sending narrated audio on whatsapp android and ios
* fixed the problem of not disabling the global webhook by the variable
* Adjustment in the recording of temporary files and periodic cleaning
* Fix for container mode also work only with files
* Remove recording of old messages on sync

# 1.0.9 (2023-06-10)

### Fixed

* Adjust dockerfile variables

# 1.0.8 (2023-06-09)

### Features

* Added Docker compose file
* Added ChangeLog file

# 1.0.7 (2023-06-08)

### Features

* Ghost mention
* Mention in reply
* Profile photo change
* Profile name change
* Profile status change
* Sending a poll
* Creation of LinkPreview if message contains URL
* New webhooks system, which can be separated into a url per event
* Sending the local webhook url as destination in the webhook data for webhook redirection
* Startup modes, server or container
* Server Mode works normally as everyone is used to
* Container mode made to use one instance per container, when starting the application an instance is already created and the qrcode is generated and it starts sending webhook without having to call it manually, it only allows one instance at a time.
