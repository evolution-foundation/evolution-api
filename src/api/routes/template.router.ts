import { RouterBroker } from '@api/abstract/abstract.router';
import { InstanceDto } from '@api/dto/instance.dto';
import { TemplateDeleteDto, TemplateDto, TemplateEditDto } from '@api/dto/template.dto';
import { templateController } from '@api/server.module';
import { ConfigService } from '@config/env.config';
import { createMetaErrorResponse } from '@utils/errorResponse';
import { templateDeleteSchema } from '@validate/templateDelete.schema';
import { templateEditSchema } from '@validate/templateEdit.schema';
import { instanceSchema, templateSchema } from '@validate/validate.schema';
import { RequestHandler, Router } from 'express';

import { HttpStatus } from './index.router';

export class TemplateRouter extends RouterBroker {
  constructor(
    readonly configService: ConfigService,
    ...guards: RequestHandler[]
  ) {
    super();
    this.router
      .post(this.routerPath('create'), ...guards, async (req, res) => {
        try {
          const response = await this.dataValidate<TemplateDto>({
            request: req,
            schema: templateSchema,
            ClassRef: TemplateDto,
            execute: (instance, data) => templateController.createTemplate(instance, data),
          });

          res.status(HttpStatus.CREATED).json(response);
        } catch (error) {
          // Log error for debugging
          console.error('Template creation error:', error);

          // Use utility function to create standardized error response
          const errorResponse = createMetaErrorResponse(error, 'template_creation');
          res.status(errorResponse.status).json(errorResponse);
        }
      })
      .post(this.routerPath('edit'), ...guards, async (req, res) => {
        try {
          const response = await this.dataValidate<TemplateEditDto>({
            request: req,
            schema: templateEditSchema,
            ClassRef: TemplateEditDto,
            execute: (instance, data) => templateController.editTemplate(instance, data),
          });

          res.status(HttpStatus.OK).json(response);
        } catch (error) {
          console.error('Template edit error:', error);
          const errorResponse = createMetaErrorResponse(error, 'template_edit');
          res.status(errorResponse.status).json(errorResponse);
        }
      })
      .delete(this.routerPath('delete'), ...guards, async (req, res) => {
        try {
          const response = await this.dataValidate<TemplateDeleteDto>({
            request: req,
            schema: templateDeleteSchema,
            ClassRef: TemplateDeleteDto,
            execute: (instance, data) => templateController.deleteTemplate(instance, data),
          });

          res.status(HttpStatus.OK).json(response);
        } catch (error) {
          console.error('Template delete error:', error);
          const errorResponse = createMetaErrorResponse(error, 'template_delete');
          res.status(errorResponse.status).json(errorResponse);
        }
      })
      .get(this.routerPath('find'), ...guards, async (req, res) => {
        try {
          const response = await this.dataValidate<InstanceDto>({
            request: req,
            schema: instanceSchema,
            ClassRef: InstanceDto,
            execute: (instance) => templateController.findTemplate(instance),
          });

          res.status(HttpStatus.OK).json(response);
        } catch (error) {
          // Log error for debugging
          console.error('Template find error:', error);

          // Use utility function to create standardized error response
          const errorResponse = createMetaErrorResponse(error, 'template_find');
          res.status(errorResponse.status).json(errorResponse);
        }
      });
  }

  public readonly router: Router = Router();
}
