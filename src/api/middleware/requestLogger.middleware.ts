import { Logger } from '@config/logger.config';
import { NextFunction, Request, Response } from 'express';

const logger = new Logger('HTTP');

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const ip = req.ip || req.socket?.remoteAddress || '-';

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl} - ${res.statusCode} - ${duration}ms - ip: ${ip}`);

    if (req.originalUrl.startsWith('/webhook/meta') && req.body && Object.keys(req.body).length > 0) {
      logger.warn(`[body] ${req.method} ${req.originalUrl}: ${JSON.stringify(req.body)}`);
    }
  });

  next();
}
