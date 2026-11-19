export class TemplateDto {
  name: string;
  category: string;
  allowCategoryChange: boolean;
  language: string;
  components: any;
  webhookUrl?: string;
}

export class TemplateEditDto {
  templateId: string;
  category?: 'AUTHENTICATION' | 'MARKETING' | 'UTILITY';
  allowCategoryChange?: boolean;
  ttl?: number;
  components?: any;
}

export class TemplateDeleteDto {
  name: string;
  hsmId?: string;
}
