import { Curve, getBinaryNodeChild, S_WHATSAPP_NET } from 'baileys';

import { buildPasskeyOpenURL, passkeyCeremonyStore } from '@api/services/passkey-ceremony.store';

import * as pk from './passkey-ceremony.crypto';

const SERVER_JID = S_WHATSAPP_NET;
const HANDOFF_TTL_MS = 5 * 60 * 1000;

interface CeremonyDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sock: any;
  instanceId: string;
  deviceType: number;
  logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getCreds: () => any;
  saveCreds: () => void | Promise<void>;
}

export class PasskeyCeremony {
  private handoffKey: Buffer | null = null;
  private handoffTs = 0;
  private skipHandoffUX = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cache: { keyPair: any; companionNonce: Buffer; pairingRef: string; encryptionKey?: Buffer } | null = null;

  constructor(private readonly deps: CeremonyDeps) {}

  attach(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.deps.sock.ws.on('CB:notification', (node: any) => {
      const type = node?.attrs?.type;
      if (type === 'passkey_prologue_request') {
        this.onPrologueRequest(node).catch((e) => this.fail(e as Error));
      } else if (type === 'crsc_continuation') {
        this.onContinuation(node).catch((e) => this.fail(e as Error));
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private fromServer(node: any): boolean {
    const from: string = node?.attrs?.from;
    return !from || from === SERVER_JID || from.endsWith('s.whatsapp.net');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onPrologueRequest(node: any): Promise<void> {
    if (!this.fromServer(node)) return;
    const opts = getBinaryNodeChild(node, 'passkey_request_options');
    const content = opts?.content;
    if (!Buffer.isBuffer(content)) throw new Error('passkey_request_options missing/unexpected');
    const publicKey = JSON.parse(content.toString('utf8'));

    const existing = passkeyCeremonyStore.stateByInstance(this.deps.instanceId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (existing && (existing.state.publicKey as any)?.challenge === publicKey?.challenge) {
      return;
    }

    const creds = this.deps.getCreds();
    this.handoffKey = pk.deriveHandoffKey(Buffer.from(creds.advSecretKey, 'base64'));
    this.handoffTs = Date.now();
    creds.advSecretKey = pk.randomBytes(32).toString('base64');
    await this.deps.saveCreds();

    const token = passkeyCeremonyStore.start(this.deps.instanceId, publicKey);
    this.deps.logger.info(`[Passkey] prologue_request received. Open in the browser helper: ${buildPasskeyOpenURL(token)}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async submitResponse(webAuthnResponse: any): Promise<void> {
    const ref = await this.getCompanionRef();
    const keyPair = Curve.generateKeyPair();
    const companionNonce = pk.randomBytes(32);
    const ident = pk.encodeCompanionEphemeralIdentity(Buffer.from(keyPair.public), this.deps.deviceType, ref);
    const commitment = pk.buildCommitment(ident, companionNonce);
    const prologuePayload = pk.encodeProloguePayload(ident, commitment);
    this.cache = { keyPair, companionNonce, pairingRef: ref };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const children: any[] = [
      { tag: 'credential_id', content: Buffer.from(String(webAuthnResponse.rawId), 'base64url') },
      { tag: 'webauthn_assertion', content: Buffer.from(JSON.stringify(webAuthnResponse), 'utf8') },
      { tag: 'prologue_payload', content: prologuePayload },
    ];
    if (this.handoffKey && Date.now() - this.handoffTs < HANDOFF_TTL_MS) {
      children.push({ tag: 'pairing_handoff_proof', content: pk.hmacSha256(this.handoffKey, prologuePayload) });
      this.skipHandoffUX = true;
    } else {
      this.skipHandoffUX = false;
    }

    await this.deps.sock.query({
      tag: 'iq',
      attrs: { to: SERVER_JID, type: 'set', xmlns: 'md' },
      content: [{ tag: 'passkey_prologue', content: children }],
    });
    this.handoffKey = null;
    passkeyCeremonyStore.setAwaitingConfirmation(this.deps.instanceId);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onContinuation(node: any): Promise<void> {
    if (!this.fromServer(node)) return;
    if (!this.cache) throw new Error('continuation without linking cache');
    const child = getBinaryNodeChild(node, 'primary_ephemeral_identity');
    const content = child?.content;
    if (!Buffer.isBuffer(content)) throw new Error('primary_ephemeral_identity missing/unexpected');
    const primary = pk.decodePrimaryEphemeralIdentity(content);

    const shared = Buffer.from(Curve.sharedKey(this.cache.keyPair.private, primary.publicKey));

    await this.deps.sock.query({
      tag: 'iq',
      attrs: { to: SERVER_JID, type: 'set', xmlns: 'md' },
      content: [{ tag: 'companion_nonce', content: this.cache.companionNonce }],
    });

    this.cache.encryptionKey = pk.deriveEncryptionKey(shared, this.deps.deviceType, this.cache.pairingRef);
    const code = pk.derivePairingCode(this.cache.companionNonce, primary.publicKey, primary.nonce);
    passkeyCeremonyStore.setConfirmation(this.deps.instanceId, code, false);
  }

  async confirm(): Promise<void> {
    if (!this.cache?.encryptionKey) throw new Error('ceremony has no encryption key yet');
    const creds = this.deps.getCreds();
    const req = pk.encodePairingRequest(
      Buffer.from(creds.noiseKey.public),
      Buffer.from(creds.signedIdentityKey.public),
      Buffer.from(creds.advSecretKey, 'base64'),
    );
    const iv = pk.randomBytes(12);
    const wrapped = pk.encodeEncryptedPairingRequest(pk.aesGcmEncrypt(this.cache.encryptionKey, iv, req), iv);

    await this.deps.sock.query({
      tag: 'iq',
      attrs: { to: SERVER_JID, type: 'set', xmlns: 'md' },
      content: [{ tag: 'encrypted_pairing_request', content: wrapped }],
    });
    passkeyCeremonyStore.setConfirmed(this.deps.instanceId);
    this.cache = null;
  }

  private async getCompanionRef(): Promise<string> {
    const res = await this.deps.sock.query({
      tag: 'iq',
      attrs: { to: SERVER_JID, type: 'get', xmlns: 'md' },
      content: [{ tag: 'ref' }],
    });
    const ref = getBinaryNodeChild(res, 'ref');
    const content = ref?.content;
    if (!content) throw new Error('<ref> missing in response');
    return Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  }

  private fail(e: Error): void {
    this.deps.logger.error(`[Passkey] ceremony failed: ${e.message}`);
    passkeyCeremonyStore.setError(this.deps.instanceId, e.message);
  }
}
