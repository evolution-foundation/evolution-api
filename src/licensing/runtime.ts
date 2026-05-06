// Mirrors evolution-go/pkg/core/runtime.go — license lifecycle + Express gate middleware.
//
// Bootstrap order (called from src/main.ts):
//   1. setDB(prisma)
//   2. const rc = await initializeRuntime({ tier, version, globalApiKey })
//   3. app.use(gateMiddleware(rc))   ← before business routers
//   4. registerLicenseRoutes(app, rc)
//   5. startHeartbeat(rc, startedAt)
//   6. process.on('SIGTERM', () => shutdown(rc))

import { Logger } from '@config/logger.config';
import { createHash } from 'crypto';
import { NextFunction, Request, Response } from 'express';

import { activateIntegrity } from './integrity';
import { RegisterExchangeResponse, RuntimeContextSnapshot } from './model';
import { loadOrCreateInstanceID, loadRuntimeData, saveRuntimeData } from './store';
import { postSigned, postUnsigned, readErrorMessage } from './transport';

const logger = new Logger('Licensing');

const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes — same as Go.
const DOCS_URL = 'https://docs.evolutionfoundation.com.br/licensing';

interface InitializeOptions {
  tier?: string;
  version?: string;
  globalApiKey?: string;
}

/**
 * RuntimeContext holds the licensing state. Required by middleware and routes.
 * Mirrors the Go RuntimeContext (atomics replaced with plain fields — Node is single-threaded).
 */
export class RuntimeContext {
  public apiKey = '';
  public instanceId = '';
  public tier: string;
  public version: string;
  public registerUrl = '';
  public registerToken = '';

  private active = false;
  private ctxHash: Buffer = Buffer.alloc(32);
  private msgSent = 0;
  private msgRecv = 0;

  constructor(
    public readonly globalApiKey: string,
    tier: string,
    version: string,
  ) {
    this.tier = tier;
    this.version = version;
  }

  isActive(): boolean {
    return this.active;
  }

  setActive(active: boolean): void {
    this.active = active;
  }

  contextHash(): Buffer {
    return this.ctxHash;
  }

  recomputeContextHash(): void {
    this.ctxHash = createHash('sha256')
      .update(this.apiKey + this.instanceId)
      .digest();
  }

  trackMessageSent(): void {
    this.msgSent += 1;
  }

  trackMessageRecv(): void {
    this.msgRecv += 1;
  }

  collectAndResetSent(): number {
    const v = this.msgSent;
    this.msgSent = 0;
    return v;
  }

  collectAndResetRecv(): number {
    const v = this.msgRecv;
    this.msgRecv = 0;
    return v;
  }

  snapshot(): RuntimeContextSnapshot {
    return {
      active: this.active,
      apiKey: this.apiKey,
      instanceId: this.instanceId,
      tier: this.tier,
      version: this.version,
      registerUrl: this.registerUrl,
    };
  }
}

let globalRC: RuntimeContext | null = null;

/** Globally-callable counters (mirror Go's TrackMessageSent/Recv). */
export function trackMessageSent(): void {
  globalRC?.trackMessageSent();
}
export function trackMessageRecv(): void {
  globalRC?.trackMessageRecv();
}

/**
 * Step-by-step boot:
 *   1. Load or create instance ID (hardware-based, persistent)
 *   2. If license exists in DB → activate locally (works even if licensing server is down)
 *   3. If no license but globalApiKey is set → try to use it as api_key
 *   4. Otherwise → inactive; gate middleware will return 503 until activation
 */
export async function initializeRuntime(opts: InitializeOptions = {}): Promise<RuntimeContext> {
  const tier = opts.tier || 'evolution-api';
  const version = opts.version || 'unknown';
  const globalApiKey = opts.globalApiKey ?? '';

  const rc = new RuntimeContext(globalApiKey, tier, version);

  // Step 1: Instance ID (hardware-based, persistent across restarts).
  try {
    rc.instanceId = await loadOrCreateInstanceID();
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2021') {
      // Prisma error P2021 = "table does not exist" — almost always means
      // the operator skipped `npm run db:deploy` after upgrading.
      logger.error('╔══════════════════════════════════════════════════════════╗');
      logger.error('║          Database is missing the licensing table          ║');
      logger.error('╚══════════════════════════════════════════════════════════╝');
      logger.error('The RuntimeConfig table was not found in the database.');
      logger.error('Run the migration and restart:');
      logger.error('  npm run db:deploy');
      logger.error(`Docs: ${DOCS_URL}`);
      process.exit(1);
    }
    throw err;
  }

  // Step 2: Try loading existing license from DB.
  const stored = await loadRuntimeData();
  if (stored && stored.apiKey) {
    rc.apiKey = stored.apiKey;
    logger.info(`License found: ${maskKey(stored.apiKey)}`);

    // License exists → always activate locally. Even if the licensing server is unreachable,
    // the service must keep working.
    rc.recomputeContextHash();
    rc.setActive(true);
    activateIntegrity(rc);
    logger.info('License activated successfully');

    // Notify the licensing server async — failure is acceptable (telemetry only).
    activateInstance(rc).catch((err) => {
      logger.warn(`Remote activation notice failed (non-blocking): ${readErrorMessage(err)}`);
    });
  } else if (rc.globalApiKey) {
    // No license in DB but globalApiKey is set — try using it as api_key.
    rc.apiKey = rc.globalApiKey;
    try {
      await activateInstance(rc);
      // globalApiKey is a valid api_key — save to DB and activate.
      await saveRuntimeData({ apiKey: rc.globalApiKey, tier, customerId: 0 });
      rc.recomputeContextHash();
      rc.setActive(true);
      activateIntegrity(rc);
      logger.info('Global API key accepted — license saved and activated');
    } catch (err) {
      // Not a valid api_key — fall through to registration flow.
      rc.apiKey = '';
      printRegistrationBanner();
      rc.setActive(false);
      logger.debug(`Global API key not accepted by licensing server: ${readErrorMessage(err)}`);
    }
  } else {
    printRegistrationBanner(rc);
    rc.setActive(false);
  }

  globalRC = rc;
  return rc;
}

function printRegistrationBanner(rc?: RuntimeContext): void {
  logger.warn('╔══════════════════════════════════════════════════════════╗');
  logger.warn('║              License Registration Required               ║');
  logger.warn('╚══════════════════════════════════════════════════════════╝');
  logger.warn('This Evolution API instance is not activated yet.');
  logger.warn('API endpoints will return HTTP 503 until activation.');
  logger.warn('');
  logger.warn('To activate:');
  logger.warn('  1. Open the manager at /manager/login on this host');
  logger.warn('  2. Or set AUTHENTICATION_API_KEY in your .env with a valid licensing key');
  logger.warn(`  3. Docs: ${DOCS_URL}`);
  if (rc?.instanceId) {
    logger.warn('');
    logger.warn(`Instance ID: ${rc.instanceId}`);
  }
}

function maskKey(key: string): string {
  if (key.length < 12) return '***';
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

/** Validates context. Returns [active, registerUrl]. */
export function validateContext(rc: RuntimeContext | null): [boolean, string] {
  if (!rc) return [false, ''];
  if (!rc.isActive()) return [false, rc.registerUrl];
  // Verify hash integrity.
  const expected = createHash('sha256')
    .update(rc.apiKey + rc.instanceId)
    .digest();
  const actual = rc.contextHash();
  if (!expected.equals(actual)) return [false, ''];
  return [true, ''];
}

/**
 * Express middleware that blocks all API requests when the license is not active.
 * License routes (/license/*), assets, manager UI, health and websocket always pass.
 */
export function gateMiddleware(rc: RuntimeContext) {
  return (req: Request, res: Response, next: NextFunction) => {
    const path = req.path;

    // Always pass: health, license routes, manager UI, static assets.
    if (
      path === '/' ||
      path === '/health' ||
      path === '/server/ok' ||
      path === '/favicon.ico' ||
      path === '/license/status' ||
      path === '/license/register' ||
      path === '/license/activate' ||
      path.startsWith('/manager') ||
      path.startsWith('/assets') ||
      path.startsWith('/store') ||
      path === '/ws' ||
      /\.(svg|css|js|png|ico|woff2?|ttf|map)$/i.test(path)
    ) {
      return next();
    }

    const [valid] = validateContext(rc);
    if (!valid) {
      const scheme = (req.headers['x-forwarded-proto'] as string) || req.protocol;
      const host = req.headers.host;
      const managerUrl = `${scheme}://${host}/manager/login`;

      return res.status(503).json({
        error: 'service not activated',
        code: 'LICENSE_REQUIRED',
        register_url: managerUrl,
        instance_id: rc.instanceId,
        docs_url: DOCS_URL,
        message: `This Evolution API instance is not activated. Open ${managerUrl} to activate, or set AUTHENTICATION_API_KEY in your .env with a valid licensing key. Docs: ${DOCS_URL}`,
      });
    }

    next();
  };
}

/** Resolves an authorization_code into a real api_key — falls back to the input if exchange fails. */
async function exchangeCode(code: string, instanceId: string): Promise<string | null> {
  try {
    const resp = await postUnsigned<RegisterExchangeResponse>('/v1/register/exchange', {
      authorization_code: code,
      instance_id: instanceId,
    });
    return resp.data?.api_key || null;
  } catch {
    return null;
  }
}

async function resolveApiKey(authCodeOrKey: string, instanceId: string): Promise<string> {
  const exchanged = await exchangeCode(authCodeOrKey, instanceId);
  if (exchanged) return exchanged;
  // Fallback: treat as api_key directly (mirrors Go behaviour).
  return authCodeOrKey;
}

/** Completes activation after the registration callback. */
export async function completeActivation(
  rc: RuntimeContext,
  authCodeOrKey: string,
  tier: string,
  customerId: number,
): Promise<void> {
  const apiKey = await resolveApiKey(authCodeOrKey, rc.instanceId);
  rc.apiKey = apiKey;
  rc.registerUrl = '';
  rc.registerToken = '';

  try {
    await saveRuntimeData({ apiKey, tier, customerId });
  } catch (err) {
    logger.warn(`Could not save license: ${readErrorMessage(err)}`);
  }

  await activateInstance(rc);

  rc.recomputeContextHash();
  rc.setActive(true);
  activateIntegrity(rc);

  logger.info(`License activated. Key: ${maskKey(apiKey)} (tier: ${tier})`);

  // Send first heartbeat immediately after activation.
  sendHeartbeat(rc, 0).catch((err) => {
    logger.warn(`First heartbeat failed: ${readErrorMessage(err)}`);
  });
}

async function activateInstance(rc: RuntimeContext): Promise<void> {
  const resp = await postSigned<{ status: string }>(
    '/v1/activate',
    { instance_id: rc.instanceId, version: rc.version },
    rc.apiKey,
  );
  if (resp.data?.status !== 'active') {
    throw new Error(`activation returned status: ${resp.data?.status}`);
  }
}

async function sendHeartbeat(rc: RuntimeContext, uptimeSeconds: number): Promise<void> {
  const msgSent = rc.collectAndResetSent();
  const msgRecv = rc.collectAndResetRecv();

  const payload: Record<string, unknown> = {
    instance_id: rc.instanceId,
    uptime_seconds: uptimeSeconds,
    version: rc.version,
  };

  if (msgSent > 0 || msgRecv > 0) {
    const bundle: Record<string, number> = {};
    if (msgSent > 0) bundle.messages_sent = msgSent;
    if (msgRecv > 0) bundle.messages_recv = msgRecv;
    payload.telemetry_bundle = bundle;
  }

  try {
    await postSigned('/v1/heartbeat', payload, rc.apiKey);
  } catch (err) {
    // Re-add counters so they're not lost.
    for (let i = 0; i < msgSent; i++) rc.trackMessageSent();
    for (let i = 0; i < msgRecv; i++) rc.trackMessageRecv();
    throw err;
  }
}

/** Starts the periodic heartbeat. Fire-and-forget — failures never block the service. */
export function startHeartbeat(rc: RuntimeContext, startTime: Date): NodeJS.Timeout {
  return setInterval(async () => {
    if (!rc.isActive()) return;
    const uptime = Math.floor((Date.now() - startTime.getTime()) / 1000);
    try {
      await sendHeartbeat(rc, uptime);
    } catch (err) {
      logger.warn(`Heartbeat failed (non-blocking): ${readErrorMessage(err)}`);
    }
  }, HEARTBEAT_INTERVAL_MS).unref();
}

/** Notifies the licensing server about shutdown. Best-effort. */
export async function shutdown(rc: RuntimeContext | null): Promise<void> {
  if (!rc || !rc.apiKey) return;
  try {
    await postSigned('/v1/deactivate', { instance_id: rc.instanceId }, rc.apiKey);
  } catch {
    // Best-effort.
  }
}

/** Initiates a registration flow with the licensing server. Updates rc.registerUrl. */
export async function initRegistration(rc: RuntimeContext, redirectUri?: string): Promise<string> {
  const payload: Record<string, string> = {
    tier: rc.tier,
    version: rc.version,
    instance_id: rc.instanceId,
  };
  if (redirectUri) payload.redirect_uri = redirectUri;

  const resp = await postUnsigned<{ register_url: string; token: string }>('/v1/register/init', payload);
  rc.registerUrl = resp.data?.register_url ?? '';
  rc.registerToken = resp.data?.token ?? '';
  return rc.registerUrl;
}

/** Handles the activation callback — exchanges code, saves and activates. */
export async function activateWithCode(rc: RuntimeContext, code: string): Promise<void> {
  const exchangeResp = await postUnsigned<RegisterExchangeResponse>('/v1/register/exchange', {
    authorization_code: code,
    instance_id: rc.instanceId,
  });

  const result = exchangeResp.data;
  if (!result?.api_key) {
    throw new Error('Invalid or expired code');
  }

  await completeActivation(rc, result.api_key, result.tier, result.customer_id);
}

/** Convenience helper for routes that need a public-safe view of the runtime. */
export function publicSnapshot(rc: RuntimeContext): {
  status: 'active' | 'inactive';
  instance_id: string;
  api_key?: string;
} {
  const out: { status: 'active' | 'inactive'; instance_id: string; api_key?: string } = {
    status: rc.isActive() ? 'active' : 'inactive',
    instance_id: rc.instanceId,
  };
  if (rc.apiKey) out.api_key = maskKey(rc.apiKey);
  return out;
}

/** Required by Express app.set('licensing', rc) so routes can pull it from req.app.locals. */
export function getRuntimeContext(): RuntimeContext | null {
  return globalRC;
}
