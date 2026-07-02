import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const baileysLib = join(process.cwd(), 'node_modules', 'baileys', 'lib');

const defaults = readFileSync(join(baileysLib, 'Defaults', 'index.js'), 'utf8');
const messagesMedia = readFileSync(join(baileysLib, 'Utils', 'messages-media.js'), 'utf8');
const messages = readFileSync(join(baileysLib, 'Utils', 'messages.js'), 'utf8');
const messagesSend = readFileSync(join(baileysLib, 'Socket', 'messages-send.js'), 'utf8');

assert.match(defaults, /NEWSLETTER_MEDIA_PATH_MAP/);
assert.match(messagesMedia, /NEWSLETTER_MEDIA_PATH_MAP/);
assert.match(messagesMedia, /timeoutMs, newsletter/);
assert.match(messagesMedia, /server_thumb_gen=1/);
assert.match(messages, /newsletter: isNewsletter/);
assert.match(messages, /thumbnailDirectPath/);
assert.match(messages, /thumbnailSha256/);
assert.doesNotMatch(messages, /url:\\s*mediaUrl/);
assert.match(messagesSend, /tag: 'plaintext',[\s\S]*attrs: extraAttrs/);

console.log('baileys newsletter media patch ok');
