import { InstanceDto } from '@api/dto/instance.dto';
import { TemplateDto } from '@api/dto/template.dto';
import { TemplateService } from '@api/services/template.service';

export class TemplateController {
  constructor(private readonly templateService: TemplateService) {}

  public async createTemplate(instance: InstanceDto, data: TemplateDto) {
    return this.templateService.create(instance, data);
  }

  public async findTemplate(instance: InstanceDto) {
    return this.templateService.find(instance);
  }

  public async editTemplate(
    instance: InstanceDto,
    data: { templateId: string; category?: string; components?: any; allowCategoryChange?: boolean; ttl?: number },
  ) {
    return this.templateService.edit(instance, data);
  }

  public async deleteTemplate(instance: InstanceDto, data: { name: string; hsmId?: string }) {
    return this.templateService.delete(instance, data);
  }
}
