const crypto = require('crypto');
const { Pool } = require('pg');
const seed = require('../products_catalog_seed.json');

// Único e-mail autorizado a acessar o Painel do Dono.
const OWNER_EMAIL_FIXED = 'administradorsupreme@gmail.com';
const normalizeEmail = email => String(email || '').trim().toLowerCase();
const isOwnerEmail = email => normalizeEmail(email) === OWNER_EMAIL_FIXED;
const isStaffRole = role => ['owner','admin'].includes(String(role || '').toLowerCase());
const isOwnerSession = t => !!(t && isOwnerEmail(t.email) && t.role === 'owner' && t.provider === 'google');

const DATABASE_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_PRISMA_URL || '';
let DATABASE_CONNECTION_STRING = DATABASE_URL;
// Vercel/Supabase pode fornecer sslmode na própria URL. O pg pode usar esse
// parâmetro em preferência ao objeto ssl; removemos os parâmetros de SSL da URL
// e configuramos o SSL explicitamente para evitar SELF_SIGNED_CERT_IN_CHAIN.
try {
  if (DATABASE_CONNECTION_STRING) {
    const u = new URL(DATABASE_CONNECTION_STRING);
    ['sslmode','sslrootcert','sslcert','sslkey'].forEach(k => u.searchParams.delete(k));
    DATABASE_CONNECTION_STRING = u.toString();
  }
} catch (_) {}
const pool = DATABASE_CONNECTION_STRING
  ? new Pool({ connectionString: DATABASE_CONNECTION_STRING, max: 2, ssl: { rejectUnauthorized: false } })
  : null;

let schemaPromise;
const json = (res, status, body) => { res.status(status).setHeader('Content-Type','application/json; charset=utf-8'); return res.end(JSON.stringify(body)); };
const ok = (res, body) => json(res, 200, body);
const fail = (res, status, message) => json(res, status, { error: message });
const body = async req => { if (req.body && typeof req.body === 'object') return req.body; let raw=''; for await (const c of req) raw += c; try{return raw?JSON.parse(raw):{};}catch{return{};} };
const routeOf = req => {
  const q = String(req.query?.route || '').replace(/^\//,'');
  if (q) return q;
  const p = new URL(req.url || '/', 'http://localhost').pathname.replace(/^\//,'');
  if (p.startsWith('api/')) return p.slice(4);
  return p;
};
const baseUrl = req => (process.env.PUBLIC_BASE_URL || `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`).replace(/\/$/,'');

function signToken(payload){
  const secret=process.env.SESSION_SECRET;
  if(!secret) throw new Error('SESSION_SECRET não configurado na Vercel.');
  const data=Buffer.from(JSON.stringify({...payload,exp:Date.now()+1000*60*60*24*30})).toString('base64url');
  const sig=crypto.createHmac('sha256',secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verifyToken(token){
  if(!token || !process.env.SESSION_SECRET) return null;
  const [data,sig]=String(token).split('.'); if(!data||!sig) return null;
  try{
    const expected=crypto.createHmac('sha256',process.env.SESSION_SECRET).update(data).digest('base64url');
    const a=Buffer.from(sig), b=Buffer.from(expected);
    if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) return null;
    const p=JSON.parse(Buffer.from(data,'base64url').toString());
    return p.exp>Date.now()?p:null;
  }catch{return null;}
}
function auth(req){
  const h=String(req.headers.authorization||'');
  const bearer=h.startsWith('Bearer ')?h.slice(7):'';
  return verifyToken(bearer) || verifyToken((req.headers.cookie||'').match(/kaneki_session=([^;]+)/)?.[1]);
}
function setSession(res, token){res.setHeader('Set-Cookie',`kaneki_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);}
function inventorySecret(){return crypto.createHash('sha256').update(String(process.env.SESSION_SECRET||'inventory-secret')).digest();}
function encryptInventorySecret(value){const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',inventorySecret(),iv);const enc=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);const tag=cipher.getAuthTag();return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;}
function decryptInventorySecret(value){try{const [iv,tag,enc]=String(value||'').split('.');if(!iv||!tag||!enc)return '';const decipher=crypto.createDecipheriv('aes-256-gcm',inventorySecret(),Buffer.from(iv,'base64url'));decipher.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([decipher.update(Buffer.from(enc,'base64url')),decipher.final()]).toString('utf8');}catch{return '';}}

async function db(){
  if(!pool) throw new Error('PostgreSQL não configurado. Crie um banco PostgreSQL e adicione POSTGRES_URL nas Environment Variables da Vercel.');
  if(!schemaPromise) schemaPromise=(async()=>{
    await pool.query(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,phone TEXT DEFAULT '',password_hash TEXT,role TEXT NOT NULL DEFAULT 'customer',provider TEXT NOT NULL DEFAULT 'password',avatar_url TEXT DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS carts (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,cart JSONB NOT NULL DEFAULT '{}'::jsonb,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS products (product_id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',price NUMERIC NOT NULL,old_price NUMERIC NOT NULL DEFAULT 0,stock TEXT NOT NULL DEFAULT '0',image TEXT NOT NULL DEFAULT '',catalog TEXT NOT NULL DEFAULT 'produtos',active BOOLEAN NOT NULL DEFAULT TRUE,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS orders (id BIGSERIAL PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE SET NULL,order_key TEXT UNIQUE NOT NULL,items JSONB NOT NULL,total NUMERIC NOT NULL,name TEXT,email TEXT,phone TEXT,status TEXT NOT NULL DEFAULT 'pending',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS tickets (id BIGSERIAL PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,order_id BIGINT REFERENCES orders(id) ON DELETE CASCADE,subject TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS ticket_messages (id BIGSERIAL PRIMARY KEY,ticket_id BIGINT REFERENCES tickets(id) ON DELETE CASCADE,sender_role TEXT NOT NULL,name TEXT NOT NULL,message TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS logs (id BIGSERIAL PRIMARY KEY,action TEXT NOT NULL,email TEXT,at TIMESTAMPTZ NOT NULL DEFAULT NOW());\n      CREATE TABLE IF NOT EXISTS pix_orders (id BIGSERIAL PRIMARY KEY,order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,order_key TEXT UNIQUE NOT NULL,qr_code_id TEXT UNIQUE NOT NULL,amount NUMERIC NOT NULL,status TEXT NOT NULL DEFAULT 'PENDING',nick TEXT DEFAULT '',expires_at TIMESTAMPTZ,asaas_payment_id TEXT,event_id TEXT UNIQUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),paid_at TIMESTAMPTZ);
      CREATE TABLE IF NOT EXISTS pix_orders_event_guard (event_id TEXT PRIMARY KEY,received_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS inventory_accounts (id BIGSERIAL PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,login TEXT NOT NULL,password_encrypted TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS inventory_accounts_product_idx ON inventory_accounts(product_id);
      CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL DEFAULT '',updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS reviews (id BIGSERIAL PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE SET NULL,order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,rating INT NOT NULL CHECK(rating BETWEEN 1 AND 5),message TEXT NOT NULL,product_text TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(user_id,order_id));`);
    await pool.query("ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
    await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'password'");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT NOT NULL DEFAULT ''");
    const defaults={
      siteName:'KANEKI STORE', logoUrl:'images/kaneki-logo.png', backgroundImageUrl:'images/site-background-lilies.png', backgroundOpacity:'0.6', heroBackgroundUrl:'', heroMediaUrl:'', heroMediaType:'none', heroBannerEnabled:'false', heroBannerUrl:'', heroBannerType:'none', heroBannerHeight:'320', heroBannerPosition:'center', heroBannerObjectFit:'cover', heroBannerAutoplay:'true', heroBannerLoop:'true', heroBannerMuted:'true', heroBannerOverlay:'0.25', heroBannerLink:'', customCss:'', pixFee:'1.49', pixKeys:JSON.stringify([{id:'pix1',label:'PIX principal',key:'dina184513@gmail.com'}]), whatsappNumber:'5591985748541', heroTitle:'𝕮𝖔𝖒𝖕𝖗𝖊 𝖋𝖆𝖈𝖎𝖑, 𝖗𝖆𝖕𝖎𝖉𝖔 𝖊 𝖘𝖊𝖌𝖚𝖗𝖔!', heroAccent:'', heroDescription:'Contas, gamepasses e frutas para Blox Fruits, com pagamento seguro via Pix e informações de entrega antes da compra.', heroButton:'Ver catálogo', heroBadge1:'✓ LOJA OFICIAL', heroBadge2:'⚡ ENTREGA AUTOMÁTICA', tutorialTitle:'Clique aqui', tutorialSubtitle:'Assista como comprar na KANEKI STORE', tutorialVideoUrl:'https://youtu.be/7aMOurgDB-o?is=XG9LU3hscFktyKOs', discordUrl:'https://discord.com/', supportUrl:'', whatsappUrl:'', footerText:'© 2026 KANEKI STORE. Todos os direitos reservados.', categories_json:JSON.stringify([{id:'produtos',title:'Frutas permanentes',text:'Aqui você vai encontrar as melhores frutas permanentes',button:'Ver produtos',image:'',color:'#e21b23',active:true},{id:'skins',title:'Skins',text:'Aqui você vai encontrar as melhores skins de frutas',button:'Ver produtos',image:'',color:'#e21b23',active:true},{id:'frutasfisicas',title:'Frutas físicas',text:'Aqui você vai encontrar as melhores frutas físicas',button:'Ver produtos',image:'',color:'#e21b23',active:true},{id:'gamepass',title:'Game Pass',text:'Aqui você vai encontrar os melhores Game Pass',button:'Ver produtos',image:'',color:'#e21b23',active:true},{id:'gachabox',title:'Gacha Box',text:'Aqui você vai encontrar os melhores itens da Gacha Box',button:'Ver produtos',image:'',color:'#e21b23',active:true}]), primaryColor:'#e21b23', primaryDark:'#b91c1c', backgroundColor:'#070707', surfaceColor:'#ffffff', cardColor:'#111111', textColor:'#111111', mutedColor:'#6b6b76', accentText:'#ffffff'
    };
    for(const [k,v] of Object.entries(defaults)){await pool.query('INSERT INTO site_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING',[k,v]);}
    const count=await pool.query('SELECT COUNT(*)::int AS n FROM products');
    if(count.rows[0].n===0){for(const [id,p] of Object.entries(seed)){await pool.query(`INSERT INTO products(product_id,name,description,price,old_price,stock,image,catalog) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[id,p.name,p.description||'',p.price,p.old,String(p.stock),p.image||'',p.catalog||'produtos']);}}
  })().catch(e=>{schemaPromise=null;throw e;});
  await schemaPromise; return pool;
}

function hashPassword(password){const salt=crypto.randomBytes(16).toString('hex');const hash=crypto.scryptSync(String(password),salt,64).toString('hex');return `${salt}:${hash}`;}
function checkPassword(password,stored){try{const [salt,hash]=String(stored||'').split(':');const got=crypto.scryptSync(String(password),salt,64).toString('hex');return crypto.timingSafeEqual(Buffer.from(got,'hex'),Buffer.from(hash,'hex'));}catch{return false;}}
function publicUser(r){return {id:r.id,email:r.email,name:r.name,phone:r.phone||'',role:r.role,provider:r.provider||'password',avatarUrl:r.avatar_url||''};}
async function log(action,email=''){await pool.query('INSERT INTO logs(action,email) VALUES($1,$2)',[action,email||null]).catch(()=>{});}

async function catalog(res){
  if(!pool) return ok(res,{products:Object.entries(seed).map(([product_id,p])=>({product_id,...p,old:p.old,image:p.image||'',catalog:p.catalog||'produtos'}))});
  await db(); const q=await pool.query('SELECT product_id,name,description,price,old_price AS old,stock,image,catalog FROM products WHERE active=true ORDER BY product_id'); const rows=q.rows.map(p=>({...p,image:(String(p.image||'').startsWith('images/')?'':p.image)})); return ok(res,{products:rows});
}

async function me(req,res){const t=auth(req); if(!t) return ok(res,{user:null,cart:{}}); await db(); const u=await pool.query('SELECT * FROM users WHERE id=$1',[t.id]); if(!u.rowCount) return ok(res,{user:null,cart:{}}); const user=publicUser(u.rows[0]); const freshToken=signToken({id:u.rows[0].id,email:u.rows[0].email,role:u.rows[0].role,provider:u.rows[0].provider||'password'}); setSession(res,freshToken); const c=await pool.query('SELECT cart FROM carts WHERE user_id=$1',[t.id]); return ok(res,{user,token:freshToken,cart:c.rowCount?c.rows[0].cart:{}});}

async function loginRegister(req,res,isRegister){
  await db(); const b=await body(req); const email=String(b.email||'').trim().toLowerCase(), password=String(b.password||'');
  if(!email||!password) return fail(res,400,'Informe e-mail e senha.');
  const existing=await pool.query('SELECT * FROM users WHERE email=$1',[email]); let u;
  if(isRegister){
    if(existing.rowCount) return fail(res,409,'Este e-mail já está cadastrado.');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res,400,'E-mail inválido.');
    const owner=isOwnerEmail(email);
    if(owner && process.env.OWNER_PASSWORD && password!==process.env.OWNER_PASSWORD) return fail(res,403,'Para criar a conta do dono, use a senha configurada em OWNER_PASSWORD.');
    const id=crypto.randomUUID(); const role=owner?'owner':'customer';
    const r=await pool.query('INSERT INTO users(id,email,name,phone,password_hash,role,provider) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[id,email,String(b.name||email.split('@')[0]).slice(0,100),String(b.phone||'').slice(0,40),hashPassword(password),role,'password']); u=r.rows[0]; await log('register',email);
  }else{
    if(!existing.rowCount || !checkPassword(password,existing.rows[0].password_hash)) return fail(res,401,'E-mail ou senha incorretos.');
    u=existing.rows[0]; await log('login',email);
  }
  const token=signToken({id:u.id,email:u.email,role:u.role,provider:u.provider||'password'}); setSession(res,token); const c=await pool.query('SELECT cart FROM carts WHERE user_id=$1',[u.id]); return ok(res,{user:publicUser(u),token,cart:c.rowCount?c.rows[0].cart:{}});
}


async function updateProfile(req,res){
  const t=auth(req);
  if(!t)return fail(res,401,'Faça login para editar seu perfil.');
  await db();
  const b=await body(req);
  const name=String(b.name||'').trim().slice(0,100);
  const phone=String(b.phone||'').trim().slice(0,40);
  const avatarUrl=String(b.avatarUrl||'').trim().slice(0,1000);
  if(name.length<2)return fail(res,400,'Informe um nome válido.');
  if(avatarUrl && !/^(https?:\/\/|\/|images\/)/i.test(avatarUrl))return fail(res,400,'A foto do perfil precisa ser uma URL válida.');
  const r=await pool.query('UPDATE users SET name=$1,phone=$2,avatar_url=$3 WHERE id=$4 RETURNING *',[name,phone,avatarUrl,t.id]);
  if(!r.rowCount)return fail(res,404,'Conta não encontrada.');
  await log('profile_update',t.email);
  return ok(res,{ok:true,user:publicUser(r.rows[0])});
}

async function cart(req,res){const t=auth(req);if(!t)return fail(res,401,'Faça login para salvar o carrinho.');await db();const b=await body(req);await pool.query(`INSERT INTO carts(user_id,cart,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(user_id) DO UPDATE SET cart=EXCLUDED.cart,updated_at=NOW()`,[t.id,JSON.stringify(b.cart||{})]);return ok(res,{ok:true});}

async function orders(req,res){const t=auth(req);if(!t)return fail(res,401,'Faça login para registrar o pedido.');await db();const b=await body(req);const items=Array.isArray(b.items)?b.items:[];if(!items.length)return fail(res,400,'Carrinho vazio.');const orderKey=String(b.orderKey||crypto.randomUUID());const r=await pool.query(`INSERT INTO orders(user_id,order_key,items,total,name,email,phone) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[t.id,orderKey,JSON.stringify(items),Number(b.total||0),String(b.name||t.name||''),String(b.email||t.email||''),String(b.phone||'')]);await log('order',t.email);return ok(res,{orderId:r.rows[0].id,orderKey});}

async function myOrders(req,res){const t=auth(req);if(!t)return fail(res,401,'Faça login primeiro.');await db();const r=await pool.query('SELECT id,order_key,items,total,name,email,phone,status,created_at AS "createdAt" FROM orders WHERE user_id=$1 ORDER BY created_at DESC',[t.id]);return ok(res,{orders:r.rows});}

async function tickets(req,res){const t=auth(req);if(!t)return fail(res,401,'Faça login primeiro.');await db();if(req.method==='POST'){
  const b=await body(req);const o=await pool.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2',[b.orderId,t.id]);if(!o.rowCount)return fail(res,404,'Compra não encontrada.');
  const r=await pool.query('INSERT INTO tickets(user_id,order_id,subject) VALUES($1,$2,$3) RETURNING id',[t.id,b.orderId,String(b.subject||'Atendimento')]);await pool.query('INSERT INTO ticket_messages(ticket_id,sender_role,name,message) VALUES($1,$2,$3,$4)',[r.rows[0].id,'customer',t.email,String(b.message||'')]);
 }
 const isOwner=t.role==='owner'; const q=isOwner?await pool.query(`SELECT t.*,o.order_key,o.name AS customer_name,o.email FROM tickets t LEFT JOIN orders o ON o.id=t.order_id ORDER BY t.updated_at DESC`):await pool.query(`SELECT t.*,o.order_key,o.name AS customer_name,o.email FROM tickets t LEFT JOIN orders o ON o.id=t.order_id WHERE t.user_id=$1 ORDER BY t.updated_at DESC`,[t.id]);
 const out=[];for(const row of q.rows){const m=await pool.query('SELECT sender_role,name,message,created_at AS "createdAt" FROM ticket_messages WHERE ticket_id=$1 ORDER BY created_at',[row.id]);out.push({...row,messages:m.rows});}return ok(res,{tickets:out});}

async function ticketReply(req,res){const t=auth(req);if(!t)return fail(res,401,'Faça login primeiro.');await db();const b=await body(req);const q=['owner','admin'].includes(t.role)?await pool.query('SELECT * FROM tickets WHERE id=$1',[b.ticketId]):await pool.query('SELECT * FROM tickets WHERE id=$1 AND user_id=$2',[b.ticketId,t.id]);if(!q.rowCount)return fail(res,404,'Ticket não encontrado.');const role=t.role==='owner'?'owner':(t.role==='admin'?'admin':'customer');await pool.query('INSERT INTO ticket_messages(ticket_id,sender_role,name,message) VALUES($1,$2,$3,$4)',[b.ticketId,role,t.name||t.email,String(b.message||'')]);await pool.query('UPDATE tickets SET status=COALESCE($2,status),updated_at=NOW() WHERE id=$1',[b.ticketId,b.status||null]);return ok(res,{ok:true});}


async function adminTickets(req,res){
  const t=auth(req); if(!t || !['owner','admin'].includes(t.role)) return fail(res,403,'Acesso restrito aos administradores.');
  await db();
  const q=await pool.query(`SELECT t.*,o.order_key,o.name AS customer_name,o.email FROM tickets t LEFT JOIN orders o ON o.id=t.order_id ORDER BY t.updated_at DESC`);
  const out=[]; for(const row of q.rows){const m=await pool.query('SELECT sender_role,name,message,created_at AS "createdAt" FROM ticket_messages WHERE ticket_id=$1 ORDER BY created_at',[row.id]);out.push({...row,messages:m.rows});}
  return ok(res,{tickets:out});
}

async function adminRoles(req,res){
  const t=auth(req); if(!t || !isOwnerEmail(t.email) || t.role!=='owner' || t.provider!=='google') return fail(res,403,'Somente o dono pode gerenciar administradores.');
  await db(); const b=await body(req); const userId=String(b.userId||''); const action=String(b.action||'');
  if(!userId || !['grant','revoke'].includes(action)) return fail(res,400,'Dados inválidos.');
  const q=await pool.query('SELECT * FROM users WHERE id=$1',[userId]); if(!q.rowCount)return fail(res,404,'Usuário não encontrado.');
  if(isOwnerEmail(q.rows[0].email)) return fail(res,400,'O dono não pode perder o próprio acesso.');
  const role=action==='grant'?'admin':'customer';
  const u=await pool.query('UPDATE users SET role=$1 WHERE id=$2 RETURNING id,email,name,role',[role,userId]);
  await log(action==='grant'?'admin-grant':'admin-revoke',q.rows[0].email);
  return ok(res,{user:u.rows[0]});
}


async function reviews(req,res){
  await db();
  if(req.method==='GET'){
    const q=await pool.query(`SELECT r.id,r.rating,r.message,r.product_text AS "productText",r.created_at AS "createdAt",COALESCE(u.name,'Cliente verificado') AS name,COALESCE(u.avatar_url,'') AS "avatarUrl" FROM reviews r LEFT JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC LIMIT 60`);
    return ok(res,{reviews:q.rows});
  }
  const t=auth(req); if(!t)return fail(res,401,'Faça login para avaliar uma compra.');
  const b=await body(req); const rating=Math.max(1,Math.min(5,Number(b.rating||0))); const message=String(b.message||'').trim();
  if(!rating||!message)return fail(res,400,'Informe a nota e a avaliação.'); if(message.length>300)return fail(res,400,'A avaliação pode ter até 300 caracteres.');
  const orderId=b.orderId?Number(b.orderId):null;
  let order;
  if(orderId){const q=await pool.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2',[orderId,t.id]); if(!q.rowCount)return fail(res,404,'Pedido não encontrado.'); order=q.rows[0];}
  else {const q=await pool.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',[t.id]); if(!q.rowCount)return fail(res,400,'Faça uma compra antes de avaliar.'); order=q.rows[0];}
  const productText=(Array.isArray(order.items)?order.items:[]).map(i=>`${i.name||'Produto'}${i.qty>1?' × '+i.qty:''}`).join(', ').slice(0,220);
  const q=await pool.query(`INSERT INTO reviews(user_id,order_id,rating,message,product_text) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,order_id) DO UPDATE SET rating=EXCLUDED.rating,message=EXCLUDED.message,product_text=EXCLUDED.product_text RETURNING id`,[t.id,order.id,rating,message,productText]);
  await log('review',t.email); return ok(res,{ok:true,reviewId:q.rows[0].id});
}

async function robloxLookup(req,res){
  const username=String(req.query?.username||'').trim();
  if(!username)return fail(res,400,'Informe o usuário do Roblox.');
  if(username.length>40)return fail(res,400,'Usuário inválido.');
  try{
    const ur=await fetch('https://users.roblox.com/v1/usernames/users',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({usernames:[username],excludeBannedUsers:false})});
    const uraw=await ur.text(); let ud={}; try{ud=JSON.parse(uraw)}catch{return fail(res,502,'O Roblox retornou uma resposta inválida.')}
    if(!ur.ok)return fail(res,502,'O Roblox não respondeu.');
    const user=ud?.data?.[0]; if(!user)return fail(res,404,'Usuário do Roblox não encontrado.');
    const tr=await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(user.id)}&size=150x150&format=Png&isCircular=false`,{headers:{Accept:'application/json'}});
    const traw=await tr.text(); let td={}; try{td=JSON.parse(traw)}catch{}
    const thumb=td?.data?.[0];
    return ok(res,{id:user.id,name:user.name,displayName:user.displayName,avatarUrl:thumb?.imageUrl||''});
  }catch(e){return fail(res,502,'Não foi possível consultar o Roblox agora.');}
}

async function siteSettings(res){
  // As configurações do site nunca devem ser servidas do cache do navegador/CDN.
  // O painel salva no PostgreSQL e a loja precisa ler imediatamente a versão persistida.
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma','no-cache');
  res.setHeader('Expires','0');
  if(!pool) return ok(res,{settings:{}});
  await db(); const q=await pool.query('SELECT key,value FROM site_settings ORDER BY key'); const settings={}; for(const r of q.rows) settings[r.key]=r.value; return ok(res,{settings});
}
async function adminSettings(req,res){
  try{
    const t=auth(req); if(!isStaffRole(t?.role)) return fail(res,403,'Acesso restrito aos administradores autorizados pelo dono.');
    await db();
    const b=await body(req);
    const allowed=['siteName','logoUrl','backgroundImageUrl','backgroundOpacity','heroBackgroundUrl','heroMediaUrl','heroMediaType','heroBannerEnabled','heroBannerUrl','heroBannerType','heroBannerHeight','heroBannerPosition','heroBannerObjectFit','heroBannerAutoplay','heroBannerLoop','heroBannerMuted','heroBannerOverlay','heroBannerLink','customCss','pixFee','pixKeys','whatsappNumber','heroTitle','heroAccent','heroDescription','heroButton','heroBadge1','heroBadge2','tutorialTitle','tutorialSubtitle','tutorialVideoUrl','discordUrl','supportUrl','whatsappUrl','footerText','categories_json','primaryColor','primaryDark','backgroundColor','surfaceColor','cardColor','textColor','mutedColor','accentText',...Object.keys(b||{}).filter(k=>k.startsWith('content_')||k.startsWith('visible_')||k.startsWith('link_')||k.startsWith('image_')||k.startsWith('button_'))];
    for(const key of allowed){ if(b[key]!==undefined) await pool.query('INSERT INTO site_settings(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()',[key,String(b[key]??'')]); }
    await log('site-settings-update',t.email);
    return ok(res,{ok:true});
  }catch(e){
    console.error('adminSettings:',e);
    return fail(res,500,`Falha ao salvar as configurações: ${e?.message||e}`);
  }
}
async function inventoryRows(){
  const q=await pool.query('SELECT id,product_id,login,created_at AS "addedAt" FROM inventory_accounts ORDER BY created_at ASC,id ASC');
  return q.rows;
}
async function adminSummary(req,res){
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');res.setHeader('Pragma','no-cache');res.setHeader('Expires','0');
  const t=auth(req);if(!isStaffRole(t?.role)) return fail(res,403,'Acesso restrito aos administradores autorizados pelo dono.');
  await db();
  const [u,o,tic,p,l,ia]=await Promise.all([
    pool.query('SELECT id,email,name,role,created_at AS "createdAt" FROM users ORDER BY created_at DESC'),
    pool.query('SELECT id,order_key,items,total,name,email,phone,status,created_at AS "createdAt" FROM orders ORDER BY created_at DESC'),
    pool.query('SELECT id,status FROM tickets ORDER BY updated_at DESC'),
    pool.query('SELECT product_id,name,description,price,old_price AS old,stock,image,catalog,active FROM products ORDER BY product_id'),
    pool.query('SELECT action,email,at FROM logs ORDER BY at DESC LIMIT 200'),
    inventoryRows()
  ]);
  const accountsByProduct={};
  for(const row of ia)(accountsByProduct[row.product_id]??=[]).push({id:row.id,login:row.login,addedAt:row.addedAt});
  for(const product of p.rows) product.inventoryAccounts=accountsByProduct[product.product_id]||[];
  const sq=await pool.query('SELECT key,value FROM site_settings'); const settings={}; for(const r of sq.rows) settings[r.key]=r.value;
  return ok(res,{users:u.rows,orders:o.rows,tickets:tic.rows,products:p.rows,logs:l.rows,settings});
}
async function adminProduct(req,res,del=false){
  const t=auth(req);if(!isStaffRole(t?.role)) return fail(res,403,'Acesso restrito aos administradores autorizados pelo dono.');
  await db();const b=await body(req);
  if(del){if(!isOwnerSession(t)) return fail(res,403,'Somente o dono pode excluir ou desativar produtos.');await pool.query('UPDATE products SET active=false,updated_at=NOW() WHERE product_id=$1',[b.productId]);return ok(res,{ok:true});}
  await pool.query(`INSERT INTO products(product_id,name,description,price,old_price,stock,image,catalog,active,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) ON CONFLICT(product_id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,price=EXCLUDED.price,old_price=EXCLUDED.old_price,stock=EXCLUDED.stock,image=EXCLUDED.image,catalog=EXCLUDED.catalog,active=EXCLUDED.active,updated_at=NOW()`,[String(b.productId),String(b.name),String(b.description||''),Number(b.price||0),Number(b.old||0),String(b.stock),String(b.image||''),String(b.catalog||'produtos'),b.active!==false]);return ok(res,{ok:true});
}
async function adminInventory(req,res,del=false){
  const t=auth(req);if(!isStaffRole(t?.role)) return fail(res,403,'Acesso restrito aos administradores autorizados pelo dono.');
  await db();const b=await body(req);const productId=String(b.productId||'').trim();
  if(!productId)return fail(res,400,'Produto inválido.');
  const product=await pool.query('SELECT product_id,stock FROM products WHERE product_id=$1',[productId]);if(!product.rowCount)return fail(res,404,'Produto não encontrado.');
  if(del){
    const id=Number(b.id||0);if(!id)return fail(res,400,'Conta de estoque inválida.');
    await pool.query('DELETE FROM inventory_accounts WHERE id=$1 AND product_id=$2',[id,productId]);
  }else{
    const login=String(b.login||'').trim();const password=String(b.password||'');
    if(!login||!password)return fail(res,400,'Informe o nick e a senha da conta.');
    if(login.length>120||password.length>300)return fail(res,400,'Nick ou senha muito longos.');
    await pool.query('INSERT INTO inventory_accounts(product_id,login,password_encrypted) VALUES($1,$2,$3)',[productId,login,encryptInventorySecret(password)]);
  }
  const count=await pool.query('SELECT COUNT(*)::int AS count FROM inventory_accounts WHERE product_id=$1',[productId]);
  const stock=String(product.rows[0].stock)==='∞'?'∞':String(count.rows[0].count);
  await pool.query('UPDATE products SET stock=$1,updated_at=NOW() WHERE product_id=$2',[stock,productId]);
  const rows=await pool.query('SELECT id,product_id,login,created_at AS "addedAt" FROM inventory_accounts WHERE product_id=$1 ORDER BY created_at ASC,id ASC',[productId]);
  return ok(res,{ok:true,stock,inventoryAccounts:rows.rows});
}

async function oauthStart(req,res,provider){
  const cfg=provider==='google'
    ? {id:process.env.GOOGLE_CLIENT_ID,auth:'https://accounts.google.com/o/oauth2/v2/auth',scope:'openid email profile'}
    : {id:process.env.DISCORD_CLIENT_ID,auth:'https://discord.com/oauth2/authorize',scope:'identify email'};
  if(!cfg.id)return fail(res,500,`${provider.toUpperCase()}_CLIENT_ID não configurado na Vercel.`);
  if(!process.env.SESSION_SECRET)return fail(res,500,'SESSION_SECRET não configurado na Vercel.');
  const state=crypto.randomBytes(24).toString('hex');
  // OAuth returns to this site from accounts.google.com/discord.com.
  // Use SameSite=None so the state cookie is reliably sent on the OAuth callback.
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Set-Cookie',`oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=600`);
  const u=new URL(cfg.auth);
  u.searchParams.set('client_id',cfg.id);
  u.searchParams.set('redirect_uri',`${baseUrl(req)}/api/oauth/${provider}/callback`);
  u.searchParams.set('response_type','code');
  u.searchParams.set('scope',cfg.scope);
  u.searchParams.set('state',state);
  if(provider==='google'){
    u.searchParams.set('access_type','online');
    u.searchParams.set('prompt','select_account');
    u.searchParams.set('include_granted_scopes','true');
  }
  return res.writeHead(302,{Location:u.toString()}).end();
}
async function oauthCallback(req,res,provider){
  const q=req.query||{};
  res.setHeader('Cache-Control','no-store');
  const cookieHeader=String(req.headers.cookie||'');
  const stateCookie=cookieHeader.match(/(?:^|;\s*)oauth_state=([^;]+)/)?.[1];
  const decodedState=stateCookie ? decodeURIComponent(stateCookie) : '';
  if(!q.state||q.state!==decodedState)return fail(res,400,'Estado OAuth inválido. Tente novamente.');
  const code=String(q.code||'');
  if(!code)return fail(res,400,q.error_description||'Código OAuth ausente.');
  const redirect=`${baseUrl(req)}/api/oauth/${provider}/callback`;
  let profile;
  if(provider==='google'){
    if(!process.env.GOOGLE_CLIENT_SECRET)return fail(res,500,'GOOGLE_CLIENT_SECRET não configurado na Vercel.');
    const tr=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,redirect_uri:redirect,grant_type:'authorization_code'})});
    const tok=await tr.json().catch(()=>({}));
    if(!tr.ok || !tok.access_token)return fail(res,502,'Google recusou o login OAuth.');
    const pr=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${tok.access_token}`}});
    profile=await pr.json().catch(()=>({}));
    if(!pr.ok)return fail(res,502,'Não foi possível obter os dados da conta Google.');
    if(profile.email_verified===false)return fail(res,400,'A conta Google precisa ter o e-mail verificado.');
  }else{
    if(!process.env.DISCORD_CLIENT_SECRET)return fail(res,500,'DISCORD_CLIENT_SECRET não configurado na Vercel.');
    const tr=await fetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:process.env.DISCORD_CLIENT_ID,client_secret:process.env.DISCORD_CLIENT_SECRET,redirect_uri:redirect,grant_type:'authorization_code'})});
    const tok=await tr.json().catch(()=>({}));
    if(!tr.ok || !tok.access_token)return fail(res,502,'Discord recusou o login OAuth.');
    const pr=await fetch('https://discord.com/api/users/@me',{headers:{Authorization:`Bearer ${tok.access_token}`}});
    profile=await pr.json().catch(()=>({}));
    if(!pr.ok)return fail(res,502,'Não foi possível obter os dados da conta Discord.');
  }
  const email=normalizeEmail(profile.email);
  if(!email)return fail(res,400,'O provedor não retornou um e-mail.');
  await db();
  let u=await pool.query('SELECT * FROM users WHERE email=$1',[email]);
  const providerName=provider;
  const name=String(profile.name||profile.global_name||email.split('@')[0]).slice(0,100);
  const avatar=String(profile.picture||profile.avatar_url||'');
  if(!u.rowCount){
    const id=crypto.randomUUID();
    const owner=isOwnerEmail(email);
    u=await pool.query('INSERT INTO users(id,email,name,phone,role,provider,avatar_url) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[id,email,name,'',owner?'owner':'customer',providerName,avatar]);
  }else{
    u=await pool.query("UPDATE users SET provider=$2, avatar_url=CASE WHEN $3<>'' THEN $3 ELSE avatar_url END, name=COALESCE(NULLIF($4,''),name) WHERE id=$1 RETURNING *",[u.rows[0].id,providerName,avatar,name]);
    if(isOwnerEmail(email) && u.rows[0].role!=='owner')u=await pool.query("UPDATE users SET role='owner' WHERE id=$1 RETURNING *",[u.rows[0].id]);
  }
  const token=signToken({id:u.rows[0].id,email:u.rows[0].email,role:u.rows[0].role,provider:providerName});
  res.setHeader('Set-Cookie',[`kaneki_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,`oauth_state=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`]);
  await log(`oauth_${provider}`,email);
  return res.writeHead(302,{Location:`${baseUrl(req)}/?login=success`}).end();
}


const PIX_DEFAULT_KEY = 'dina184513@gmail.com';
const PIX_MERCHANT_NAME = 'KANEKI STORE';
const PIX_MERCHANT_CITY = 'BELEM';

function tlv(id, value){
  const v=String(value);
  return `${id}${String(v.length).padStart(2,'0')}${v}`;
}

function crc16CcittFalse(text){
  let crc=0xFFFF;
  for(let i=0;i<text.length;i++){
    crc ^= text.charCodeAt(i) << 8;
    for(let bit=0;bit<8;bit++){
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4,'0');
}

function buildPixPayload(amount, pixKey, orderKey=''){
  const amountText=Number(amount).toFixed(2);
  const merchantAccountInformation =
    tlv('00','BR.GOV.BCB.PIX') +
    tlv('01',String(pixKey||PIX_DEFAULT_KEY));

  const additionalData = tlv('05','***');

  const payload =
    tlv('00','01') +
    tlv('01','11') +
    tlv('26',merchantAccountInformation) +
    tlv('52','0000') +
    tlv('53','986') +
    tlv('54',amountText) +
    tlv('58','BR') +
    tlv('59',PIX_MERCHANT_NAME) +
    tlv('60',PIX_MERCHANT_CITY) +
    tlv('62',additionalData) +
    '6304';

  return payload + crc16CcittFalse(payload);
}

async function trustedItems(rawItems){
  const items=Array.isArray(rawItems)?rawItems:[];
  if(!items.length) throw new Error('Carrinho vazio.');
  if(items.length>50) throw new Error('Carrinho inválido.');
  const out=[];
  for(const raw of items){
    const id=String(raw?.id||'').trim();
    const qty=Math.max(1,Math.min(99,Math.floor(Number(raw?.qty||1))));
    if(!id || !Number.isFinite(qty)) throw new Error('Item inválido.');
    let p=null;
    if(pool){
      try{
        await db();
        const q=await pool.query('SELECT product_id,name,price,image,catalog FROM products WHERE product_id=$1 AND active=true',[id]);
        if(q.rowCount) p=q.rows[0];
      }catch{}
    }
    if(!p && seed[id]) p={product_id:id,name:seed[id].name,price:seed[id].price,image:seed[id].image||'',catalog:seed[id].catalog||'produtos'};
    if(!p) throw new Error(`Produto não encontrado: ${id}`);
    out.push({id:p.product_id,name:p.name,price:Number(p.price),image:p.image||'',catalog:p.catalog||'',qty});
  }
  return out;
}

async function getPixSettings(){
  const q=await pool.query("SELECT key,value FROM site_settings WHERE key IN ('pixKeys','pixFee')");
  const out={}; for(const r of q.rows) out[r.key]=r.value;
  let keys=[];
  try{keys=JSON.parse(String(out.pixKeys||'[]'));}catch{}
  keys=(Array.isArray(keys)?keys:[]).map((x,i)=>({id:String(x?.id||('pix'+(i+1))),label:String(x?.label||('PIX '+(i+1))),key:String(x?.key||'').trim()})).filter(x=>x.key);
  if(!keys.length) keys=[{id:'pix1',label:'PIX principal',key:PIX_DEFAULT_KEY}];
  const fee=Math.max(0,Number(out.pixFee||1.49)||0);
  return {keys,fee};
}

async function createPix(req,res){
  try{
    if(req.method!=='POST') return fail(res,405,'Método não permitido.');
    await db();
    const b=await body(req);
    const items=await trustedItems(b.items);
    const subtotal=items.reduce((sum,i)=>sum+i.price*i.qty,0);
    const pixConfig=await getPixSettings();
    const selectedPixKey=String(b.pixKey||'').trim();
    const chosen=pixConfig.keys.find(k=>k.key===selectedPixKey) || (pixConfig.keys.length===1?pixConfig.keys[0]:null);
    if(!chosen) return fail(res,400,'Escolha uma chave PIX válida para receber o pagamento.');
    const fee=pixConfig.fee;
    const amount=Number((subtotal+fee).toFixed(2));
    if(!Number.isFinite(amount) || amount<=0) return fail(res,400,'Valor do pedido inválido.');
    const orderKey=String(b.orderKey||crypto.randomUUID()).replace(/[^A-Za-z0-9_-]/g,'').slice(0,60) || `PED-${crypto.randomUUID()}`;
    const nick=String(b.nick||'').trim().slice(0,100);
    const t=auth(req);
    const order=await pool.query(
      `INSERT INTO orders(user_id,order_key,items,total,name,email,phone,status) VALUES($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id,order_key`,
      [t?.id||null,orderKey,JSON.stringify(items),amount,String(b.name||t?.name||nick||'Cliente'),String(b.email||t?.email||''),String(b.phone||'')]
    );
    const orderId=order.rows[0].id;
    const payload=buildPixPayload(amount,chosen.key,orderKey);
    const expiresAt=new Date(Date.now()+1799*1000).toISOString();

    await pool.query(
      `INSERT INTO pix_orders(order_id,order_key,qr_code_id,amount,status,nick,expires_at) VALUES($1,$2,$3,$4,'PENDING',$5,$6)`,
      [orderId,orderKey,orderKey,amount,nick,expiresAt]
    );

    return ok(res,{ok:true,orderId,orderKey,qrCodeId:orderKey,amount,fee,subtotal,payload,qrImage:'',expiresAt,pixKey:chosen.key,pixKeyLabel:chosen.label});
  }catch(e){
    console.error('createPix',e);
    return fail(res,e.status||500,e.message||'Erro ao gerar PIX.');
  }
}

async function pixStatus(req,res){
  try{
    await db();
    const key=String(req.query?.orderKey||'').trim();
    if(!key) return fail(res,400,'orderKey obrigatório.');
    const q=await pool.query(`SELECT p.order_key,p.status,p.amount,p.expires_at AS "expiresAt",p.paid_at AS "paidAt",o.status AS "orderStatus" FROM pix_orders p LEFT JOIN orders o ON o.id=p.order_id WHERE p.order_key=$1 LIMIT 1`,[key]);
    if(!q.rowCount)return fail(res,404,'Pedido PIX não encontrado.');
    const row=q.rows[0];
    if(row.status==='PENDING' && row.expiresAt && new Date(row.expiresAt).getTime()<=Date.now()){
      await pool.query(`UPDATE pix_orders SET status='expired' WHERE order_key=$1 AND status='PENDING'`,[key]);
      row.status='expired';
    }
    return ok(res,{ok:true,...row});
  }catch(e){return fail(res,500,e.message||'Erro ao consultar PIX.');}
}


async function ensureStorageBucket(){
  const base=process.env.SUPABASE_URL.replace(/\/$/,'');
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers={Authorization:`Bearer ${key}`,apikey:key};
  const check=await fetch(`${base}/storage/v1/bucket/kaneki-assets`,{headers});
  if(check.ok) return;
  const checkTxt=await check.text().catch(()=> '');
  // A API do Storage pode responder HTTP 400/404 com um corpo que informa
  // NoSuchBucket. Nesse caso o bucket simplesmente não existe e devemos criá-lo.
  const bucketMissing = check.status===404 || /NoSuchBucket|Bucket not found|Bucket\s+not found/i.test(checkTxt);
  if(!bucketMissing){
    throw Error(`Não foi possível verificar o bucket kaneki-assets: ${checkTxt||check.statusText}`);
  }
  const create=await fetch(`${base}/storage/v1/bucket`,{
    method:'POST',
    headers:{...headers,'Content-Type':'application/json'},
    body:JSON.stringify({
      id:'kaneki-assets',
      name:'kaneki-assets',
      public:true,
      file_size_limit:10485760,
      allowed_mime_types:[
        'image/png','image/jpeg','image/webp','image/gif',
        'video/mp4','video/webm','audio/mpeg','audio/mp3','audio/wav','audio/ogg','audio/webm','audio/mp4'
      ]
    })
  });
  if(!create.ok && create.status!==409){
    const txt=await create.text().catch(()=> '');
    throw Error(`Não foi possível criar o bucket kaneki-assets: ${txt||create.statusText}`);
  }
}

async function adminUpload(req,res){
  const t=auth(req);
  if(!isStaffRole(t?.role)) return fail(res,403,'Acesso restrito aos administradores autorizados pelo dono.');
  if(!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return fail(res,500,'SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY precisam estar configurados.');
  const b=await body(req);
  const data=String(b.data||'');
  const filename=String(b.filename||'arquivo').replace(/[^a-zA-Z0-9._-]/g,'_');
  const mime=String(b.mime||'application/octet-stream').slice(0,120);
  const folder=String(b.folder||'site').replace(/[^a-zA-Z0-9_-]/g,'_');
  const m=data.match(/^data:([^;,]+);base64,(.+)$/s);
  if(!m) return fail(res,400,'Arquivo inválido. Envie um data URL base64.');
  const buf=Buffer.from(m[2],'base64');
  if(buf.length>10*1024*1024) return fail(res,413,'Arquivo acima de 10 MB.');
  const path=`${folder}/${Date.now()}-${crypto.randomUUID()}-${filename}`;
  try{
    await ensureStorageBucket();
  }catch(e){
    return fail(res,502,`Falha ao preparar o Supabase Storage: ${e.message||e}`);
  }
  const url=`${process.env.SUPABASE_URL.replace(/\/$/,'')}/storage/v1/object/kaneki-assets/${path}`;
  const r=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':mime,'x-upsert':'true'},body:buf});
  if(!r.ok){const txt=await r.text().catch(()=> ''); return fail(res,502,`Falha no Supabase Storage: ${txt||r.statusText}`);}
  const publicUrl=`${process.env.SUPABASE_URL.replace(/\/$/,'')}/storage/v1/object/public/kaneki-assets/${path}`;
  await log(`storage_upload:${folder}`,t.email);
  return ok(res,{ok:true,url:publicUrl,path});
}

module.exports = async (req,res) => {
 try{
  const route=routeOf(req);
  if(route==='catalog' && req.method==='GET') return catalog(res);
  if(route==='me' && req.method==='GET') return me(req,res);
  if(route==='login' && req.method==='POST') return loginRegister(req,res,false);
  if(route==='profile' && req.method==='POST') return updateProfile(req,res);
  if(route==='register' && req.method==='POST') return loginRegister(req,res,true);
  if(route==='logout' && req.method==='POST'){ res.setHeader('Set-Cookie','kaneki_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'); return ok(res,{ok:true}); }
  if(route==='cart' && req.method==='POST') return cart(req,res);
  if(route==='orders' && req.method==='POST') return orders(req,res);
  if(route==='create-pix' && req.method==='POST') return createPix(req,res);
  if(route==='pix-status' && req.method==='GET') return pixStatus(req,res);
  if(route==='my-orders' && req.method==='GET') return myOrders(req,res);
  if(route==='tickets' && (req.method==='GET'||req.method==='POST')) return tickets(req,res);
  if(route==='tickets/reply' && req.method==='POST') return ticketReply(req,res);
  if(route==='reviews' && (req.method==='GET'||req.method==='POST')) return reviews(req,res);
  if(route==='roblox/lookup' && req.method==='GET') return robloxLookup(req,res);
  if(route==='admin/tickets' && req.method==='GET') return adminTickets(req,res);
  if(route==='admin/roles' && req.method==='POST') return adminRoles(req,res);
  if(route==='admin/summary' && req.method==='GET') return adminSummary(req,res);
  if(route==='admin/inventory' && req.method==='POST') return adminInventory(req,res,false);
  if(route==='admin/inventory-delete' && req.method==='POST') return adminInventory(req,res,true);
  if(route==='admin/product' && req.method==='POST') return adminProduct(req,res,false);
  if(route==='admin/product-delete' && req.method==='POST') return adminProduct(req,res,true);
  if(route==='site-settings' && req.method==='GET') return siteSettings(res);
  if(route==='admin/settings' && req.method==='POST') return adminSettings(req,res);
  if(route==='admin/upload' && req.method==='POST') return adminUpload(req,res);
  const m=route.match(/^oauth\/(google|discord)(?:\/callback)?$/); if(m){const provider=m[1];return route.endsWith('/callback')?oauthCallback(req,res,provider):oauthStart(req,res,provider);}
  return fail(res,404,'Rota da API não encontrada.');
 }catch(e){console.error(e);return fail(res,500,e.message||'Erro interno do servidor.');}
};