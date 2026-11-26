import { ChatwootRouter } from '@api/integrations/chatbot/chatwoot/routes/chatwoot.router';
import { DifyRouter } from '@api/integrations/chatbot/dify/routes/dify.router';
import { OpenaiRouter } from '@api/integrations/chatbot/openai/routes/openai.router';
import { TypebotRouter } from '@api/integrations/chatbot/typebot/routes/typebot.router';
import { Router } from 'express';

import { EvoaiRouter } from './evoai/routes/evoai.router';
import { EvolutionBotRouter } from './evolutionBot/routes/evolutionBot.router';
import { FlowiseRouter } from './flowise/routes/flowise.router';
import { MinimaxRouter } from './minimax/routes/minimax.router';
import { N8nRouter } from './n8n/routes/n8n.router';

export class ChatbotRouter {
  public readonly router: Router;

  constructor(...guards: any[]) {
    this.router = Router();

    this.router.use('/evolutionBot', new EvolutionBotRouter(...guards).router);
    this.router.use('/chatwoot', new ChatwootRouter(...guards).router);
    this.router.use('/typebot', new TypebotRouter(...guards).router);
    this.router.use('/openai', new OpenaiRouter(...guards).router);
    this.router.use('/dify', new DifyRouter(...guards).router);
    this.router.use('/flowise', new FlowiseRouter(...guards).router);
    this.router.use('/n8n', new N8nRouter(...guards).router);
    this.router.use('/evoai', new EvoaiRouter(...guards).router);
    this.router.use('/minimax', new MinimaxRouter(...guards).router);
  }
}
