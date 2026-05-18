import { RouterBroker } from '@api/abstract/abstract.router';
import { IgnoreJidDto } from '@api/dto/chatbot.dto';
import { InstanceDto } from '@api/dto/instance.dto';
import { MinimaxCredsDto, MinimaxDto, MinimaxSettingDto } from '@api/integrations/chatbot/minimax/dto/minimax.dto';
import { HttpStatus } from '@api/routes/index.router';
import { minimaxController } from '@api/server.module';
import {
  instanceSchema,
  minimaxCredsSchema,
  minimaxIgnoreJidSchema,
  minimaxSchema,
  minimaxSettingSchema,
  minimaxStatusSchema,
} from '@validate/validate.schema';
import { RequestHandler, Router } from 'express';

export class MinimaxRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    this.router
      .post(this.routerPath('creds'), ...guards, async (req, res) => {
        const response = await this.dataValidate<MinimaxCredsDto>({
          request: req,
          schema: minimaxCredsSchema,
          ClassRef: MinimaxCredsDto,
          execute: (instance, data) => minimaxController.createMinimaxCreds(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .get(this.routerPath('creds'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => minimaxController.findMinimaxCreds(instance),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .delete(this.routerPath('creds/:minimaxCredsId'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => minimaxController.deleteCreds(instance, req.params.minimaxCredsId),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .post(this.routerPath('create'), ...guards, async (req, res) => {
        const response = await this.dataValidate<MinimaxDto>({
          request: req,
          schema: minimaxSchema,
          ClassRef: MinimaxDto,
          execute: (instance, data) => minimaxController.createBot(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .get(this.routerPath('find'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => minimaxController.findBot(instance),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .get(this.routerPath('fetch/:minimaxBotId'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => minimaxController.fetchBot(instance, req.params.minimaxBotId),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .put(this.routerPath('update/:minimaxBotId'), ...guards, async (req, res) => {
        const response = await this.dataValidate<MinimaxDto>({
          request: req,
          schema: minimaxSchema,
          ClassRef: MinimaxDto,
          execute: (instance, data) => minimaxController.updateBot(instance, req.params.minimaxBotId, data),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .delete(this.routerPath('delete/:minimaxBotId'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => minimaxController.deleteBot(instance, req.params.minimaxBotId),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .post(this.routerPath('settings'), ...guards, async (req, res) => {
        const response = await this.dataValidate<MinimaxSettingDto>({
          request: req,
          schema: minimaxSettingSchema,
          ClassRef: MinimaxSettingDto,
          execute: (instance, data) => minimaxController.settings(instance, data),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .get(this.routerPath('fetchSettings'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => minimaxController.fetchSettings(instance),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .post(this.routerPath('changeStatus'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: minimaxStatusSchema,
          ClassRef: InstanceDto,
          execute: (instance, data) => minimaxController.changeStatus(instance, data),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .get(this.routerPath('fetchSessions/:minimaxBotId'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => minimaxController.fetchSessions(instance, req.params.minimaxBotId),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .post(this.routerPath('ignoreJid'), ...guards, async (req, res) => {
        const response = await this.dataValidate<IgnoreJidDto>({
          request: req,
          schema: minimaxIgnoreJidSchema,
          ClassRef: IgnoreJidDto,
          execute: (instance, data) => minimaxController.ignoreJid(instance, data),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .get(this.routerPath('getModels'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => minimaxController.getModels(instance),
        });

        res.status(HttpStatus.OK).json(response);
      });
  }

  public readonly router: Router = Router();
}
