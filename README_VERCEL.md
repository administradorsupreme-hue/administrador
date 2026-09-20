# KANEKI STORE — versão Vercel

Esta versão inclui uma Function `/api/index.js` compatível com Vercel, PostgreSQL via `pg`, sessões assinadas e OAuth Google/Discord.

## 1. Banco PostgreSQL
Crie um PostgreSQL e copie a URL de conexão para a variável `POSTGRES_URL` da Vercel. O banco cria as tabelas e importa o catálogo automaticamente no primeiro acesso.

## 2. Variáveis da Vercel
Em **Project Settings → Environment Variables**, adicione:

- `POSTGRES_URL`
- `SESSION_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `PUBLIC_BASE_URL` = `https://kanekistorepixasaasrealwebhooksandb.vercel.app`
- `DISCORD_CLIENT_ID` e `DISCORD_CLIENT_SECRET` se quiser Discord.

## 3. Google Cloud
Para um domínio de produção `https://kanekistorepixasaasrealwebhooksandb.vercel.app`:

**Origens JavaScript autorizadas**
`https://kanekistorepixasaasrealwebhooksandb.vercel.app`

**URIs de redirecionamento autorizados**
`https://kanekistorepixasaasrealwebhooksandb.vercel.app/api/oauth/google/callback`

Se você usar um domínio personalizado, substitua o domínio nos dois campos. Não cadastre o Client Secret no HTML.

## 4. Deploy
Suba esta pasta para um novo projeto Vercel ou conecte o repositório e faça um novo deployment.

Depois do deploy, abra:
`https://seu-projeto.vercel.app/`

A API responde em `/api` e os callbacks OAuth são encaminhados por `vercel.json`.

## Observação sobre imagens
O ZIP original recebido contém referências a várias imagens que não estão presentes no ZIP. Isso não causa o 404 da página, mas essas imagens continuarão quebradas até que os arquivos de imagem originais sejam colocados em `images/`.


## Versão Black/White/Purple

O painel do dono agora permite editar a identidade visual, textos principais, logo por URL, cores, links, vídeo tutorial e campos dos produtos (incluindo descrição, preço, preço antigo, estoque, categoria e foto por URL).


## Acesso ao Painel do Dono

O painel administrativo é restrito ao e-mail **administradorsupreme@gmail.com**. A API verifica o e-mail da sessão no servidor; apenas essa conta pode usar as rotas administrativas. O login do dono deve ser feito pelo Google.


## Painel do dono
O painel administrativo exige sessão OAuth do Google e o e-mail `administradorsupreme@gmail.com`. O login por senha não libera o painel.

## Logo/animação do topo
No painel do dono, em Aparência e conteúdo, use "Logo/animação do topo" para URL ou upload de PNG/GIF/MP4/WebM e selecione o tipo. GIF e vídeo entram no topo em loop.


## PIX real com Asaas

Esta versão usa a API do Asaas Sandbox para gerar um QR Code Pix dinâmico por pedido e o Webhook para confirmar automaticamente o pagamento.

Na Vercel, mantenha:
- `POSTGRES_URL`
- `SESSION_SECRET`
- `ASAAS_API_KEY` — chave secreta da API do Asaas
- `ASAAS_WEBHOOK_TOKEN` — token secreto configurado no Webhook do Asaas
- `ASAAS_API_BASE_URL` — opcional; deixe ausente no Sandbox. Para Produção, use `https://api.asaas.com/v3`.

Webhook:
`https://SEU-DOMINIO.vercel.app/api/asaas-webhook`

No Asaas Sandbox, selecione API versão `3`, mantenha o Webhook ativo e habilite pelo menos `PAYMENT_RECEIVED`.

O checkout usa automaticamente uma chave Pix **ATIVA** da conta Asaas. Por padrão, a API lista as chaves `ACTIVE` e seleciona a primeira chave aleatória (EVP). Opcionalmente, defina `ASAAS_PIX_KEY` na Vercel para fixar uma chave específica.

O backend mantém o pedido como pendente até receber a confirmação do Asaas. O evento é tratado com idempotência para evitar liberar o mesmo pedido duas vezes.
