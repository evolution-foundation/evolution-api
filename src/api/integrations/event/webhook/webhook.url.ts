import type { JSONSchema7 } from 'json-schema';
import { Validator } from 'jsonschema';

export const WEBHOOK_HTTP_URL_PATTERN = '^[hH][tT][tT][pP][sS]?://[^\\s/?#]+\\S*(?![\\s\\S])';

const webhookUrlPattern = new RegExp(WEBHOOK_HTTP_URL_PATTERN);

function isWebhookUrl(url: unknown): boolean {
  return typeof url === 'string' && webhookUrlPattern.test(url) && URL.canParse(url);
}

Validator.prototype.customFormats['webhook-url'] = isWebhookUrl;

export const webhookUrlSchema: JSONSchema7 = {
  type: 'string',
  format: 'webhook-url',
  pattern: WEBHOOK_HTTP_URL_PATTERN,
  description: 'The "url" must be a valid http or https URL without whitespace',
};

export function persistedWebhookUrl(url: string | undefined): string | undefined {
  if (typeof url !== 'string') {
    return url;
  }

  const trimmedUrl = url.trim();
  if (!isWebhookUrl(trimmedUrl)) {
    throw {
      status: 400,
      error: 'Bad Request',
      message: ['The "url" must be a valid http or https URL'],
    };
  }

  return trimmedUrl.replace(/^https?:/i, (scheme) => scheme.toLowerCase());
}
