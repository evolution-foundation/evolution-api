import { BaseChatbotDto, BaseChatbotSettingDto } from '../../base-chatbot.dto';

export class MinimaxCredsDto {
  name: string;
  apiKey: string;
}

export class MinimaxDto extends BaseChatbotDto {
  minimaxCredsId: string;
  model?: string;
  systemMessages?: string[];
  assistantMessages?: string[];
  userMessages?: string[];
  maxTokens?: number;
}

export class MinimaxSettingDto extends BaseChatbotSettingDto {
  minimaxCredsId?: string;
  minimaxIdFallback?: string;
}
