---
description: Controller patterns for Evolution API
globs:
  - "src/api/controllers/**/*.ts"
  - "src/api/integrations/**/controllers/*.ts"
alwaysApply: false
---

# Evolution API Controller Rules

## Controller Structure Pattern

### Standard Controller Class
```typescript
export class ExampleController {
  constructor(private readonly exampleService: ExampleService) {}

  public async createExample(instance: InstanceDto, data: ExampleDto) {
    return this.exampleService.create(instance, data);
  }

  public async findExample(instance: InstanceDto) {
    return this.exampleService.find(instance);
  }
}
```

## Dependency Injection Pattern

### Service Injection
```typescript
// CORRECT - Evolution API pattern
export class ChatController {
  constructor(private readonly waMonitor: WAMonitoringService) {}

  public async whatsappNumber({ instanceName }: InstanceDto, data: WhatsAppNumberDto) {
    return await this.waMonitor.waInstances[instanceName].getWhatsAppNumbers(data);
  }
}

// INCORRECT - Don't inject multiple services when waMonitor is sufficient
export class ChatController {
  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly prismaRepository: PrismaRepository, // ❌ Unnecessary if waMonitor has access
    private readonly configService: ConfigService, // ❌ Unnecessary if waMonitor has access
  ) {}
}
```

## Method Signature Pattern

### Instance Parameter Pattern
```typescript
// CORRECT - Evolution API pattern (destructuring instanceName)
public async fetchCatalog({ instanceName }: InstanceDto, data: getCatalogDto) {
  return await this.waMonitor.waInstances[instanceName].fetchCatalog(instanceName, data);
}

// CORRECT - Alternative pattern for full instance (when using services)
public async createTemplate(instance: InstanceDto, data: TemplateDto) {
  return this.templateService.create(instance, data);
}

// INCORRECT - Don't use generic method names
public async methodName(instance: InstanceDto, data: DataDto) { // ❌ Use specific names
  return this.service.performAction(instance, data);
}
```

## WAMonitor Access Pattern

### Direct WAMonitor Usage
```typescript
// CORRECT - Standard pattern in controllers
export class CallController {
  constructor(private readonly waMonitor: WAMonitoringService) {}

  public async offerCall({ instanceName }: InstanceDto, data: OfferCallDto) {
    return await this.waMonitor.waInstances[instanceName].offerCall(data);
  }
}
```

## Controller Registration Pattern

### Server Module Registration
```typescript
// In server.module.ts
export const templateController = new TemplateController(templateService);
export const businessController = new BusinessController(waMonitor);
export const chatController = new ChatController(waMonitor);
export const callController = new CallController(waMonitor);
```

## Error Handling in Controllers

### Let Services Handle Errors
```typescript
// CORRECT - Let service handle errors
public async fetchCatalog(instance: InstanceDto, data: getCatalogDto) {
  return await this.waMonitor.waInstances[instance.instanceName].fetchCatalog(instance.instanceName, data);
}

// INCORRECT - Don't add try-catch in controllers unless specific handling needed
public async fetchCatalog(instance: InstanceDto, data: getCatalogDto) {
  try {
    return await this.waMonitor.waInstances[instance.instanceName].fetchCatalog(instance.instanceName, data);
  } catch (error) {
    throw error; // ❌ Unnecessary try-catch
  }
}
```

## Complex Controller Pattern

### Instance Controller Pattern
```typescript
export class InstanceController {
  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly configService: ConfigService,
    private readonly prismaRepository: PrismaRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly chatwootService: ChatwootService,
    private readonly settingsService: SettingsService,
    private readonly proxyService: ProxyController,
    private readonly cache: CacheService,
    private readonly chatwootCache: CacheService,
    private readonly baileysCache: CacheService,
    private readonly providerFiles: ProviderFiles,
  ) {}

  private readonly logger = new Logger('InstanceController');

  // Multiple methods handling different aspects
  public async createInstance(data: InstanceDto) {
    // Complex instance creation logic
  }

  public async deleteInstance({ instanceName }: InstanceDto) {
    // Complex instance deletion logic
  }
}
```

## Channel Controller Pattern

### Base Channel Controller
```typescript
export class ChannelController {
  public prismaRepository: PrismaRepository;
  public waMonitor: WAMonitoringService;

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    this.prisma = prismaRepository;
    this.monitor = waMonitor;
  }

  // Getters and setters for dependency access
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
}
```

### Extended Channel Controller
```typescript
export class EvolutionController extends ChannelController implements ChannelControllerInterface {
  private readonly logger = new Logger('EvolutionController');

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor);
  }

  integrationEnabled: boolean;

  public async receiveWebhook(data: any) {
    const numberId = data.numberId;

    if (!numberId) {
      this.logger.error('WebhookService -> receiveWebhookEvolution -> numberId not found');
      return;
    }

    const instance = await this.prismaRepository.instance.findFirst({
      where: { number: numberId },
    });

    if (!instance) {
      this.logger.error('WebhookService -> receiveWebhook -> instance not found');
      return;
    }

    await this.waMonitor.waInstances[instance.name].connectToWhatsapp(data);

    return {
      status: 'success',
    };
  }
}
```

## Chatbot Controller Pattern

### Base Chatbot Controller
```typescript
export abstract class BaseChatbotController<BotType = any, BotData extends BaseChatbotDto = BaseChatbotDto>
  extends ChatbotController
  implements ChatbotControllerInterface
{
  public readonly logger: Logger;
  integrationEnabled: boolean;
  
  // Abstract methods to be implemented
  protected abstract readonly integrationName: string;
  protected abstract processBot(/* parameters */): Promise<void>;
  protected abstract getFallbackBotId(settings: any): string | undefined;

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor);
  }

  // Base implementation methods
  public async createBot(instance: InstanceDto, data: BotData) {
    // Common bot creation logic
  }
}
```

## Method Naming Conventions

### Standard Method Names
- `create*()` - Create operations
- `find*()` - Find operations  
- `fetch*()` - Fetch from external APIs
- `send*()` - Send operations
- `receive*()` - Receive webhook/data
- `handle*()` - Handle specific actions
- `offer*()` - Offer services (like calls)

## Return Patterns

### Direct Return Pattern
```typescript
// CORRECT - Direct return from service
public async createTemplate(instance: InstanceDto, data: TemplateDto) {
  return this.templateService.create(instance, data);
}

// CORRECT - Direct return from waMonitor
public async offerCall({ instanceName }: InstanceDto, data: OfferCallDto) {
  return await this.waMonitor.waInstances[instanceName].offerCall(data);
}
```

## Controller Testing Pattern

### Unit Test Structure
```typescript
describe('ExampleController', () => {
  let controller: ExampleController;
  let service: jest.Mocked<ExampleService>;

  beforeEach(() => {
    const mockService = {
      create: jest.fn(),
      find: jest.fn(),
    };

    controller = new ExampleController(mockService as any);
    service = mockService as any;
  });

  describe('createExample', () => {
    it('should call service create method', async () => {
      const instance = { instanceName: 'test' };
      const data = { test: 'data' };
      const expectedResult = { success: true };

      service.create.mockResolvedValue(expectedResult);

      const result = await controller.createExample(instance, data);

      expect(service.create).toHaveBeenCalledWith(instance, data);
      expect(result).toEqual(expectedResult);
    });
  });
});
```

## Interface Implementation

### Controller Interface Pattern
```typescript
export interface ChannelControllerInterface {
  integrationEnabled: boolean;
}

export interface ChatbotControllerInterface {
  integrationEnabled: boolean;
  createBot(instance: InstanceDto, data: any): Promise<any>;
  findBot(instance: InstanceDto): Promise<any>;
  // ... other methods
}
```

## Controller Organization

### File Naming Convention
- `*.controller.ts` - Main controllers
- `*/*.controller.ts` - Integration-specific controllers

### Method Organization
1. Constructor
2. Public methods (alphabetical order)
3. Private methods (if any)

### Import Organization
```typescript
// DTOs first
import { InstanceDto } from '@api/dto/instance.dto';
import { ExampleDto } from '@api/dto/example.dto';

// Services
import { ExampleService } from '@api/services/example.service';

// Types
import { WAMonitoringService } from '@api/services/monitor.service';
```