import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { filterWebhookPayload } from './webhook-payload-filter';

function createSampleMessagePayload() {
  return {
    key: {
      remoteJid: '5511999999999@s.whatsapp.net',
      fromMe: false,
      id: 'BAE594145F4C59B4',
    },
    pushName: 'Alice',
    message: {
      conversation: 'Hello world',
      imageMessage: {
        url: 'https://mmg.whatsapp.net/example',
        mimetype: 'image/jpeg',
        jpegThumbnail: '/9j/4AAQSkZJRgABAQAAAQABAAD/',
      },
    },
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    messageTimestamp: 1700000000,
    source: 'ios',
  };
}

describe('filterWebhookPayload', () => {
  it('returns the exact same reference when no filters are configured', () => {
    const payload = createSampleMessagePayload();

    assert.equal(filterWebhookPayload(payload), payload);
    assert.equal(filterWebhookPayload(payload, {}), payload);
    assert.equal(filterWebhookPayload(payload, { excludeFields: [], includeFields: [] }), payload);
    assert.equal(filterWebhookPayload(payload, { excludeFields: null, includeFields: undefined }), payload);
  });

  it('returns primitives, null, and undefined unchanged', () => {
    assert.equal(filterWebhookPayload(null, { excludeFields: ['a'] }), null);
    assert.equal(filterWebhookPayload(undefined, { includeFields: ['a'] }), undefined);
    assert.equal(filterWebhookPayload('hello' as any, { excludeFields: ['a'] }), 'hello');
    assert.equal(filterWebhookPayload(42 as any, { includeFields: ['a'] }), 42);
  });

  it('excludes top-level and nested dot-notation fields without mutating input', () => {
    const payload = createSampleMessagePayload();
    const snapshot = structuredClone(payload);

    const filtered = filterWebhookPayload(payload, {
      excludeFields: ['base64', 'message.imageMessage', 'nonExistent.nested'],
    }) as typeof payload;

    assert.notEqual(filtered, payload);
    assert.deepEqual(payload, snapshot);

    assert.equal('base64' in filtered, false);
    assert.equal('imageMessage' in filtered.message, false);
    assert.equal(filtered.message.conversation, 'Hello world');
    assert.deepEqual(filtered.key, snapshot.key);
    assert.equal(filtered.pushName, 'Alice');
  });

  it('includes only specified top-level and nested dot-notation fields without mutating input', () => {
    const payload = createSampleMessagePayload();
    const snapshot = structuredClone(payload);

    const filtered = filterWebhookPayload(payload, {
      includeFields: ['key.remoteJid', 'message.conversation', 'pushName', 'missing.field'],
    });

    assert.notEqual(filtered, payload);
    assert.deepEqual(payload, snapshot);

    assert.deepEqual(filtered, {
      key: {
        remoteJid: '5511999999999@s.whatsapp.net',
      },
      message: {
        conversation: 'Hello world',
      },
      pushName: 'Alice',
    });
  });

  it('returns an empty object when includeFields matches nothing', () => {
    const payload = createSampleMessagePayload();
    const filtered = filterWebhookPayload(payload, {
      includeFields: ['doesNotExist', 'message.doesNotExist'],
    });

    assert.deepEqual(filtered, {});
  });

  it('applies includeFields first and then excludeFields when both are provided', () => {
    const payload = createSampleMessagePayload();
    const snapshot = structuredClone(payload);

    const filtered = filterWebhookPayload(payload, {
      includeFields: ['key', 'message'],
      excludeFields: ['message.imageMessage', 'key.fromMe'],
    });

    assert.deepEqual(payload, snapshot);
    assert.deepEqual(filtered, {
      key: {
        remoteJid: '5511999999999@s.whatsapp.net',
        id: 'BAE594145F4C59B4',
      },
      message: {
        conversation: 'Hello world',
      },
    });
  });

  it('handles array payloads for both excludeFields and includeFields', () => {
    const payload = [
      { key: { id: '1' }, base64: 'abc', pushName: 'Alice' },
      { key: { id: '2' }, base64: 'def', pushName: 'Bob' },
    ];
    const snapshot = structuredClone(payload);

    const excluded = filterWebhookPayload(payload, { excludeFields: ['base64'] });
    assert.deepEqual(payload, snapshot);
    assert.deepEqual(excluded, [
      { key: { id: '1' }, pushName: 'Alice' },
      { key: { id: '2' }, pushName: 'Bob' },
    ]);

    const included = filterWebhookPayload(payload, { includeFields: ['key.id'] });
    assert.deepEqual(payload, snapshot);
    assert.deepEqual(included, [{ key: { id: '1' } }, { key: { id: '2' } }]);
  });

  it('ignores empty, non-string, and prototype-pollution field paths', () => {
    const payload = createSampleMessagePayload();

    const filtered = filterWebhookPayload(payload, {
      excludeFields: ['', '   ', null as any, 123 as any, '__proto__.polluted', 'constructor.prototype'],
    });

    assert.equal(filtered, payload);
    assert.equal(({} as any).polluted, undefined);
  });

  it('compacts sparse holes in nested arrays when using includeFields', () => {
    const payload = {
      items: [{ a: 1 }, { b: 2 }, { a: 3, b: 4 }],
    };
    const snapshot = structuredClone(payload);

    const singleField = filterWebhookPayload(payload, {
      includeFields: ['items.a'],
    });

    assert.deepEqual(payload, snapshot);
    assert.deepEqual(singleField, { items: [{ a: 1 }, { a: 3 }] });
    assert.equal(JSON.stringify(singleField), '{"items":[{"a":1},{"a":3}]}');

    const multiField = filterWebhookPayload({ items: [{ b: 2 }, { a: 1 }] }, { includeFields: ['items.a', 'items.b'] });
    assert.deepEqual(multiField, { items: [{ b: 2 }, { a: 1 }] });

    const byIndex = filterWebhookPayload(payload, {
      includeFields: ['items.1'],
    });
    assert.deepEqual(byIndex, { items: [{ b: 2 }] });
  });

  it('removes multiple numeric array indices in excludeFields without shifting indices', () => {
    const payload = {
      items: [
        { id: 0, secret: 's0' },
        { id: 1, secret: 's1' },
        { id: 2, secret: 's2' },
        { id: 3, secret: 's3' },
      ],
    };
    const snapshot = structuredClone(payload);

    const multiIndex = filterWebhookPayload(payload, {
      excludeFields: ['items.0', 'items.1'],
    });

    assert.deepEqual(payload, snapshot);
    assert.deepEqual(multiIndex, {
      items: [
        { id: 2, secret: 's2' },
        { id: 3, secret: 's3' },
      ],
    });

    const mixedIndexAndNested = filterWebhookPayload(payload, {
      excludeFields: ['items.0', 'items.2.secret', 'items.3'],
    });
    assert.deepEqual(mixedIndexAndNested, {
      items: [{ id: 1, secret: 's1' }, { id: 2 }],
    });
  });

  it('fails closed with {} or [] when includeFields is non-empty but all paths are invalid', () => {
    const objectPayload = createSampleMessagePayload();
    const objectSnapshot = structuredClone(objectPayload);

    assert.deepEqual(filterWebhookPayload(objectPayload, { includeFields: ['__proto__'] }), {});
    assert.deepEqual(filterWebhookPayload(objectPayload, { includeFields: [''] }), {});
    assert.deepEqual(
      filterWebhookPayload(objectPayload, {
        includeFields: ['   ', null as any, 123 as any, 'constructor.prototype'],
        excludeFields: ['pushName'],
      }),
      {},
    );
    assert.deepEqual(objectPayload, objectSnapshot);

    const arrayPayload = [{ key: { id: '1' } }, { key: { id: '2' } }];
    const arraySnapshot = structuredClone(arrayPayload);

    assert.deepEqual(filterWebhookPayload(arrayPayload, { includeFields: ['__proto__'] }), []);
    assert.deepEqual(filterWebhookPayload(arrayPayload, { includeFields: [''] }), []);
    assert.deepEqual(arrayPayload, arraySnapshot);
  });

  it('preserves non-plain objects without mutating them under excludeFields', () => {
    class CustomMeta {
      secret: string;
      label: string;

      constructor(secret: string, label: string) {
        this.secret = secret;
        this.label = label;
      }
    }

    const meta = new CustomMeta('top-secret', 'ok');
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const payload = {
      meta,
      createdAt,
      secret: 'remove-me',
    };

    const filtered = filterWebhookPayload(payload, {
      excludeFields: ['secret', 'meta.secret'],
    }) as Record<string, unknown>;

    assert.equal('secret' in filtered, false);
    assert.equal(filtered.meta, meta);
    assert.equal(filtered.createdAt, createdAt);
    assert.equal(meta.secret, 'top-secret');
    assert.equal(meta.label, 'ok');

    const topLevelFiltered = filterWebhookPayload(meta, { excludeFields: ['secret'] });
    assert.equal(topLevelFiltered, meta);
    assert.equal(meta.secret, 'top-secret');
  });
});
