# Evolution API Cursor Rules

Este diretório contém as regras e configurações do Cursor IDE para o projeto Evolution API.

## Estrutura dos Arquivos

### Arquivos Principais (alwaysApply: true)
- **`core-development.mdc`** - Princípios fundamentais de desenvolvimento
- **`project-context.mdc`** - Contexto específico do projeto Evolution API
- **`cursor.json`** - Configurações do Cursor IDE

### Regras Especializadas (alwaysApply: false)
Estas regras são ativadas automaticamente quando você trabalha nos arquivos correspondentes:

#### Camadas da Aplicação
- **`specialized-rules/service-rules.mdc`** - Padrões para services (`src/api/services/`)
- **`specialized-rules/controller-rules.mdc`** - Padrões para controllers (`src/api/controllers/`)
- **`specialized-rules/dto-rules.mdc`** - Padrões para DTOs (`src/api/dto/`)
- **`specialized-rules/guard-rules.mdc`** - Padrões para guards (`src/api/guards/`)
- **`specialized-rules/route-rules.mdc`** - Padrões para routers (`src/api/routes/`)

#### Tipos e Validação
- **`specialized-rules/type-rules.mdc`** - Definições TypeScript (`src/api/types/`)
- **`specialized-rules/validate-rules.mdc`** - Schemas de validação (`src/validate/`)

#### Utilitários
- **`specialized-rules/util-rules.mdc`** - Funções utilitárias (`src/utils/`)

#### Integrações
- **`specialized-rules/integration-channel-rules.mdc`** - Integrações de canal (`src/api/integrations/channel/`)
- **`specialized-rules/integration-chatbot-rules.mdc`** - Integrações de chatbot (`src/api/integrations/chatbot/`)
- **`specialized-rules/integration-storage-rules.mdc`** - Integrações de storage (`src/api/integrations/storage/`)
- **`specialized-rules/integration-event-rules.mdc`** - Integrações de eventos (`src/api/integrations/event/`)

## Como Usar

### Referências Cruzadas
Os arquivos principais fazem referência aos especializados usando a sintaxe `@specialized-rules/nome-do-arquivo.mdc`. Quando você trabalha em um arquivo específico, o Cursor automaticamente carrega as regras relevantes.

### Exemplo de Uso
Quando você edita um arquivo em `src/api/services/`, o Cursor automaticamente:
1. Carrega `core-development.mdc` (sempre ativo)
2. Carrega `project-context.mdc` (sempre ativo)
3. Carrega `specialized-rules/service-rules.mdc` (ativado pelo glob pattern)

### Padrões de Código
Cada arquivo de regras contém:
- **Estruturas padrão** - Como organizar o código
- **Padrões de nomenclatura** - Convenções de nomes
- **Exemplos práticos** - Código de exemplo
- **Anti-padrões** - O que evitar
- **Testes** - Como testar o código
- **Padrões de Commit** - Conventional Commits com commitlint

## Configuração do Cursor

O arquivo `cursor.json` contém:
- Configurações de formatação
- Padrões de código específicos do Evolution API
- Diretórios principais do projeto
- Integrações e tecnologias utilizadas

## Manutenção

Para manter as regras atualizadas:
1. Analise novos padrões no código
2. Atualize as regras especializadas correspondentes
3. Mantenha os exemplos sincronizados com o código real
4. Documente mudanças significativas

## Tecnologias Cobertas

- **Backend**: Node.js 20+ + TypeScript 5+ + Express.js
- **Database**: Prisma ORM (PostgreSQL/MySQL)
- **Cache**: Redis + Node-cache
- **Queue**: RabbitMQ + Amazon SQS
- **Real-time**: Socket.io
- **Storage**: AWS S3 + Minio
- **Validation**: JSONSchema7
- **Logging**: Pino
- **WhatsApp**: Baileys + Meta Business API
- **Integrations**: Chatwoot, Typebot, OpenAI, Dify

## Estrutura do Projeto

```
src/
├── api/
│   ├── controllers/     # Controllers (HTTP handlers)
│   ├── services/        # Business logic
│   ├── dto/            # Data Transfer Objects
│   ├── guards/         # Authentication/Authorization
│   ├── routes/         # Express routers
│   ├── types/          # TypeScript definitions
│   └── integrations/   # External integrations
│       ├── channel/    # WhatsApp channels (Baileys, Business API)
│       ├── chatbot/    # Chatbot integrations
│       ├── event/      # Event integrations
│       └── storage/    # Storage integrations
├── cache/              # Cache implementations
├── config/             # Configuration files
├── utils/              # Utility functions
├── validate/           # Validation schemas
└── exceptions/         # Custom exceptions
```

Este sistema de regras garante consistência no código e facilita o desenvolvimento seguindo os padrões estabelecidos do Evolution API.
