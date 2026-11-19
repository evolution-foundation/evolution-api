---
description: Router patterns for Evolution API
globs:
  - "src/api/routes/**/*.ts"
alwaysApply: false
---

# Evolution API Route Rules

## Router Base Pattern

### RouterBroker Extension
```typescript
import { RouterBroker } from '@api/abstract/abstract.router';
import { RequestHandler, Router } from 'express';
import { HttpStatus } from './index.router';

export class ExampleRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    this.router
      .get(this.routerPath('findExample'), ...guards, async (req, res) => {
        const response = await this.dataValidate<ExampleDto>({
          request: req,
          schema: null,
          ClassRef: ExampleDto,
          execute: (instance) => exampleController.find(instance),
        });

        return res.status(HttpStatus.OK).json(response);
      })
      .post(this.routerPath('createExample'), ...guards, async (req, res) => {
        const response = await this.dataValidate<ExampleDto>({
          request: req,
          schema: exampleSchema,
          ClassRef: ExampleDto,
          execute: (instance, data) => exampleController.create(instance, data),
        });

        return res.status(HttpStatus.CREATED).json(response);
      });
  }

  public readonly router: Router = Router();
}
```

## Main Router Pattern

### Index Router Structure
```typescript
import { Router } from 'express';
import { authGuard } from '@api/guards/auth.guard';
import { instanceExistsGuard, instanceLoggedGuard } from '@api/guards/instance.guard';
import Telemetry from '@api/guards/telemetry.guard';

enum HttpStatus {
  OK = 200,
  CREATED = 201,
  NOT_FOUND = 404,
  FORBIDDEN = 403,
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  INTERNAL_SERVER_ERROR = 500,
}

const router: Router = Router();
const guards = [instanceExistsGuard, instanceLoggedGuard, authGuard['apikey']];
const telemetry = new Telemetry();

router
  .use((req, res, next) => telemetry.collectTelemetry(req, res, next))
  .get('/', async (req, res) => {
    res.status(HttpStatus.OK).json({
      status: HttpStatus.OK,
      message: 'Welcome to the Evolution API, it is working!',
      version: packageJson.version,
      clientName: process.env.DATABASE_CONNECTION_CLIENT_NAME,
      manager: !serverConfig.DISABLE_MANAGER ? `${req.protocol}://${req.get('host')}/manager` : undefined,
      documentation: `https://doc.evolution-api.com`,
      whatsappWebVersion: (await fetchLatestWaWebVersion({})).version.join('.'),
    });
  })
  .use('/instance', new InstanceRouter(configService, ...guards).router)
  .use('/message', new MessageRouter(...guards).router)
  .use('/chat', new ChatRouter(...guards).router)
  .use('/business', new BusinessRouter(...guards).router);

export { HttpStatus, router };
```

## Data Validation Pattern

### RouterBroker dataValidate Usage
```typescript
// CORRECT - Standard validation pattern
.post(this.routerPath('createTemplate'), ...guards, async (req, res) => {
  const response = await this.dataValidate<TemplateDto>({
    request: req,
    schema: templateSchema,
    ClassRef: TemplateDto,
    execute: (instance, data) => templateController.create(instance, data),
  });

  return res.status(HttpStatus.CREATED).json(response);
})

// CORRECT - No schema validation (for simple DTOs)
.get(this.routerPath('findTemplate'), ...guards, async (req, res) => {
  const response = await this.dataValidate<InstanceDto>({
    request: req,
    schema: null,
    ClassRef: InstanceDto,
    execute: (instance) => templateController.find(instance),
  });

  return res.status(HttpStatus.OK).json(response);
})
```

## Error Handling in Routes

### Try-Catch Pattern
```typescript
// CORRECT - Error handling with utility function
.post(this.routerPath('getCatalog'), ...guards, async (req, res) => {
  try {
    const response = await this.dataValidate<NumberDto>({
      request: req,
      schema: catalogSchema,
      ClassRef: NumberDto,
      execute: (instance, data) => businessController.fetchCatalog(instance, data),
    });

    return res.status(HttpStatus.OK).json(response);
  } catch (error) {
    // Log error for debugging
    console.error('Business catalog error:', error);

    // Use utility function to create standardized error response
    const errorResponse = createMetaErrorResponse(error, 'business_catalog');
    return res.status(errorResponse.status).json(errorResponse);
  }
})

// INCORRECT - Let RouterBroker handle errors (when possible)
.post(this.routerPath('simpleOperation'), ...guards, async (req, res) => {
  try {
    const response = await this.dataValidate<SimpleDto>({
      request: req,
      schema: simpleSchema,
      ClassRef: SimpleDto,
      execute: (instance, data) => controller.simpleOperation(instance, data),
    });

    return res.status(HttpStatus.OK).json(response);
  } catch (error) {
    throw error; // ❌ Unnecessary - RouterBroker handles this
  }
})
```

## Route Path Pattern

### routerPath Usage
```typescript
// CORRECT - Use routerPath for consistent naming
.get(this.routerPath('findLabels'), ...guards, async (req, res) => {
  // Implementation
})
.post(this.routerPath('handleLabel'), ...guards, async (req, res) => {
  // Implementation
})

// INCORRECT - Hardcoded paths
.get('/labels', ...guards, async (req, res) => { // ❌ Use routerPath
  // Implementation
})
```

## Guard Application Pattern

### Guards Usage
```typescript
// CORRECT - Apply guards to protected routes
export class ProtectedRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    this.router
      .get(this.routerPath('protectedAction'), ...guards, async (req, res) => {
        // Protected action
      })
      .post(this.routerPath('anotherAction'), ...guards, async (req, res) => {
        // Another protected action
      });
  }
}

// CORRECT - No guards for public routes
export class PublicRouter extends RouterBroker {
  constructor() {
    super();
    this.router
      .get('/health', async (req, res) => {
        res.status(HttpStatus.OK).json({ status: 'healthy' });
      })
      .get('/version', async (req, res) => {
        res.status(HttpStatus.OK).json({ version: packageJson.version });
      });
  }
}
```

## Static File Serving Pattern

### Static Assets Route
```typescript
// CORRECT - Secure static file serving
router.get('/assets/*', (req, res) => {
  const fileName = req.params[0];
  
  // Security: Reject paths containing traversal patterns
  if (!fileName || fileName.includes('..') || fileName.includes('\\') || path.isAbsolute(fileName)) {
    return res.status(403).send('Forbidden');
  }
  
  const basePath = path.join(process.cwd(), 'manager', 'dist');
  const assetsPath = path.join(basePath, 'assets');
  const filePath = path.join(assetsPath, fileName);
  
  // Security: Ensure the resolved path is within the assets directory
  const resolvedPath = path.resolve(filePath);
  const resolvedAssetsPath = path.resolve(assetsPath);
  
  if (!resolvedPath.startsWith(resolvedAssetsPath + path.sep) && resolvedPath !== resolvedAssetsPath) {
    return res.status(403).send('Forbidden');
  }

  if (fs.existsSync(resolvedPath)) {
    res.set('Content-Type', mimeTypes.lookup(resolvedPath) || 'text/css');
    res.send(fs.readFileSync(resolvedPath));
  } else {
    res.status(404).send('File not found');
  }
});
```

## Special Route Patterns

### Manager Route Pattern
```typescript
export class ViewsRouter extends RouterBroker {
  public readonly router: Router;

  constructor() {
    super();
    this.router = Router();

    const basePath = path.join(process.cwd(), 'manager', 'dist');
    const indexPath = path.join(basePath, 'index.html');

    this.router.use(express.static(basePath));

    this.router.get('*', (req, res) => {
      res.sendFile(indexPath);
    });
  }
}
```

### Webhook Route Pattern
```typescript
// CORRECT - Webhook without guards
.post('/webhook/evolution', async (req, res) => {
  const response = await evolutionController.receiveWebhook(req.body);
  return res.status(HttpStatus.OK).json(response);
})

// CORRECT - Webhook with signature validation
.post('/webhook/meta', validateWebhookSignature, async (req, res) => {
  const response = await metaController.receiveWebhook(req.body);
  return res.status(HttpStatus.OK).json(response);
})
```

## Response Pattern

### Standard Response Format
```typescript
// CORRECT - Standard success response
return res.status(HttpStatus.OK).json(response);

// CORRECT - Created response
return res.status(HttpStatus.CREATED).json(response);

// CORRECT - Custom response with additional data
return res.status(HttpStatus.OK).json({
  ...response,
  timestamp: new Date().toISOString(),
  instanceName: req.params.instanceName,
});
```

## Route Organization

### File Structure
```
src/api/routes/
├── index.router.ts          # Main router with all route registrations
├── instance.router.ts       # Instance management routes
├── sendMessage.router.ts    # Message sending routes
├── chat.router.ts          # Chat operations routes
├── business.router.ts      # Business API routes
├── group.router.ts         # Group management routes
├── label.router.ts         # Label management routes
├── proxy.router.ts         # Proxy configuration routes
├── settings.router.ts      # Instance settings routes
├── template.router.ts      # Template management routes
├── call.router.ts          # Call operations routes
└── view.router.ts          # Frontend views routes
```

## Route Testing Pattern

### Router Testing
```typescript
describe('ExampleRouter', () => {
  let app: express.Application;
  let router: ExampleRouter;

  beforeEach(() => {
    app = express();
    router = new ExampleRouter();
    app.use('/api', router.router);
    app.use(express.json());
  });

  describe('GET /findExample', () => {
    it('should return example data', async () => {
      const response = await request(app)
        .get('/api/findExample/test-instance')
        .set('apikey', 'test-key')
        .expect(200);

      expect(response.body).toBeDefined();
      expect(response.body.instanceName).toBe('test-instance');
    });

    it('should return 401 without API key', async () => {
      await request(app)
        .get('/api/findExample/test-instance')
        .expect(401);
    });
  });

  describe('POST /createExample', () => {
    it('should create example successfully', async () => {
      const data = {
        name: 'Test Example',
        description: 'Test Description',
      };

      const response = await request(app)
        .post('/api/createExample/test-instance')
        .set('apikey', 'test-key')
        .send(data)
        .expect(201);

      expect(response.body.name).toBe(data.name);
    });

    it('should validate required fields', async () => {
      const data = {
        description: 'Test Description',
        // Missing required 'name' field
      };

      await request(app)
        .post('/api/createExample/test-instance')
        .set('apikey', 'test-key')
        .send(data)
        .expect(400);
    });
  });
});
```

## Route Documentation

### JSDoc for Routes
```typescript
/**
 * @route GET /api/template/findTemplate/:instanceName
 * @description Find template for instance
 * @param {string} instanceName - Instance name
 * @returns {TemplateDto} Template data
 * @throws {404} Template not found
 * @throws {401} Unauthorized
 */
.get(this.routerPath('findTemplate'), ...guards, async (req, res) => {
  // Implementation
})

/**
 * @route POST /api/template/createTemplate/:instanceName
 * @description Create new template
 * @param {string} instanceName - Instance name
 * @body {TemplateDto} Template data
 * @returns {TemplateDto} Created template
 * @throws {400} Validation error
 * @throws {401} Unauthorized
 */
.post(this.routerPath('createTemplate'), ...guards, async (req, res) => {
  // Implementation
})
```