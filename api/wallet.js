import {createClient} from '@supabase/supabase-js';
import {randomUUID} from 'node:crypto';
import {verifyWalletDeposit} from './_lib/wallet-payment.js';
import {sendOrderEmail} from './_lib/order-delivery.js';

const send=(res,code,data)=>res.status(code).json(data);
const PIX_LIFETIME_MS=15*60*1000;
const validUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-CCGWallet-API','2026-10-28-r2');
 if(!['GET','POST'].includes(req.method))return send(res,405,{error:'Método inválido'});
 // Consulta pública e restrita de avatar Roblox, reutilizando a rota existente.
 if(req.method==='GET'&&req.query?.action==='robloxAvatar'){
   const nick=String(req.query?.nick||'').trim();
   if(!/^[A-Za-z0-9_]{3,20}$/.test(nick))return send(res,400,{error:'Nick inválido'});
   res.setHeader('Cache-Control','public, s-maxage=120, stale-while-revalidate=300');
   try{
     const lookup=await fetch('https://users.roblox.com/v1/usernames/users',{
       method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},
       body:JSON.stringify({usernames:[nick],excludeBannedUsers:false}),signal:AbortSignal.timeout(7500)
     });
     if(!lookup.ok)throw Error('Falha na consulta do Roblox ('+lookup.status+')');
     const users=await lookup.json();
     const account=(users.data||[]).find(x=>String(x.name||'').toLowerCase()===nick.toLowerCase());
     if(!account)return send(res,404,{error:'Usuário não encontrado'});
     const photoResponse=await fetch('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds='+encodeURIComponent(account.id)+'&size=150x150&format=Png&isCircular=false',{signal:AbortSignal.timeout(7500)});
     if(!photoResponse.ok)throw Error('Falha ao buscar imagem ('+photoResponse.status+')');
     const photoJson=await photoResponse.json();
     const photo=photoJson.data?.find(x=>Number(x.targetId)===Number(account.id));
     const imageUrl=photo?.imageUrl||null;
     if(imageUrl&&!/^https:\/\/[a-z0-9.-]+\.rbxcdn\.com\//i.test(imageUrl)&&!/^https:\/\/tr\.rbxcdn\.com\//i.test(imageUrl))throw Error('Endereço de imagem inválido');
     return send(res,200,{id:account.id,name:account.name,displayName:account.displayName||account.name,imageUrl,photoStatus:photo?.state||''});
   }catch(e){console.error('robloxAvatar',e.message);return send(res,502,{error:'Roblox temporariamente indisponível'});}
 }
 // Este teste público informa apenas se a rota está publicada, sem expor saldos ou chaves.
 if(req.method==='GET'&&req.query?.action==='health')return send(res,200,{ok:true,service:'CCGWallet',version:'2026-10-28-r2'});
 let body={};
 if(req.method==='POST'){
   try{body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};}
   catch{return send(res,400,{error:'JSON inválido'});}
   if(!body||typeof body!=='object'||Array.isArray(body))return send(res,400,{error:'Corpo da requisição inválido'});
 }
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,ECLIPSE_API_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return send(res,503,{error:'Configure as credenciais do Supabase'});
 const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 if(!token)return send(res,401,{error:'Entre na sua conta'});
 const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data:auth,error:authError}=await db.auth.getUser(token);
 const user=auth?.user;
 if(authError||!user)return send(res,401,{error:'Sessão inválida'});
 const action=String(req.method==='GET'?req.query?.action||'balance':body.action||'');
 const query=async q=>{const {data,error}=await q;if(error)throw Error(error.message);return data;};
 try{
   if(action==='balance'){
     await query(db.from('kaneki_wallets').upsert({user_id:user.id},{onConflict:'user_id',ignoreDuplicates:true}));
     const [wallet,config,transactions,deposits]=await Promise.all([
       query(db.from('kaneki_wallets').select('balance_cents,max_override_cents').eq('user_id',user.id).single()),
       query(db.from('kaneki_wallet_config').select('default_max_cents').eq('id',true).single()),
       query(db.from('kaneki_wallet_ledger').select('id,amount_cents,kind,detail,created_at').eq('user_id',user.id).order('created_at',{ascending:false}).limit(25)),
       query(db.from('kaneki_wallet_deposits').select('id,credit_cents,charge_cents,status,created_at').eq('user_id',user.id).in('status',['credited','needs_review']).order('created_at',{ascending:false}).limit(10))
     ]);
     const balanceCents=Number(wallet.balance_cents);
     const maxBalanceCents=Number(wallet.max_override_cents??config.default_max_cents);
     if(!Number.isSafeInteger(balanceCents)||balanceCents<0||!Number.isSafeInteger(maxBalanceCents)||maxBalanceCents<0){
       throw Error('Dados da carteira inconsistentes no Supabase');
     }
     return send(res,200,{balanceCents,maxBalanceCents,transactions,deposits});
   }
   if(action==='depositStatus'){
     const id=String(req.query.depositId||'');
     if(!validUuid.test(id))return send(res,400,{error:'Depósito inválido'});
     const deposit=await query(db.from('kaneki_wallet_deposits').select('*').eq('id',id).eq('user_id',user.id).maybeSingle());
     if(!deposit)return send(res,404,{error:'Depósito não encontrado'});
     let status=deposit.status;
     if(status==='pending'||status==='needs_review')status=await verifyWalletDeposit(db,deposit);
     const expiresAt=new Date(new Date(deposit.created_at).getTime()+PIX_LIFETIME_MS).toISOString();
     const expired=Date.now()>=Date.parse(expiresAt)&&status==='pending';
     if(expired)await query(db.from('kaneki_wallet_deposits').update({status:'expired',updated_at:new Date().toISOString()}).eq('id',id).eq('user_id',user.id).eq('status','pending'));
     await query(db.from('kaneki_wallets').upsert({user_id:user.id},{onConflict:'user_id',ignoreDuplicates:true}));
     const wallet=await query(db.from('kaneki_wallets').select('balance_cents').eq('user_id',user.id).single());
     return send(res,200,{status:expired?'expired':status,balanceCents:Number(wallet.balance_cents),depositId:id,expiresAt});
   }
   if(req.method!=='POST')return send(res,400,{error:'Ação inválida'});
   if(action==='cancelDeposit'){
     const id=String(body.depositId||'');
     if(!validUuid.test(id))return send(res,400,{error:'Depósito inválido'});
     const deposit=await query(db.from('kaneki_wallet_deposits').select('*').eq('id',id).eq('user_id',user.id).maybeSingle());
     if(!deposit)return send(res,404,{error:'Depósito não encontrado'});
     let current=deposit.status;
     if(current==='pending'&&deposit.provider_charge_id)current=await verifyWalletDeposit(db,deposit);
     if(current!=='pending')return send(res,409,{error:current==='credited'?'Pix já pago. Não é possível cancelar.':'Cobrança não está pendente.',status:current});
     // Apenas abandona a cobrança na loja; o provedor pode ainda receber Pix.
     // Sem endpoint confirmado de cancelamento da EclipsePay: apenas abandona a visualização.
     // Manter o registro pendente permite reconciliar eventual pagamento tardio.
     await query(db.from('kaneki_wallet_deposits').update({status:'cancelled',updated_at:new Date().toISOString()}).eq('id',id).eq('user_id',user.id).eq('status','pending'));
     return send(res,200,{status:'cancelled',depositId:id,providerCancelled:false,notice:'A tela foi encerrada; o Pix pode continuar válido no provedor até o vencimento.'});
   }
   if(action==='createDeposit'){
     if(!ECLIPSE_API_KEY)return send(res,503,{error:'Pagamento Pix indisponível'});
     if(!user.email_confirmed_at)return send(res,403,{error:'Confirme seu e-mail para adicionar saldo'});
     const cents=Number(body.amountCents);
     if(!Number.isSafeInteger(cents)||cents<100||cents>99950)return send(res,400,{error:'Deposite de R$ 1,00 até R$ 999,50 por operação'});
     const old=await query(db.from('kaneki_wallet_deposits').select('id,created_at,status,provider_charge_id,credit_cents,charge_cents').eq('user_id',user.id).eq('status','pending').order('created_at',{ascending:false}).limit(10));
     for(const prior of old||[]){
       if(Date.now()-Date.parse(prior.created_at)<PIX_LIFETIME_MS)return send(res,409,{error:'Você já tem um Pix em andamento. Continue ou cancele esse pagamento antes de criar outro.',activeDepositId:prior.id});
       // Confere pagamentos antigos; não excluir registros que possam ser conciliados.
       let resolved=prior.status;
       if(prior.provider_charge_id)resolved=await verifyWalletDeposit(db,prior);
       if(resolved==='pending'){
         // Expirar somente a pendência local após 15 min; nunca apagar a cobrança
         // do banco, pois uma confirmação tardia ainda pode precisar de conciliação.
         await query(db.from('kaneki_wallet_deposits').update({status:'expired',updated_at:new Date().toISOString()}).eq('id',prior.id).eq('user_id',user.id).eq('status','pending'));
       }
     }
     const [wallet,config,pending]=await Promise.all([
       query(db.from('kaneki_wallets').select('balance_cents,max_override_cents').eq('user_id',user.id).maybeSingle()),
       query(db.from('kaneki_wallet_config').select('default_max_cents').eq('id',true).single()),
       query(db.from('kaneki_wallet_deposits').select('credit_cents').eq('user_id',user.id).in('status',['pending','needs_review']).gte('created_at',new Date(Date.now()-PIX_LIFETIME_MS).toISOString()))
     ]);
     const limit=Number(wallet?.max_override_cents??config.default_max_cents);
     const reserved=(pending||[]).reduce((n,d)=>n+Number(d.credit_cents),0);
     if(Number(wallet?.balance_cents||0)+reserved+cents>limit)return send(res,409,{error:'Depósito ultrapassa o limite disponível da carteira. Ajuste o valor ou contate o suporte.'});
     const id=randomUUID(), reference=randomUUID(), gross=cents+50;
     await query(db.from('kaneki_wallet_deposits').insert({id,user_id:user.id,credit_cents:cents,charge_cents:gross,payment_reference:reference,status:'pending'}));
     let response,charge;
     try{
       response=await fetch('https://eclipsepaybr.com/v1/charges',{
         method:'POST',headers:{Authorization:'Bearer '+ECLIPSE_API_KEY,'Content-Type':'application/json','Idempotency-Key':reference},
         body:JSON.stringify({amountCents:gross,description:'KANEKI STORE recarga de saldo '+id}),signal:AbortSignal.timeout(12000)
       });
       charge=await response.json();
     }catch(e){return send(res,502,{error:'Falha ao gerar cobrança. Consulte o histórico antes de tentar novamente.'});}
     if(!response.ok||!charge?.id||!charge.brCode){
       console.error('EclipsePay recarga falhou', {httpStatus:response.status, code:String(charge?.code||'').slice(0,80), hasId:Boolean(charge?.id), hasBrCode:Boolean(charge?.brCode)});
       return send(res,502,{error:!response.ok?'A EclipsePay recusou a cobrança Pix. Tente novamente mais tarde.':'A cobrança foi recebida sem QR Code Pix. Confira o histórico antes de tentar novamente.',providerCode:charge?.code||null});
     }
     await query(db.from('kaneki_wallet_deposits').update({provider_charge_id:charge.id,updated_at:new Date().toISOString()}).eq('id',id).eq('user_id',user.id));
     const serverDeadline=new Date(Date.now()+PIX_LIFETIME_MS).toISOString();
     const providerDeadline=charge.expiresAt?Date.parse(charge.expiresAt):NaN;
     return send(res,200,{depositId:id,creditCents:cents,feeCents:50,chargeCents:gross,brCode:charge.brCode,expiresAt:Number.isFinite(providerDeadline)&&providerDeadline<Date.parse(serverDeadline)?new Date(providerDeadline).toISOString():serverDeadline,providerExpirationConfirmed:Number.isFinite(providerDeadline)&&providerDeadline<=Date.parse(serverDeadline)});
   }
   if(action==='purchase'){
     if(!user.email_confirmed_at)return send(res,403,{error:'Confirme seu e-mail para comprar com saldo'});
     const entries=body.items;
     if(!Array.isArray(entries)||entries.length<1||entries.length>20)return send(res,400,{error:'Carrinho inválido'});
     const aggregate=new Map();
     for(const i of entries){const id=String(i?.product_id||'');const quantity=Number(i?.quantity);if(!id||id.length>300||!Number.isInteger(quantity)||quantity<1||quantity>10)return send(res,400,{error:'Produto ou quantidade inválida'});aggregate.set(id,(aggregate.get(id)||0)+quantity);}
     if([...aggregate.values()].some(n=>n>10))return send(res,400,{error:'Quantidade máxima por produto: 10'});
     const requestId=String(body.requestId||'');if(!validUuid.test(requestId))return send(res,400,{error:'Operação inválida'});
     const name=String(body.customerName||user.user_metadata?.full_name||'Cliente').trim().slice(0,120);
     const normalized=[...aggregate].sort((a,b)=>a[0].localeCompare(b[0])).map(([product_id,quantity])=>({product_id,quantity}));
     const {data,error}=await db.rpc('kaneki_wallet_purchase',{p_user:user.id,p_request:requestId,p_items:normalized,p_customer_name:name,p_email:user.email});
     if(error)return send(res,409,{error:error.message||'Não foi possível finalizar a compra'});
     // Garante ticket idempotente apenas em compras com entrega do tipo ticket.
     try{
       if(data?.orderId&&validUuid.test(String(data.orderId))){
         const ids=normalized.map(x=>x.product_id);
         const {data:ticketProducts,error:productErr}=await db.from('products').select('id,delivery_type').in('id',ids);
         if(productErr)throw productErr;
         if((ticketProducts||[]).some(p=>p.delivery_type==='ticket')){
           const {data:existing,error:checkErr}=await db.from('kaneki_tickets').select('id').eq('order_id',data.orderId).eq('user_id',user.id).limit(1);
           if(checkErr)throw checkErr;
           if(!existing?.length){
             const {error:insertErr}=await db.from('kaneki_tickets').insert({order_id:data.orderId,user_id:user.id,status:'open'});
             if(insertErr){const {data:retry}=await db.from('kaneki_tickets').select('id').eq('order_id',data.orderId).eq('user_id',user.id).limit(1);if(!retry?.length)throw insertErr;}
           }
           data.deliveryStatus='ticket';
         }
       }
     }catch(ticketError){console.error('Ticket da compra com carteira:',ticketError.message);data.ticketWarning='Atendimento ainda não confirmado. Verifique Meus Pedidos.';}
     try{
       const order=await query(db.from('orders').select('id,user_id,status,delivery_email,customer_name,email_sent_at').eq('id',data.orderId).single());
       await sendOrderEmail(db,order);
     }catch(e){console.error('E-mail da compra com saldo:',e.message);}
     return send(res,200,data);
   }
   return send(res,400,{error:'Ação inválida'});
 }catch(e){console.error('wallet',action,e.message);return send(res,500,{error:e.message||'Falha na carteira'});}
}
