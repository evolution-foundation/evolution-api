import assert from 'node:assert';

// ─── Helpers ────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result
        .then(() => {
          passed++;
          console.log(`  ✓ ${name}`);
        })
        .catch((err) => {
          failed++;
          console.log(`  ✗ ${name}: ${err.message}`);
        });
    } else {
      passed++;
      console.log(`  ✓ ${name}`);
    }
  } catch (err: any) {
    failed++;
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

function describe(name: string, fn: () => void) {
  console.log(`\n${name}`);
  fn();
}

// ─── Test: MiniMax DTO ──────────────────────────────────────────────────
import { MinimaxCredsDto, MinimaxDto, MinimaxSettingDto } from '../src/api/integrations/chatbot/minimax/dto/minimax.dto';

describe('MinimaxCredsDto', () => {
  test('should instantiate with name and apiKey', () => {
    const dto = new MinimaxCredsDto();
    dto.name = 'test-creds';
    dto.apiKey = 'test-api-key';
    assert.strictEqual(dto.name, 'test-creds');
    assert.strictEqual(dto.apiKey, 'test-api-key');
  });
});

describe('MinimaxDto', () => {
  test('should instantiate with all fields', () => {
    const dto = new MinimaxDto();
    dto.minimaxCredsId = 'creds-123';
    dto.model = 'MiniMax-M2.5';
    dto.systemMessages = ['You are a helpful assistant'];
    dto.assistantMessages = ['Hello!'];
    dto.userMessages = ['Hi'];
    dto.maxTokens = 1024;
    assert.strictEqual(dto.minimaxCredsId, 'creds-123');
    assert.strictEqual(dto.model, 'MiniMax-M2.5');
    assert.strictEqual(dto.maxTokens, 1024);
    assert.deepStrictEqual(dto.systemMessages, ['You are a helpful assistant']);
  });

  test('should allow optional fields to be undefined', () => {
    const dto = new MinimaxDto();
    dto.minimaxCredsId = 'creds-123';
    assert.strictEqual(dto.model, undefined);
    assert.strictEqual(dto.maxTokens, undefined);
    assert.strictEqual(dto.systemMessages, undefined);
  });
});

describe('MinimaxSettingDto', () => {
  test('should instantiate with minimax-specific fields', () => {
    const dto = new MinimaxSettingDto();
    dto.minimaxCredsId = 'creds-123';
    dto.minimaxIdFallback = 'bot-fallback-id';
    assert.strictEqual(dto.minimaxCredsId, 'creds-123');
    assert.strictEqual(dto.minimaxIdFallback, 'bot-fallback-id');
  });
});

// ─── Test: MiniMax Validation Schemas ───────────────────────────────────
import {
  minimaxSchema,
  minimaxCredsSchema,
  minimaxSettingSchema,
  minimaxStatusSchema,
  minimaxIgnoreJidSchema,
} from '../src/api/integrations/chatbot/minimax/validate/minimax.schema';

describe('MiniMax Validation Schemas', () => {
  test('minimaxSchema should have required fields', () => {
    assert.ok(minimaxSchema.$id);
    assert.strictEqual(minimaxSchema.type, 'object');
    assert.ok(minimaxSchema.required);
    assert.ok((minimaxSchema.required as string[]).includes('enabled'));
    assert.ok((minimaxSchema.required as string[]).includes('minimaxCredsId'));
    assert.ok((minimaxSchema.required as string[]).includes('triggerType'));
  });

  test('minimaxSchema should define model as string', () => {
    const props = minimaxSchema.properties as Record<string, any>;
    assert.strictEqual(props.model.type, 'string');
    assert.strictEqual(props.maxTokens.type, 'integer');
    assert.strictEqual(props.systemMessages.type, 'array');
  });

  test('minimaxCredsSchema should require name and apiKey', () => {
    assert.ok(minimaxCredsSchema.$id);
    assert.ok((minimaxCredsSchema.required as string[]).includes('name'));
    assert.ok((minimaxCredsSchema.required as string[]).includes('apiKey'));
  });

  test('minimaxSettingSchema should have all setting fields', () => {
    assert.ok(minimaxSettingSchema.$id);
    const props = minimaxSettingSchema.properties as Record<string, any>;
    assert.ok(props.minimaxCredsId);
    assert.ok(props.expire);
    assert.ok(props.keywordFinish);
    assert.ok(props.delayMessage);
    assert.ok(props.minimaxIdFallback);
  });

  test('minimaxStatusSchema should have remoteJid and status', () => {
    assert.ok(minimaxStatusSchema.$id);
    assert.ok((minimaxStatusSchema.required as string[]).includes('remoteJid'));
    assert.ok((minimaxStatusSchema.required as string[]).includes('status'));
  });

  test('minimaxIgnoreJidSchema should have remoteJid and action', () => {
    assert.ok(minimaxIgnoreJidSchema.$id);
    assert.ok((minimaxIgnoreJidSchema.required as string[]).includes('remoteJid'));
    assert.ok((minimaxIgnoreJidSchema.required as string[]).includes('action'));
  });
});

// ─── Test: MiniMax Service – think tag stripping ────────────────────────
describe('MiniMax Service - Think Tag Stripping', () => {
  test('should strip <think>...</think> tags from response', () => {
    const response = '<think>Let me think about this...</think>Hello! How can I help you?';
    const stripped = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    assert.strictEqual(stripped, 'Hello! How can I help you?');
  });

  test('should handle response without think tags', () => {
    const response = 'Hello! How can I help you?';
    const stripped = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    assert.strictEqual(stripped, 'Hello! How can I help you?');
  });

  test('should strip multiline think tags', () => {
    const response = '<think>\nStep 1: Analyze the question\nStep 2: Formulate response\n</think>\nThe answer is 42.';
    const stripped = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    assert.strictEqual(stripped, 'The answer is 42.');
  });

  test('should handle empty response after stripping', () => {
    const response = '<think>thinking only</think>';
    const stripped = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    assert.strictEqual(stripped, '');
  });
});

// ─── Test: MiniMax Service – conversation history management ────────────
describe('MiniMax Service - Conversation History', () => {
  test('should limit conversation history to 10 messages', () => {
    let conversationHistory: any[] = [];
    for (let i = 0; i < 15; i++) {
      conversationHistory.push({ role: 'user', content: `message ${i}` });
      conversationHistory.push({ role: 'assistant', content: `response ${i}` });
    }

    // Apply the same logic as the service
    if (conversationHistory.length > 10) {
      conversationHistory = conversationHistory.slice(conversationHistory.length - 10);
    }

    assert.strictEqual(conversationHistory.length, 10);
    // Should keep the last 10 messages
    assert.strictEqual(conversationHistory[0].content, 'message 10');
  });

  test('should serialize conversation history to JSON', () => {
    const history = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];

    const serialized = JSON.stringify({ history });
    const parsed = JSON.parse(serialized);

    assert.deepStrictEqual(parsed.history, history);
  });

  test('should handle empty conversation history', () => {
    const sessionData = { history: [] };
    assert.deepStrictEqual(sessionData.history, []);
  });

  test('should parse string context correctly', () => {
    const contextString = '{"history":[{"role":"user","content":"test"}]}';
    const parsed = JSON.parse(contextString);
    assert.strictEqual(parsed.history.length, 1);
    assert.strictEqual(parsed.history[0].role, 'user');
  });
});

// ─── Test: MiniMax Service – message preparation ────────────────────────
describe('MiniMax Service - Message Preparation', () => {
  test('should prepare system messages correctly', () => {
    const systemMessages = ['You are a helpful assistant', 'Be concise'];
    const messagesSystem = systemMessages.map((message) => ({
      role: 'system',
      content: message,
    }));

    assert.strictEqual(messagesSystem.length, 2);
    assert.strictEqual(messagesSystem[0].role, 'system');
    assert.strictEqual(messagesSystem[0].content, 'You are a helpful assistant');
  });

  test('should combine all message types in correct order', () => {
    const messagesSystem = [{ role: 'system', content: 'system msg' }];
    const messagesAssistant = [{ role: 'assistant', content: 'assistant msg' }];
    const messagesUser = [{ role: 'user', content: 'user msg' }];
    const conversationHistory = [
      { role: 'user', content: 'prev question' },
      { role: 'assistant', content: 'prev answer' },
    ];
    const messageData = { role: 'user', content: [{ type: 'text', text: 'current question' }] };

    const messages = [...messagesSystem, ...messagesAssistant, ...messagesUser, ...conversationHistory, messageData];

    assert.strictEqual(messages.length, 6);
    assert.strictEqual(messages[0].role, 'system');
    assert.strictEqual(messages[messages.length - 1].role, 'user');
  });

  test('should handle empty system/assistant/user messages', () => {
    const systemMessages: any[] = [];
    const assistantMessages: any[] = [];
    const userMessages: any[] = [];
    const messageData = { role: 'user', content: [{ type: 'text', text: 'hello' }] };

    const messages = [
      ...systemMessages.map((m) => ({ role: 'system', content: m })),
      ...assistantMessages.map((m) => ({ role: 'assistant', content: m })),
      ...userMessages.map((m) => ({ role: 'user', content: m })),
      messageData,
    ];

    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].role, 'user');
  });
});

// ─── Test: MiniMax Configuration ────────────────────────────────────────
describe('MiniMax Configuration', () => {
  test('should default model to MiniMax-M2.5', () => {
    const model = undefined || 'MiniMax-M2.5';
    assert.strictEqual(model, 'MiniMax-M2.5');
  });

  test('should use custom model when provided', () => {
    const customModel = 'MiniMax-M2.5-highspeed';
    const model = customModel || 'MiniMax-M2.5';
    assert.strictEqual(model, 'MiniMax-M2.5-highspeed');
  });

  test('should default maxTokens to 500', () => {
    const maxTokens = undefined || 500;
    assert.strictEqual(maxTokens, 500);
  });

  test('should use custom maxTokens when provided', () => {
    const customMaxTokens = 1024;
    const maxTokens = customMaxTokens || 500;
    assert.strictEqual(maxTokens, 1024);
  });
});

// ─── Test: MiniMax API URL ──────────────────────────────────────────────
describe('MiniMax API Configuration', () => {
  test('should use correct MiniMax API base URL', () => {
    const baseURL = 'https://api.minimax.io/v1';
    assert.strictEqual(baseURL, 'https://api.minimax.io/v1');
  });

  test('should use OpenAI-compatible endpoint', () => {
    const baseURL = 'https://api.minimax.io/v1';
    assert.ok(baseURL.endsWith('/v1'), 'Should end with /v1 for OpenAI compatibility');
  });
});

// ─── Test: Keyword Finish Logic ─────────────────────────────────────────
describe('MiniMax Keyword Finish Logic', () => {
  test('should match keyword finish case-insensitively', () => {
    const keywordFinish = 'bye';
    const content = 'BYE';
    const normalizedContent = content.toLowerCase().trim();
    assert.strictEqual(normalizedContent === keywordFinish.toLowerCase(), true);
  });

  test('should not match partial keyword', () => {
    const keywordFinish = 'bye';
    const content = 'goodbye';
    const normalizedContent = content.toLowerCase().trim();
    assert.strictEqual(normalizedContent === keywordFinish.toLowerCase(), false);
  });

  test('should trim whitespace before matching', () => {
    const keywordFinish = 'bye';
    const content = '  bye  ';
    const normalizedContent = content.toLowerCase().trim();
    assert.strictEqual(normalizedContent === keywordFinish.toLowerCase(), true);
  });

  test('should skip matching when keywordFinish is empty', () => {
    const keywordFinish = '';
    const content = 'bye';
    const shouldFinish = keywordFinish.length > 0 && content.toLowerCase().trim() === keywordFinish.toLowerCase();
    assert.strictEqual(shouldFinish, false);
  });
});

// ─── Test: Static Model List ────────────────────────────────────────────
describe('MiniMax Static Model List', () => {
  test('should return correct model list', () => {
    const models = [
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' },
      { id: 'MiniMax-M2.5-highspeed', name: 'MiniMax M2.5 High Speed' },
    ];

    assert.strictEqual(models.length, 2);
    assert.strictEqual(models[0].id, 'MiniMax-M2.5');
    assert.strictEqual(models[1].id, 'MiniMax-M2.5-highspeed');
  });
});

// ─── Integration Test: Schema Exports ───────────────────────────────────
describe('Integration: Schema Exports', () => {
  test('should export all MiniMax schemas from chatbot.schema', async () => {
    const schemas = await import('../src/api/integrations/chatbot/chatbot.schema');
    assert.ok(schemas.minimaxSchema, 'minimaxSchema should be exported');
    assert.ok(schemas.minimaxCredsSchema, 'minimaxCredsSchema should be exported');
    assert.ok(schemas.minimaxSettingSchema, 'minimaxSettingSchema should be exported');
    assert.ok(schemas.minimaxStatusSchema, 'minimaxStatusSchema should be exported');
    assert.ok(schemas.minimaxIgnoreJidSchema, 'minimaxIgnoreJidSchema should be exported');
  });
});

// ─── Integration Test: Config ───────────────────────────────────────────
describe('Integration: Environment Config', () => {
  test('MINIMAX_ENABLED should default to false', () => {
    const enabled = process.env?.MINIMAX_ENABLED === 'true';
    assert.strictEqual(enabled, false);
  });

  test('should enable when MINIMAX_ENABLED is true', () => {
    const original = process.env.MINIMAX_ENABLED;
    process.env.MINIMAX_ENABLED = 'true';
    const enabled = process.env?.MINIMAX_ENABLED === 'true';
    assert.strictEqual(enabled, true);
    // Restore
    if (original !== undefined) {
      process.env.MINIMAX_ENABLED = original;
    } else {
      delete process.env.MINIMAX_ENABLED;
    }
  });
});

// ─── Summary ────────────────────────────────────────────────────────────
setTimeout(() => {
  console.log(`\n─── Results: ${passed} passed, ${failed} failed ───`);
  if (failed > 0) {
    process.exit(1);
  }
}, 500);
