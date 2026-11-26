import { passkeyCeremonyStore } from '@api/services/passkey-ceremony.store';
import { waMonitor } from '@api/server.module';
import { Logger } from '@config/logger.config';

export class PasskeyController {
  private readonly logger = new Logger('PasskeyController');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public getCeremony(token: string): { status: number; body: any } {
    if (!token) return { status: 400, body: { error: 'token is required' } };

    const found = passkeyCeremonyStore.lookup(token);
    if (!found) return { status: 404, body: { error: 'ceremony not found or expired' } };

    const { state } = found;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = { stage: state.stage, skipHandoffUX: state.skipHandoffUX };
    if (state.publicKey) body.publicKey = state.publicKey;
    if (state.code) body.code = state.code;
    if (state.error) body.error = state.error;
    return { status: 200, body };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async submitResponse(token: string, webAuthnResponse: any): Promise<{ status: number; body: any }> {
    if (!token) return { status: 400, body: { error: 'token is required' } };

    const instanceId = passkeyCeremonyStore.instanceForToken(token);
    if (!instanceId) return { status: 404, body: { error: 'ceremony not found or expired' } };

    const instance = this.resolveInstance(instanceId);
    if (!instance) return { status: 404, body: { error: 'instance not found' } };

    try {
      await instance.submitPasskeyResponse(webAuthnResponse);
      return { status: 200, body: { ok: true } };
    } catch (error) {
      this.logger.error(`submitResponse: ${(error as Error).message}`);
      return { status: 500, body: { error: (error as Error).message } };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async confirm(token: string): Promise<{ status: number; body: any }> {
    if (!token) return { status: 400, body: { error: 'token is required' } };

    const instanceId = passkeyCeremonyStore.instanceForToken(token);
    if (!instanceId) return { status: 404, body: { error: 'ceremony not found or expired' } };

    const instance = this.resolveInstance(instanceId);
    if (!instance) return { status: 404, body: { error: 'instance not found' } };

    try {
      await instance.confirmPasskey();
      return { status: 200, body: { ok: true } };
    } catch (error) {
      this.logger.error(`confirm: ${(error as Error).message}`);
      return { status: 500, body: { error: (error as Error).message } };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private resolveInstance(instanceId: string): any {
    for (const name of Object.keys(waMonitor.waInstances)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inst: any = waMonitor.waInstances[name];
      if (inst?.instanceId === instanceId) return inst;
    }
    return undefined;
  }
}
