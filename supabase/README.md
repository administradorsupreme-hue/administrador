# KANEKI STORE + Supabase

## 1. SQL
No Supabase, abra **SQL Editor**, cole o conteúdo de `kaneki_store.sql` e execute.

O SQL cria as tabelas usadas pelo painel, garante `administradorsupreme@gmail.com` como `owner`, ativa RLS e cria o bucket público `kaneki-assets` para as imagens da loja.

## 2. Vercel
O projeto ainda usa a API Node existente, mas o banco passa a ser o PostgreSQL do Supabase. No projeto da Vercel, configure:

- `POSTGRES_URL` = connection string do Supabase (Dashboard > Connect). Para funções serverless, use a conexão/pooler indicada pelo Supabase para seu projeto.
- `SESSION_SECRET` = uma senha aleatória longa.
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `PUBLIC_BASE_URL` = domínio da loja
- `SUPABASE_URL` = `https://SEU-PROJETO.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` = chave secreta do backend

**Nunca coloque `SUPABASE_SERVICE_ROLE_KEY` no `index.html` ou `admin.html`.**

## 3. Imagens
O Painel do Dono envia as imagens para o endpoint `/api/admin/upload`. O backend coloca os arquivos no bucket `kaneki-assets` e salva a URL pública nas configurações/produtos/categorias.

## 4. Dono
O painel continua aceitando somente:

`administradorsupreme@gmail.com`

com `role = owner` e login Google.
