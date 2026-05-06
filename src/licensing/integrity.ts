// Mirrors evolution-go/pkg/core/integrity.go — but as PLACEHOLDERS.
// On the Go side, these hashes feed whatsmeow's session store. On evolution-api
// we use Baileys, which doesn't consume them. Kept here so the licensing module
// presents the same surface area in case the licensing server starts asking for
// integrity tokens in the future.

import { createHash } from 'crypto';

import { RuntimeContext } from './runtime';

let runtimeSalt: Buffer = Buffer.from([0]);

export function activateIntegrity(rc: RuntimeContext): void {
  if (!rc) return;
  runtimeSalt = createHash('sha256')
    .update(rc.apiKey + rc.instanceId + 'ev0')
    .digest();
}

export function computeSessionSeed(instanceName: string, rc: RuntimeContext): Buffer | null {
  if (!rc || !rc.isActive()) return null;
  return createHash('sha256').update(instanceName).update(rc.apiKey).update(runtimeSalt).digest().subarray(0, 16);
}

export function deriveInstanceToken(instanceID: string, rc: RuntimeContext): string {
  if (!rc || !rc.isActive()) return '';
  return createHash('sha256')
    .update(instanceID + rc.apiKey)
    .digest('hex')
    .slice(0, 16);
}
