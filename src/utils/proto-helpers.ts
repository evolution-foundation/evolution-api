import { WAProto as proto } from 'baileys';

export function deserializeAppStateSyncKey(type: string, value: unknown): unknown {
  if (type === 'app-state-sync-key' && value) {
    return proto.Message.AppStateSyncKeyData.fromObject(value);
  }
  return value;
}
