import {createClient} from '@supabase/supabase-js';
import {randomUUID} from 'node:crypto';
import {verifyWalletDeposit} from './_lib/wallet-payment.js';
import {sendOrderEmail} from './_lib/order-delivery.js';

const send=(res,code,data)=>res.status(code).json(data);
const validUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(!['GET','POST'].includes(req.method))return send(res,405,{error:'Método inválido'});
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,ECLIPSE_API_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return send(res,503,{error:'Configure as credenciais do Supabase'});
 const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 if(!token)return send(res,401,{error:'Entre na sua conta'});
 const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data:auth,error:authError}=await db.auth.getUser(token);
 const user=auth?.user;
 if(authError||!user)return send(res,401,{error:'Sessão inválida'});
 const action=String(req.method==='GET'?req.query.action:req.body?.action||'');
 const query=async q=>{const {data,error}=await q;if(error)throw Error(error.message);return data;};
 try{
   if(action==='balance'){
     await query(db.from('kaneki_wallets').upsert({user_id:user.id},{onConflict:'user_id',ignoreDuplicates:true}));
     const [wallet,config,transactions,deposits]=await Promise.all([
       query(db.from('kaneki_wallets').select('balance_cents,max_override_cents').eq('user_id',user.id).single()),
       query(db.from('kaneki_wallet_config').select('default_max_cents').eq('id',true).single()),
       query(db.from('kaneki_wallet_ledger').select('id,amount_cents,kind,detail,created_at').eq('user_id',user.id).order('created_at',{ascending:false}).limit(25)),
       query(db.from('kaneki_wallet_deposits').select('id,credit_cents,charge_cents,status,created_at').eq('user_id',user.id).order('created_at',{ascending:false}).limit(10))
     ]);
     return send(res,200,{balanceCents:Number(wallet.balance_cents),maxBalanceCents:Number(wallet.max_override_cents??config.default_max_cents),transactions,deposits});
   }
   if(action==='depositStatus'){
     const id=String(req.query.depositId||'');
     if(!validUuid.test(id))return send(res,400,{error:'Depósito inválido'});
     const deposit=await query(db.from('kaneki_wallet_deposits').select('*').eq('id',id).eq('user_id',user.id).maybeSingle());
     if(!deposit)return send(res,404,{error:'Depósito não encontrado'});
     let status=deposit.status;
     if(status==='pending'||status==='needs_review')status=await verifyWalletDeposit(db,deposit);
     await query(db.from('kaneki_wallets').upsert({user_id:user.id},{onConflict:'user_id',ignoreDuplicates:true}));
     const wallet=await query(db.from('kaneki_wallets').select('balance_cents').eq('user_id',user.id).single());
     return send(res,200,{status,balanceCents:Number(wallet.balance_cents),depositId:id});
   }
   if(req.method!=='POST')return send(res,400,{error:'Ação inválida'});
   const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};
   if(action==='createDeposit'){
     if(!ECLIPSE_API_KEY)return send(res,503,{error:'Pagamento Pix indisponível'});
     if(!user.email_confirmed_at)return send(res,403,{error:'Confirme seu e-mail para adicionar saldo'});
     const cents=Number(body.amountCents);
     if(!Number.isSafeInteger(cents)||cents<100||cents>99950)return send(res,400,{error:'Deposite de R$ 1,00 até R$ 999,50 por operação'});
     const [wallet,config,pending]=await Promise.all([
       query(db.from('kaneki_wallets').select('balance_cents,max_override_cents').eq('user_id',user.id).maybeSingle()),
       query(db.from('kaneki_wallet_config').select('default_max_cents').eq('id',true).single()),
       query(db.from('kaneki_wallet_deposits').select('credit_cents').eq('user_id',user.id).in('status',['pending','needs_review']).gte('created_at',new Date(Date.now()-24*60*60*1000).toISOString()))
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
     if(!response.ok||!charge?.id||!charge.brCode)return send(res,502,{error:'Provedor não retornou uma cobrança Pix válida'});
     await query(db.from('kaneki_wallet_deposits').update({provider_charge_id:charge.id,updated_at:new Date().toISOString()}).eq('id',id).eq('user_id',user.id));
     return send(res,200,{depositId:id,creditCents:cents,feeCents:50,chargeCents:gross,brCode:charge.brCode,expiresAt:charge.expiresAt||null});
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
     try{
       const order=await query(db.from('orders').select('id,user_id,status,delivery_email,customer_name,email_sent_at').eq('id',data.orderId).single());
       await sendOrderEmail(db,order);
     }catch(e){console.error('E-mail da compra com saldo:',e.message);}
     return send(res,200,data);
   }
   return send(res,400,{error:'Ação inválida'});
 }catch(e){console.error('wallet',action,e.message);return send(res,500,{error:e.message||'Falha na carteira'});}
}
