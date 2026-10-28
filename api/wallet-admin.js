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
async function enrichUser(db,userId){
 const {data,error}=await db.auth.admin.getUserById(userId);
 if(error)return {id:userId,email:'',nickname:'',name:''};
 const user=data?.user;
 return {id:userId,email:user?.email||'',nickname:String(user?.user_metadata?.roblox_nick||user?.user_metadata?.wallet_nick||user?.user_metadata?.last_wallet_nick||'').trim(),name:String(user?.user_metadata?.full_name||user?.user_metadata?.name||'').trim()};
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
   if(act==='recentDeposits'){
     const rows=await query(db.from('kaneki_wallet_deposits').select('id,user_id,credit_cents,charge_cents,status,created_at,provider_charge_id').order('created_at',{ascending:false}).limit(20));
     const out=[];
     for(let i=0;i<rows.length;i+=5){
       const batch=await Promise.all(rows.slice(i,i+5).map(async dep=>{const identity=await enrichUser(db,dep.user_id);return {id:dep.id,email:identity.email,nickname:identity.nickname,name:identity.name,creditCents:Number(dep.credit_cents),chargeCents:Number(dep.charge_cents||0),status:dep.status,createdAt:dep.created_at,providerChargeId:dep.provider_charge_id||''};}));
       out.push(...batch);
     }
     return respond(res,200,{deposits:out});
   }
   if(act==='listBalances'){
     const pageArg=Number(req.query.page??0);
     if(!Number.isSafeInteger(pageArg)||pageArg<0||pageArg>10000)return respond(res,400,{error:'Página inválida'});
     const pageSize=15;
     const {data:rows,count,error:listError}=await db.from('kaneki_wallets')
       .select('user_id,balance_cents,max_override_cents,updated_at',{count:'exact'})
       .gt('balance_cents',0)
       .order('balance_cents',{ascending:false})
       .order('user_id',{ascending:true})
       .range(pageArg*pageSize,pageArg*pageSize+pageSize-1);
     if(listError)throw Error(listError.message);
     const entries=rows||[];
     const customers=[];
     for(let i=0;i<entries.length;i+=5){
       const batch=await Promise.all(entries.slice(i,i+5).map(async w=>{
         const identity=await enrichUser(db,w.user_id);
         return {id:w.user_id,email:identity.email,nickname:identity.nickname,name:identity.name,balanceCents:Number(w.balance_cents),maxOverrideCents:w.max_override_cents===null?null:Number(w.max_override_cents),updatedAt:w.updated_at};
       }));
       customers.push(...batch);
     }
     return respond(res,200,{customers,page:pageArg,pageSize,total:Number(count||0),hasMore:(pageArg+1)*pageSize<Number(count||0)});
   }
   if(act==='lookup'){
     const user=await locateUser(db,req.query.email);
     await query(db.from('kaneki_wallets').upsert({user_id:user.id},{onConflict:'user_id',ignoreDuplicates:true}));
     const [wallet,transactions,deposits]=await Promise.all([
       query(db.from('kaneki_wallets').select('balance_cents,max_override_cents').eq('user_id',user.id).single()),
       query(db.from('kaneki_wallet_ledger').select('amount_cents,kind,detail,created_at').eq('user_id',user.id).order('created_at',{ascending:false}).limit(15)),
       query(db.from('kaneki_wallet_deposits').select('id,credit_cents,charge_cents,status,created_at,provider_charge_id').eq('user_id',user.id).order('created_at',{ascending:false}).limit(10))
     ]);
     const nickname=String(user.user_metadata?.roblox_nick||user.user_metadata?.wallet_nick||user.user_metadata?.last_wallet_nick||'').trim();
     return respond(res,200,{id:user.id,email:user.email,nickname,balanceCents:Number(wallet.balance_cents),maxOverrideCents:wallet.max_override_cents===null?null:Number(wallet.max_override_cents),transactions,deposits});
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
