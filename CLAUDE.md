# Evolution API — Briefing para Claude Code
> Manutenção, Bugfixes e Extensão do Projeto | v2.3.7 (fork) | Atualizado em Outubro 2026

---

## 1. Contexto e Objetivo

Este projeto é a **Evolution API** instalada nesta VM. O time original parou o desenvolvimento ativo em Dezembro de 2025 (última release: v2.3.7, 5 Dez 2025). O objetivo é manter a API funcionando, aplicar bugfixes críticos da comunidade e estender funcionalidades para N8N.

Esta API é o backbone de atendimento ao cliente da **DGGirl** (e-commerce de moda feminina, Nordeste do Brasil). Os workflows N8N processam mensagens de clientes, acionam agentes de IA com **Google Gemini** para responder sobre produtos, rastrear pedidos e processar pagamentos PIX. Qualquer downtime impacta diretamente o atendimento ao cliente em tempo real.

---

## 2. Stack Tecnológico

- **Runtime:** Node.js 24 (imagem `node:24-alpine`), CommonJS
- **Linguagem:** TypeScript (strict)
- **Framework:** Express.js
- **ORM:** Prisma 6 (PostgreSQL 15 em produção)
- **WhatsApp:** Baileys — pacote `baileys` versão fixa `7.0.0-rc14` (MIT, WhiskeySockets)
- **Cache:** Redis 8.4.0 (imagem fixa, sem senha — protegido por firewall, ver Seção 5.1)
- **Storage:** S3 / MinIO
- **Message Queue:** RabbitMQ / SQS
- **Execução:** Docker Compose (`docker-compose.yaml`) — **não usa PM2**
- **Build:** tsup + tsc
- **Lint:** ESLint
- **Commits:** Commitizen (`npm run commit`)

---

## 3. Arquitetura do Código

### 3.1 Estrutura de Diretórios

```
evolution-api/
├── src/
│   ├── main.ts                       # Entry point — inicializa Express na porta 8080
│   ├── api/
│   │   ├── server.module.ts          # DI container — instancia todos os serviços
│   │   ├── routes/index.router.ts    # 14 routers organizados por domínio
│   │   ├── guards/
│   │   │   ├── auth.guard.ts         # Valida API key global + token por instância
│   │   │   └── instance.guard.ts     # Verifica se instância existe e conectada
│   │   ├── controllers/              # Thin layer HTTP — recebe req, chama service
│   │   ├── services/
│   │   │   ├── monitor.service.ts    # WAMonitoringService — mapa waInstances
│   │   │   └── channel.service.ts    # ChannelStartupService — classe base abstrata
│   │   ├── dto/                      # Data Transfer Objects (class-validator)
│   │   ├── integrations/
│   │   │   ├── channel/whatsapp/
│   │   │   │   └── whatsapp.baileys.service.ts  # ★ ARQUIVO MAIS CRÍTICO
│   │   │   ├── chatbot/              # OpenAI, Dify, Typebot, Chatwoot
│   │   │   ├── event/event.manager.ts # Distribui eventos: Webhook/RabbitMQ/SQS/WS
│   │   │   └── storage/              # S3, MinIO
│   │   └── repository/              # Prisma ORM — data access layer
│   ├── config/                       # Configuração via .env
│   ├── cache/                        # Redis + local cache
│   └── exceptions/                   # Classes de exceção HTTP
├── prisma/
│   ├── postgresql-schema.prisma
│   └── mysql-schema.prisma
├── CLAUDE.md                         # ★ Este arquivo
├── package.json
└── tsconfig.json
```

### 3.2 Fluxo — Mensagem Recebida

```
WhatsApp (protocolo WebSocket)
  ↓  Baileys Library
  ↓  BaileysStartupService (whatsapp.baileys.service.ts)
  ↓  BaileysMessageProcessor (retry logic + deduplicação)
  ↓  EventManager (event.manager.ts)
  ↓  ↓  ↓  ↓
Webhook  WebSocket  RabbitMQ  SQS
  ↓
N8N (processa, chama IA, responde)
```

### 3.3 Fluxo — Envio de Mensagem via N8N

```
N8N (trigger workflow)
  ↓  HTTP POST → Evolution API :8080
  ↓  authGuard → instanceExistsGuard → instanceLoggedGuard
  ↓  Controller (roteia) → Service (lógica)
  ↓  BaileysStartupService.sendMessage()
  ↓  WhatsApp (entrega ao destinatário)
```

---

## 4. Bugs Conhecidos e Correções

### 4.1 Já corrigidos no fork

| Problema | Onde / commit |
|---|---|
| Loop infinito de QR Code (PR #2365) | `connectionUpdate()` — guard `!this.instance.wuid && !statusCode` |
| LID (`@lid`) → `@s.whatsapp.net` via `remoteJidAlt` | handlers de messages, receipts e contacts; tipos `LidMessageKey`/`LidContact` em `wa.types.ts` |
| Senha do Postgres hardcoded no compose | `docker-compose.yaml` usa `${POSTGRES_PASSWORD}` |
| **Segurança:** bypass entre instâncias via `?instanceName=` (upstream #2435) | `abstract.router.ts` — `a1822e04` |
| Vulnerabilidades de dependências (`npm audit fix` sem `--force`) | `6c33fecf` |
| Reconexão após `stream:error 515`, lista PRODUCT_LIST (`isZero`), áudio com `quoted`, envio para `@lid`, `mentionsEveryOne === true` | `2d14e4c7` |
| `messages.update` criava chat já existente (erro de unique `instanceId, remoteJid`) | `51bc1b42` |
| Baileys `7.0.0-rc.9` → `7.0.0-rc14` (GHSA-qvv5-jq5g-4cgg) | `1bedc0b4` |

**Atenção ao portar fixes do upstream:** o fix original do #2435 removia `instanceName` também do body do `/instance/create`, o que quebraria a criação de instâncias. No fork, a sanitização vale só para a query de rotas com `:instanceName`. Sempre conferir efeitos colaterais antes de copiar.

### 4.2 Pendentes

- **[MÉDIO]** Multi-Device: desconexão com Android ativo (PR #2332)
- **[MÉDIO]** findContacts (PR #2120) — aplicar se a busca de contatos não funcionar
- **[BAIXO]** `labelHandle` remove acentos dos nomes das etiquetas (`/[^\x20-\x7E]/g`), então "Não lidas" vira "No lidas"
- **[BAIXO]** Tabela `dicuments_jean` (banco `postgres`) usa pgvector, que não existe na imagem `postgres:15`; o `pg_dumpall` falha por causa dela

---

## 5. Comandos Essenciais

```bash
# Guardar a imagem atual para rollback, rebuild e deploy (obrigatório após qualquer mudança no src/)
docker tag evolution-api-api:latest evolution-api-api:pre-<mudanca>
docker compose build api && docker compose up -d api

# Rollback
docker tag evolution-api-api:pre-<mudanca> evolution-api-api:latest && docker compose up -d api

# Status / logs
docker ps
docker logs --tail 100 evolution_api

# Backup do banco (use pg_dump do banco evolution; pg_dumpall falha por causa do pgvector)
docker exec postgres pg_dump -U postgres -Fc evolution > /root/backup-pg-evolution-$(date +%F).dump

# Desenvolvimento (hot reload)
npm run dev:server

# Typecheck (limpo desde 2026-10) e bundle
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsup

# Iniciar produção
npm run start:prod

# Lint + fix automático
npm run lint

# Verificar lint sem alterar
npm run lint:check

# Commit semântico interativo
npm run commit

# Após alterar schema Prisma
npx prisma migrate dev
npx prisma generate

```

### 5.1 Infraestrutura (servidor)

- LXC 109 no Proxmox, IP `192.168.1.243`, Ubuntu 26.04 LTS, Docker 29. Exposto via `cloudflared`.
- Depois de upgrade do SO/Docker: `systemctl restart docker` antes do `docker compose up` (senão aparece o erro de iptables "SKIP DNAT").
- **O N8N (host `192.168.1.244`) usa este Redis pela LAN** (nós Redis do workflow, ex.: "Get Block"). Não ligue a porta 6379 só em `127.0.0.1`, porque isso derruba o bot.
- O Redis não tem senha. A porta 6379 fica restrita pelo firewall `redis-guard.service` (`/etc/nftables.d/redis-guard.nft`), que libera só 127/8, 172.16/12, .243 e .244 e bloqueia IPv6. Se o IP do N8N mudar, edite o arquivo e rode `systemctl restart redis-guard`.

### 5.2 Validação depois de um deploy

1. `GET /instance/connectionState/<instância>` para cada instância (o `fetchInstances` lê o status do banco).
2. Mensagens novas gravadas na tabela `Message`, tanto recebidas quanto enviadas pela API (`source = 'unknown'`).
3. Execuções do workflow do N8N com status `success`, sem nenhuma presa em `running`.
4. Log sem `ERROR` / `unhandledRejection`.

---

## 6. Workflow para Aplicar um Bugfix

1. Identificar o arquivo exato pelo mapa da Seção 3
2. Criar branch: `git checkout -b fix/nome-do-bug`
3. Aplicar o fix — **mínimo de alterações necessárias**
4. Build: `npm run build`
5. Lint: `npm run lint`
6. Commit: `npm run commit` (escolha `fix:` ou `feat:`). O pre-commit roda eslint + `tsc --noEmit`.
7. Deploy: tag de rollback + `docker compose build api && docker compose up -d api` (Seção 5), depois validar (Seção 5.2)
8. Push: `git push origin <branch>` (remote `origin` = fork `jeandgardany/evolution-api`)

> Nunca commitar `.env`, `.env.bak.*` ou `venv/`.

---

## 7. Integração com N8N

### 7.1 Endpoints Mais Usados

- `POST /message/sendText/{instanceName}` — Enviar texto
- `POST /message/sendMedia/{instanceName}` — Enviar mídia
- `POST /message/sendButtons/{instanceName}` — Enviar botões
- `GET /instance/connectionState/{instanceName}` — Status da conexão
- `GET /chat/findContacts/{instanceName}` — Buscar contatos

### 7.2 Configuração do Webhook para N8N

```http
POST http://localhost:8080/webhook/set/{instanceName}
Headers: { apikey: SUA_API_KEY }
```

```json
{
  "enabled": true,
  "url": "https://seu-n8n.dominio.com/webhook/evolution",
  "webhookByEvents": false,
  "webhookBase64": false,
  "events": [
    "MESSAGES_UPSERT",
    "MESSAGES_UPDATE",
    "CONNECTION_UPDATE",
    "SEND_MESSAGE"
  ]
}
```

### 7.3 Padrão para Novo Endpoint

```typescript
// 1. DTO em: src/api/dto/meu-recurso.dto.ts
export class MeuRecursoDto {
  instanceName: string;
  parametro: string;
}

// 2. Service em: src/api/services/meu-recurso.service.ts
// Nunca coloque lógica no Controller
export class MeuRecursoService {
  constructor(private readonly prismaRepository: PrismaRepository) {}
  async meuMetodo(instance: string, data: MeuRecursoDto) {
    // lógica aqui — use this.logger, nunca console.log
  }
}

// 3. Controller em: src/api/controllers/meu-recurso.controller.ts
// Thin layer — só roteia e trata exceções

// 4. Registrar em: src/api/routes/index.router.ts
```

---

## 8. Regras de Desenvolvimento

### Fazer
- Seguir o padrão **Controller → Service → Repository** sem exceções
- Usar `this.logger` — nunca `console.log` em código de produção
- Manter tipagem TypeScript estrita — evitar `any`
- Commits via `npm run commit` (commitizen)
- Após alterar schema Prisma: `npx prisma migrate dev && npx prisma generate`
- Sempre `npm run build` antes de aplicar em produção
- **Mínimo de alterações necessárias** — não refatorar o que não está quebrando

### Não Fazer
- Não alterar o `.env` diretamente — documentar as variáveis necessárias
- Não colocar lógica de negócio nos controllers
- Não quebrar compatibilidade de API — os contratos existentes são usados pelo N8N
- Não atualizar Baileys sem verificar breaking changes no CHANGELOG da lib
- Não remover campos de DTOs existentes — apenas adicionar novos
- Não desabilitar o `authGuard` — toda rota precisa de autenticação
- Não usar `console.log` — usar `this.logger` do projeto

---

## 9. Checklist de Manutenção Prioritária

### Verificação Inicial
- [ ] `docker ps` — checar se os containers estão rodando
- [ ] `docker logs --tail 100 evolution_api` — ver erros recentes
- [ ] `grep '"baileys"' package.json` — checar versão do Baileys (atual: `7.0.0-rc14`)
- [ ] Verificar se há erros `@lid` nos logs

### Bugs para Aplicar (Por Prioridade)
- [x] **[CRÍTICO]** Fix loop infinito QR Code — PR #2365
- [x] **[CRÍTICO]** Fix LID — uso de `remoteJidAlt`
- [x] **[CRÍTICO]** Auth bypass entre instâncias — upstream #2435
- [x] **[BAIXO]** Atualizar Baileys (rc14 em 2026-10-30)
- [ ] **[MÉDIO]** Fix Multi-Device — PR #2332 se houver desconexões
- [ ] **[MÉDIO]** Fix findContacts — PR #2120 se busca não funciona

---

## 10. Como Atualizar o Baileys

O Baileys é MIT e pode ser atualizado no fork sem perder as correções. A licença paga é só do Evolution 2.4 do upstream, que **não** deve ser adotado.

```bash
# Ver versão atual e as disponíveis
grep '"baileys"' package.json
npm view baileys dist-tags

# Ler as release notes entre a versão atual e a nova (breaking changes)
curl -s 'https://api.github.com/repos/WhiskeySockets/Baileys/releases?per_page=10'

# Atualizar com versão exata
npm install baileys@<versão> --save-exact
./node_modules/.bin/tsc --noEmit
```

Antes de fazer deploy, verificar:
- se o `messageTimestamp` continua `number | Long` (o código converte com `Long.isLong`; um `BigInt` quebraria os webhooks e o Prisma);
- se o auth state em `src/utils/use-multi-file-auth-state-*.ts` aceita os novos tipos de chave;
- fazer backup do banco (as sessões ficam nele) e guardar a imagem atual para rollback.

Depois do deploy, seguir a Seção 5.2.

---

*Evolution API Briefing — Jean Lima / DGGirl — Fevereiro 2026, atualizado em Outubro 2026*
