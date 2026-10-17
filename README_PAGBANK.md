# Kaneki Store — PagBank PIX na Vercel

## Variáveis de ambiente

Em Vercel → Project → Settings → Environment Variables, configure:

- `PAGBANK_TOKEN`: token privado do portal PagBank. Mantenha o tipo **Secret**.
- `PAGBANK_API_URL`: para Sandbox, `https://sandbox.api.pagseguro.com`; para produção, `https://api.pagseguro.com`. Pode ser do tipo **Config**, pois não é segredo.
- `PUBLIC_BASE_URL`: URL pública exata da loja, sem barra final.
- `POSTGRES_URL` e `SESSION_SECRET`: usadas pelo backend existente.

O backend também reconhece `PAGBANK_API_BASE_URL` por compatibilidade, mas prefira `PAGBANK_API_URL`.

## Webhook

O backend envia a URL `PUBLIC_BASE_URL + /api/pagbank-webhook` em `notification_urls`. Por exemplo: `https://SEU-DOMINIO.vercel.app/api/pagbank-webhook`. Essa URL deve estar publicada e acessível por HTTPS.

A rota trata a notificação como um aviso e consulta o pedido pela API autenticada do PagBank. Só atualiza o status para pago quando o PagBank retorna `PAID` e o valor/moeda correspondem ao pedido local.

## Testes e produção

1. Comece com token Sandbox e `PAGBANK_API_URL=https://sandbox.api.pagseguro.com`.
2. Faça deploy na Vercel e teste geração do PIX e atualização de status.
3. Verifique o log das Functions se houver erro.
4. Para pagamentos reais, troque ambos: token de produção e `PAGBANK_API_URL=https://api.pagseguro.com`.
5. Após mudar variáveis, faça um novo deployment.

Nunca coloque o token em `index.html`, `admin.html`, no JavaScript do navegador ou em repositório público. Se o token já apareceu em uma captura compartilhada, invalide-o/rotacione-o no portal antes de usar.

Documentação oficial: https://developer.pagbank.com.br/reference/criar-pedido-com-qr-code-pix-v2 e https://developer.pagbank.com.br/reference/webhooks.
