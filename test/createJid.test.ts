import assert from 'node:assert/strict';

import { createJid } from '../src/utils/createJid';

const newsletterJid = '120363410820597640@newsletter';

assert.equal(createJid(newsletterJid), newsletterJid);
assert.equal(createJid('120363425112220321@g.us'), '120363425112220321@g.us');

console.log('createJid newsletter support ok');
