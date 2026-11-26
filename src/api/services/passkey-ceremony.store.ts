import { randomBytes } from 'crypto';

export type PasskeyStage = 'challenge' | 'awaiting_confirmation' | 'confirmation' | 'confirmed' | 'error';

export interface PasskeyState {
  stage: PasskeyStage;
  publicKey?: unknown;
  code?: string;
  skipHandoffUX: boolean;
  error?: string;
}

interface Entry {
  instanceId: string;
  state: PasskeyState;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class PasskeyCeremonyStore {
  private byToken = new Map<string, Entry>();
  private byInstance = new Map<string, string>();

  private newToken(): string {
    return randomBytes(32).toString('hex');
  }

  private prune(now: number): void {
    for (const [tok, e] of this.byToken) {
      if (now > e.expiresAt) {
        this.byToken.delete(tok);
        if (this.byInstance.get(e.instanceId) === tok) {
          this.byInstance.delete(e.instanceId);
        }
      }
    }
  }

  start(instanceId: string, publicKey: unknown): string {
    const now = Date.now();
    this.prune(now);

    const old = this.byInstance.get(instanceId);
    if (old) this.byToken.delete(old);

    const tok = this.newToken();
    this.byToken.set(tok, {
      instanceId,
      state: { stage: 'challenge', publicKey, skipHandoffUX: false },
      expiresAt: now + DEFAULT_TTL_MS,
    });
    this.byInstance.set(instanceId, tok);
    return tok;
  }

  private setStateByInstance(instanceId: string, mutate: (s: PasskeyState) => void): void {
    const tok = this.byInstance.get(instanceId);
    if (!tok) return;
    const e = this.byToken.get(tok);
    if (!e) return;
    mutate(e.state);
    e.expiresAt = Date.now() + DEFAULT_TTL_MS;
  }

  setAwaitingConfirmation(instanceId: string): void {
    this.setStateByInstance(instanceId, (s) => {
      s.stage = 'awaiting_confirmation';
      s.publicKey = undefined;
      s.error = undefined;
    });
  }

  setConfirmation(instanceId: string, code: string, skipHandoffUX = false): void {
    this.setStateByInstance(instanceId, (s) => {
      s.stage = 'confirmation';
      s.code = code;
      s.skipHandoffUX = skipHandoffUX;
      s.error = undefined;
    });
  }

  setConfirmed(instanceId: string): void {
    this.setStateByInstance(instanceId, (s) => {
      s.stage = 'confirmed';
      s.error = undefined;
    });
  }

  setError(instanceId: string, msg: string): void {
    this.setStateByInstance(instanceId, (s) => {
      s.stage = 'error';
      s.error = msg;
    });
  }

  clear(instanceId: string): void {
    const tok = this.byInstance.get(instanceId);
    if (tok) {
      this.byToken.delete(tok);
      this.byInstance.delete(instanceId);
    }
  }

  lookup(token: string): { instanceId: string; state: PasskeyState } | undefined {
    this.prune(Date.now());
    const e = this.byToken.get(token);
    if (!e) return undefined;
    return { instanceId: e.instanceId, state: e.state };
  }

  instanceForToken(token: string): string | undefined {
    const e = this.byToken.get(token);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) return undefined;
    return e.instanceId;
  }

  stateByInstance(instanceId: string): { token: string; state: PasskeyState } | undefined {
    const tok = this.byInstance.get(instanceId);
    if (!tok) return undefined;
    const e = this.byToken.get(tok);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) return undefined;
    return { token: tok, state: e.state };
  }

  hasActiveByInstance(instanceId: string): boolean {
    const tok = this.byInstance.get(instanceId);
    if (!tok) return false;
    const e = this.byToken.get(tok);
    if (!e) return false;
    if (Date.now() > e.expiresAt) return false;
    return e.state.stage !== 'error';
  }
}

export const passkeyCeremonyStore = new PasskeyCeremonyStore();

export function buildPasskeyOpenURL(token: string): string {
  const base = process.env.PASSKEY_PUBLIC_URL || '<SET_PASSKEY_PUBLIC_URL>';
  const payload = Buffer.from(JSON.stringify({ t: token, b: base })).toString('base64url');
  return `https://web.whatsapp.com/#wapk=${payload}`;
}
