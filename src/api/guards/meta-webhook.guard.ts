import { ConfigService, WaBusiness } from '@config/env.config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Request, RequestHandler } from 'express';

export function metaWebhookGuard(configService: ConfigService): RequestHandler {
  return (req: Request & { rawBody?: Buffer }, res, next) => {
    const secret = configService.get<WaBusiness>('WA_BUSINESS').APP_SECRET;
    if (!secret) {
      return res.status(503).json({ error: 'WA_BUSINESS_APP_SECRET não configurado' });
    }

    const signature = req.headers['x-hub-signature-256'];
    if (typeof signature !== 'string' || !/^sha256=[a-f\d]{64}$/i.test(signature) || !Buffer.isBuffer(req.rawBody)) {
      return res.status(401).json({ error: 'Assinatura do webhook inválida' });
    }

    // Authenticate the original bytes captured by the JSON parser, never a reserialized body.
    const expected = createHmac('sha256', secret).update(req.rawBody).digest();
    const supplied = Buffer.from(signature.slice('sha256='.length), 'hex');
    if (!timingSafeEqual(expected, supplied)) {
      return res.status(401).json({ error: 'Assinatura do webhook inválida' });
    }

    return next();
  };
}
