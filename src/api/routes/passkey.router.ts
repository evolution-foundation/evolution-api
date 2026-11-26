import { PasskeyController } from '@api/controllers/passkey.controller';
import { Router } from 'express';

const controller = new PasskeyController();

export class PasskeyRouter {
  public readonly router: Router = Router();

  constructor() {
    this.router.get('/passkey-ceremony/:token', (req, res) => {
      const { status, body } = controller.getCeremony(req.params.token);
      res.status(status).json(body);
    });

    this.router.post('/passkey-ceremony/:token/response', async (req, res) => {
      const { status, body } = await controller.submitResponse(req.params.token, req.body);
      res.status(status).json(body);
    });

    this.router.post('/passkey-ceremony/:token/confirm', async (req, res) => {
      const { status, body } = await controller.confirm(req.params.token);
      res.status(status).json(body);
    });
  }
}
