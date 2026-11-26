import { MetaController } from '@api/integrations/channel/meta/meta.controller';
import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Integration } from '@api/types/wa.types';
import { ConfigService, EvolutionHub } from '@config/env.config';
import { Logger } from '@config/logger.config';
import * as crypto from 'crypto';

/**
 * EvoHubController — reusa o parser de webhook do Meta verbatim (o hub forwarda o
 * envelope Meta inalterado) e adiciona a validação de HMAC do header
 * X-Hub-Signature-256 sobre o RAW body.
 *
 * Fase 1: soft-mode — se EVOLUTION_HUB_WEBHOOK_SECRET não estiver setado, aceita o
 * webhook sem validar (o hub já valida a assinatura da Meta internamente). Fase 2:
 * registrar o webhook no hub com o próprio EVOLUTION_HUB_WEBHOOK_SECRET (o hub assina
 * com ele) e validar contra ele — recipe "register-with-own-secret".
 */
export class EvoHubController extends MetaController {
  private readonly hubLogger = new Logger('EvoHubController');
  protected readonly channelIntegration: string = Integration.EVOHUB;

  constructor(
    prismaRepository: PrismaRepository,
    waMonitor: WAMonitoringService,
    private readonly configService: ConfigService,
  ) {
    super(prismaRepository, waMonitor);
  }

  /**
   * Valida o header X-Hub-Signature-256 (`sha256=<hex>`) contra o
   * EVOLUTION_HUB_WEBHOOK_SECRET, computando HMAC-SHA256 sobre o RAW body.
   * Comparação constant-time. Secret vazio → soft mode (aceita).
   */
  public verifyHmac(rawBody: Buffer | undefined, signatureHeader: string | undefined): boolean {
    const secret = this.configService.get<EvolutionHub>('EVOLUTION_HUB').WEBHOOK_SECRET;

    if (!secret) {
      this.hubLogger.warn('EVOLUTION_HUB_WEBHOOK_SECRET not set — accepting webhook unsigned (soft mode)');
      return true;
    }

    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
      this.hubLogger.error('EvoHub webhook -> missing or malformed X-Hub-Signature-256');
      return false;
    }

    if (!rawBody) {
      this.hubLogger.error('EvoHub webhook -> rawBody unavailable (verify callback not wired in main.ts?)');
      return false;
    }

    const mac = crypto.createHmac('sha256', secret);
    mac.update(rawBody);
    const expected = `sha256=${mac.digest('hex')}`;

    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length) {
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  }
}
