# KANEKI STORE — Login + painel do dono

Esta versão transforma a loja em uma aplicação Node.js simples com:
- cadastro e login de clientes;
- carrinho salvo por conta para não ser perdido;
- pedidos registrados no servidor;
- logs de login, cadastro e pedidos;
- painel `/admin` visível somente para a conta do dono;
- senha armazenada com `scrypt` e sessão assinada;
- QR PIX continua sendo gerado no checkout.
- Login social com Google e Discord.

## Como iniciar
1. Instale Node.js 18+.
2. Defina as variáveis `OWNER_EMAIL`, `OWNER_PASSWORD` e `SESSION_SECRET`.
3. Execute `npm start`.
4. Abra `http://localhost:3000`.
5. Crie uma conta usando o mesmo e-mail de `OWNER_EMAIL` para ela receber o papel `owner`.
6. O painel do dono fica em `http://localhost:3000/admin`.

### Importante
Não coloque este site em hospedagem somente de arquivos estáticos se quiser login e logs reais. O `server.js` precisa ficar rodando em um servidor Node.js.

O arquivo `data.json` é criado automaticamente e guarda usuários, carrinhos, pedidos e logs. Faça backup dele e, para uma loja maior, migre para PostgreSQL/MySQL.


V15: tela inicial com 5 catálogos: Frutas permanentes, Skins, Frutas físicas, Game Pass e Gacha Box.


## Supabase
O frontend já contém a configuração pública do projeto Supabase. Não coloque a Secret/Service Role Key no repositório. Configure-a somente como variável de ambiente no backend/Vercel.
