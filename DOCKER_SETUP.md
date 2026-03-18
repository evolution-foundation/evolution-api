# Guia: Rodando a Evolution API Localmente com Docker Compose

Este guia explica como subir toda a stack da Evolution API em ambiente local usando Docker Compose.

## Pré-requisitos

- [Docker](https://docs.docker.com/get-docker/) instalado (versão 20+)
- [Docker Compose](https://docs.docker.com/compose/install/) instalado (versão 2+)
- Portas **8080**, **3000**, **5432** e **6379** disponíveis na sua máquina

Verifique as versões:

```bash
docker --version
docker compose version
```

---

## Serviços que sobem

| Serviço             | Container            | Porta local | Descrição                         |
|---------------------|----------------------|-------------|-----------------------------------|
| Evolution API       | `evolution_api`      | `8080`      | API REST principal                |
| Evolution Manager   | `evolution_frontend` | `3000`      | Interface web de gerenciamento    |
| Redis               | `evolution_redis`    | `6379`      | Cache e persistência de sessões   |
| PostgreSQL 15       | `evolution_postgres` | `5432`      | Banco de dados relacional         |

---

## Passo a passo

### 1. Clone o repositório (se ainda não tiver)

```bash
git clone https://github.com/EvolutionAPI/evolution-api.git
cd evolution-api
```

### 2. Crie o arquivo `.env`

Copie o template de configuração local:

```bash
cp .env.local.example .env
```

> **Atenção:** O arquivo `.env.example` original **não** contém as variáveis do Postgres (`POSTGRES_DATABASE`, `POSTGRES_USERNAME`, `POSTGRES_PASSWORD`) nem aponta as URIs para os containers corretos. Use `.env.local.example` para desenvolvimento local.

### 3. Edite as variáveis obrigatórias no `.env`

Abra o `.env` e ajuste os valores marcados com `[OBRIGATÓRIO]`:

```env
# Credenciais do banco de dados
POSTGRES_DATABASE=evolution_db
POSTGRES_USERNAME=evolution_user
POSTGRES_PASSWORD=troque_por_uma_senha_forte

# A URI deve bater com as credenciais acima
DATABASE_CONNECTION_URI='postgresql://evolution_user:troque_por_uma_senha_forte@evolution-postgres:5432/evolution_db?schema=evolution_api'

# URL pública da API (sem barra no final)
SERVER_URL=http://localhost:8080

# Chave de autenticação da API - troque por uma string aleatória
AUTHENTICATION_API_KEY=sua_chave_secreta_aqui
```

> **Dica:** Para gerar uma chave aleatória segura:
> ```bash
> openssl rand -hex 32
> ```

### 4. Suba os containers

Use o arquivo `docker-compose.local.yaml` (sem dependência de redes externas de produção):

```bash
docker compose -f docker-compose.local.yaml up -d
```

Acompanhe os logs para verificar se tudo subiu corretamente:

```bash
docker compose -f docker-compose.local.yaml logs -f api
```

### 5. Verifique se a API está rodando

```bash
curl http://localhost:8080
```

Deve retornar algo como:

```json
{
  "status": 200,
  "message": "Welcome to the Evolution API, it is working!",
  "version": "2.x.x",
  ...
}
```

### 6. Acesse o painel web (Evolution Manager)

Abra no navegador: [http://localhost:3000](http://localhost:3000)

Use a `AUTHENTICATION_API_KEY` definida no `.env` para autenticar.

---

## Problemas comuns

### `network dokploy-network declared as external, but could not be found`

**Causa:** O `docker-compose.yaml` principal usa uma rede externa do Dokploy (ambiente de produção).

**Solução:** Sempre use o arquivo local:
```bash
docker compose -f docker-compose.local.yaml up -d
```

### `password authentication failed for user`

**Causa:** A senha no `DATABASE_CONNECTION_URI` não bate com `POSTGRES_PASSWORD`.

**Solução:** Certifique-se de que os três valores são consistentes:
```env
POSTGRES_USERNAME=evolution_user
POSTGRES_PASSWORD=minha_senha
DATABASE_CONNECTION_URI='postgresql://evolution_user:minha_senha@evolution-postgres:5432/evolution_db?schema=evolution_api'
```

Se já subiu o container com senha diferente, remova o volume e suba novamente:
```bash
docker compose -f docker-compose.local.yaml down -v
docker compose -f docker-compose.local.yaml up -d
```

> **Atenção:** `-v` remove os volumes e apaga os dados. Use apenas em desenvolvimento.

### `connection refused` ao tentar conectar no Redis

**Causa:** A URI do Redis aponta para `localhost` em vez do container.

**Solução:** No `.env`, certifique-se de que:
```env
CACHE_REDIS_URI=redis://evolution-redis:6379/6
```

O alias `evolution-redis` é definido no `docker-compose.local.yaml` e resolve dentro da rede Docker.

### A API sobe mas não consegue conectar no banco

**Causa:** O container da API pode ter subido antes do Postgres estar pronto.

**Solução:** Reinicie apenas o container da API:
```bash
docker compose -f docker-compose.local.yaml restart api
```

### Porta já em uso

**Causa:** Outra aplicação está usando a porta 8080, 3000, 5432 ou 6379.

**Solução:** Identifique o processo e encerre-o, ou edite as portas no `docker-compose.local.yaml`:
```yaml
ports:
  - "8081:8080"  # porta_host:porta_container
```

---

## Comandos úteis

```bash
# Ver status dos containers
docker compose -f docker-compose.local.yaml ps

# Ver logs de todos os serviços
docker compose -f docker-compose.local.yaml logs -f

# Ver logs de um serviço específico
docker compose -f docker-compose.local.yaml logs -f api

# Reiniciar um serviço
docker compose -f docker-compose.local.yaml restart api

# Parar tudo (mantém volumes/dados)
docker compose -f docker-compose.local.yaml down

# Parar e remover volumes (apaga dados)
docker compose -f docker-compose.local.yaml down -v

# Atualizar imagens
docker compose -f docker-compose.local.yaml pull
docker compose -f docker-compose.local.yaml up -d
```

---

## Variáveis que podem ser deixadas no padrão para uso local

As seguintes variáveis têm valores funcionais no `.env.local.example` e **não precisam** ser alteradas para rodar localmente:

- `SERVER_NAME`, `SERVER_TYPE`, `SERVER_PORT`
- `CORS_*`
- `LOG_*`
- `CACHE_REDIS_*` (exceto a URI, que já aponta para o container)
- `DATABASE_PROVIDER`, `DATABASE_SAVE_*`
- `WEBHOOK_*` (desabilitado por padrão)
- `RABBITMQ_ENABLED=false`, `SQS_ENABLED=false`, etc.
- Todas as integrações de chatbot (`TYPEBOT_ENABLED=false`, etc.)

---

## Variáveis opcionais para funcionalidades avançadas

Habilite conforme necessidade editando o `.env`:

| Funcionalidade       | Variável principal        | Documentação                              |
|----------------------|---------------------------|-------------------------------------------|
| Webhooks globais     | `WEBHOOK_GLOBAL_ENABLED`  | Configure URL em `WEBHOOK_GLOBAL_URL`     |
| WebSocket            | `WEBSOCKET_ENABLED`       | Real-time via Socket.io                   |
| RabbitMQ             | `RABBITMQ_ENABLED`        | Configure `RABBITMQ_URI`                  |
| OpenAI               | `OPENAI_ENABLED`          | Transcrição de áudio e GPT                |
| Typebot              | `TYPEBOT_ENABLED`         | Fluxos de chatbot visuais                 |
| Chatwoot             | `CHATWOOT_ENABLED`        | Plataforma de atendimento                 |
| Storage S3/MinIO     | `S3_ENABLED`              | Configure endpoint e credenciais          |
| Métricas Prometheus  | `PROMETHEUS_METRICS`      | Expõe `/metrics`                          |
