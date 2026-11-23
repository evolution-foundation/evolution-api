import { RouterBroker } from '@api/abstract/abstract.router';
import { metaController } from '@api/server.module';
import { ConfigService, Log, WaBusiness } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { Router } from 'express';

export class MetaRouter extends RouterBroker {
  private readonly logger = new Logger('MetaRouter');

  constructor(readonly configService: ConfigService) {
    super();
    this.router
      .get(this.routerPath('webhook/meta', false), async (req, res) => {
        if (req.query['hub.verify_token'] === configService.get<WaBusiness>('WA_BUSINESS').TOKEN_WEBHOOK)
          res.send(req.query['hub.challenge']);
        else res.send('Error, wrong validation token');
      })
      .post(this.routerPath('webhook/meta', false), async (req, res) => {
        const { body } = req;
        if (this.configService.get<Log>('LOG').LEVEL.includes('WEBHOOKMETA')) {
          this.logger.webhookMeta(JSON.stringify(body));
        }
        const response = await metaController.receiveWebhook(body);

        return res.status(200).json(response);
      });
  }

  public readonly router: Router = Router();
}
