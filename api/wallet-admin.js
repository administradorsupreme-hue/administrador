import {createClient} from '@supabase/supabase-js';
import {randomUUID} from 'node:crypto';
import {verifyWalletDeposit} from './_lib/wallet-payment.js';
const respond=(res,code,body)=>res.status(code).json(body);
async function locateUser(db,email){
 const key=String(email||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key))throw Error('Informe o e-mail exato do cliente');
 for(let page=1;page<=30;page++){
   const {data,error}=await db.auth.admin.listUsers({page,perPage:100});if(error)throw error;
   const users=data?.users||[],found=users.find(u=>String(u.email||'').toLowerCase()===key);
   if(found)return found;if(users.length<100)break;
 }
 throw Error('Cliente não encontrado. Ele precisa cadastrar uma conta na loja.');
}
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(!['GET','POST'].includes(req.method))return respond(res,405,{error:'Método inválido'});
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return respond(res,503,{error:'Supabase não configurado'});
 const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data,error}=await db.auth.getUser(token);const actor=data?.user;
 if(error||!actor)return respond(res,401,{error:'Faça login como dono'});
 const {data:member,error:ae}=await db.from('kaneki_admins').select('user_id').eq('user_id',actor.id).maybeSingle();
 const owner=String(process.env.KANEKI_OWNER_EMAIL||'administradorsupreme@gmail.com').toLowerCase();
 if(ae||!member||String(actor.email||'').toLowerCase()!==owner)return respond(res,403,{error:'Somente o proprietário pode alterar saldos'});
 const query=async q=>{const {data,error}=await q;if(error)throw Error(error.message);return data;};
 try{
   const act=String(req.method==='GET'?req.query.action:req.body?.action||'');
   if(act==='config'){
     const c=await query(db.from('kaneki_wallet_config').select('default_max_cents').eq('id',true).single());
     const deposits=await query(db.from('kaneki_wallet_deposits').select('id,user_id,credit_cents,status,created_at').eq('status','needs_review').order('created_at',{ascending:false}).limit(15));
     return respond(res,200,{defaultMaxCents:Number(c.default_max_cents),needsReview:deposits});
   }
   if(act==='lookup'){
     const user=await locateUser(db,req.query.email);
     await query(db.from('kaneki_wallets').upsert({user_id:user.id},{onConflict:'user_id',ignoreDuplicates:true}));
     const wallet=await query(db.from('kaneki_wallets').select('balance_cents,max_override_cents').eq('user_id',user.id).single());
     const transactions=await query(db.from('kaneki_wallet_ledger').select('amount_cents,kind,detail,created_at').eq('user_id',user.id).order('created_at',{ascending:false}).limit(15));
     return respond(res,200,{id:user.id,email:user.email,balanceCents:Number(wallet.balance_cents),maxOverrideCents:wallet.max_override_cents===null?null:Number(wallet.max_override_cents),transactions});
   }
   if(req.method!=='POST')return respond(res,400,{error:'Ação inválida'});
   const b=req.body||{};
   if(act==='setDefaultLimit'){
     const cents=Number(b.maxCents);
     if(!Number.isSafeInteger(cents)||cents<100||cents>100000000)return respond(res,400,{error:'Limite inválido'});
     const {data,error}=await db.rpc('kaneki_wallet_set_default_limit',{p_actor:actor.id,p_limit:cents});
     if(error)return respond(res,409,{error:error.message});return respond(res,200,data);
   }
   if(['credit','debit','reset','limit'].includes(act)){
     const target=await locateUser(db,b.email);
     const amount=Number(b.amountCents||0);
     const maxCents=b.maxCents===null?null:Number(b.maxCents);
     if(act==='limit'&&(maxCents!==null&&(!Number.isSafeInteger(maxCents)||maxCents<0||maxCents>100000000)))return respond(res,400,{error:'Limite inválido'});
     if(act!=='limit'&&act!=='reset'&&(!Number.isSafeInteger(amount)||amount<1||amount>100000000))return respond(res,400,{error:'Valor inválido'});
     const operation=String(b.operationId||'');if(!/^[0-9a-f-]{36}$/i.test(operation))return respond(res,400,{error:'Identificador de ação inválido'});
     const {data,error}=await db.rpc('kaneki_wallet_admin_action',{p_actor:actor.id,p_user:target.id,p_action:act,p_amount_cents:amount,p_new_limit:maxCents,p_operation:operation});
     if(error)return respond(res,409,{error:error.message});
     return respond(res,200,{...data,email:target.email});
   }
   if(act==='retryDeposit'){
     const id=String(b.depositId||'');if(!/^[0-9a-f-]{36}$/i.test(id))return respond(res,400,{error:'ID inválido'});
     const deposit=await query(db.from('kaneki_wallet_deposits').select('*').eq('id',id).single());
     const status=await verifyWalletDeposit(db,deposit);
     return respond(res,200,{status});
   }
   return respond(res,400,{error:'Ação desconhecida'});
 }catch(e){console.error('wallet-admin',e.message);return respond(res,500,{error:e.message||'Falha no ajuste de saldo'});}
}
