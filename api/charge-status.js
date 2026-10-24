import { createClient } from '@supabase/supabase-js';
import { createHash, createDecipheriv } from 'node:crypto';

const reply=(res,status,body)=>res.status(status).json(body);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isPaid=s=>['paid','completed','approved','succeeded'].includes(String(s||'').toLowerCase());
function decrypt(encoded,secret){
  if(!encoded)return null;
  const key=createHash('sha256').update(secret).digest();
  const buf=Buffer.from(encoded,'base64');
  if(buf.length<29)throw Error('Entrega criptografada inválida');
  const decipher=createDecipheriv('aes-256-gcm',key,buf.subarray(0,12));
  decipher.setAuthTag(buf.subarray(12,28));
  return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)),decipher.final()]).toString('utf8'));
}
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET')return reply(res,405,{error:'Método não permitido'});
  const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,ECLIPSE_API_KEY,STOCK_ENCRYPTION_KEY}=process.env;
  if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return reply(res,503,{error:'Supabase não configurado'});
  const orderId=String(req.query.orderId||'');
  if(!uuid.test(orderId))return reply(res,400,{error:'Pedido inválido'});
  const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  if(!token)return reply(res,401,{error:'Entre na sua conta'});
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:auth,error:authErr}=await db.auth.getUser(token);
  if(authErr||!auth?.user)return reply(res,401,{error:'Sessão inválida'});
  const {data:order,error:orderErr}=await db.from('orders').select('id,user_id,status,total_cents,provider_charge_id,paid_at').eq('id',orderId).eq('user_id',auth.user.id).maybeSingle();
  if(orderErr)return reply(res,500,{error:'Erro ao consultar pedido'});
  if(!order)return reply(res,404,{error:'Pedido não encontrado'});
  let status=order.status;
  if(status==='pending'&&order.provider_charge_id){
    if(!ECLIPSE_API_KEY)return reply(res,503,{error:'Chave EclipsePay não configurada'});
    let response,payment;
    try{
      response=await fetch('https://eclipsepaybr.com/v1/charges/'+encodeURIComponent(order.provider_charge_id),{headers:{Authorization:'Bearer '+ECLIPSE_API_KEY,Accept:'application/json'},signal:AbortSignal.timeout(10000)});
      if(!response.ok)return reply(res,502,{error:'Não foi possível confirmar a cobrança na EclipsePay',providerStatus:response.status});
      payment=await response.json();
    }catch(e){return reply(res,502,{error:'Falha ao consultar a confirmação do pagamento'});}
    const charge=payment?.data&&typeof payment.data==='object'?payment.data:payment;
    // Nunca confie no status recebido do navegador: confira ID e valor diretamente no provedor.
    const amount=charge?.amountCents;
    if(String(charge?.id)!==String(order.provider_charge_id)||!Number.isSafeInteger(amount)||amount!==order.total_cents){
      return reply(res,502,{error:'Cobrança não corresponde ao pedido; entrega bloqueada por segurança'});
    }
    if(isPaid(charge.status)){
      const {data:result,error:rpcError}=await db.rpc('kaneki_confirm_and_fulfill',{p_order_id:orderId,p_charge_id:String(charge.id)});
      if(rpcError)return reply(res,500,{error:'Pagamento confirmado, mas não foi possível processar a entrega. Contate o suporte.',detail:rpcError.message});
      status=result?.status||'paid';
    }
  }
  const {data:updated,error:updatedError}=await db.from('orders').select('status').eq('id',orderId).eq('user_id',auth.user.id).single();
  if(updatedError)return reply(res,500,{error:'Não foi possível atualizar o pedido'});
  status=updated.status;
  const {data:units,error:unitsErr}=await db.from('kaneki_account_stock').select('id,encrypted_data,account_info,username').eq('order_id',orderId).eq('delivered_to',auth.user.id).eq('status','delivered');
  if(unitsErr)return reply(res,500,{error:'Falha ao carregar entrega'});
  const credentials=[];const deliveries=[];
  for(const unit of units||[]){
    if(unit.encrypted_data){
      if(!STOCK_ENCRYPTION_KEY)return reply(res,503,{error:'Chave de entrega não configurada'});
      let info;try{info=decrypt(unit.encrypted_data,STOCK_ENCRYPTION_KEY);}catch{return reply(res,500,{error:'Falha ao abrir entrega criptografada. Confira a chave do estoque.'});}
      credentials.push({username:info.username||'',password:info.password||'',details:info.details||'',description:info.details||'',credentials:[info.username&&('Usuário: '+info.username),info.password&&('Senha: '+info.password)].filter(Boolean).join('\n'),product:'Produto digital'});
      if(info.fileInfo?.path){
        const {data:signed,error:signError}=await db.storage.from('kaneki-private-deliveries').createSignedUrl(info.fileInfo.path,300);
        if(!signError&&signed?.signedUrl){deliveries.push({filename:info.fileInfo.name||'Arquivo',url:signed.signedUrl});credentials[credentials.length-1].attachment={name:info.fileInfo.name||'Arquivo',mime:info.fileInfo.mime||'',url:signed.signedUrl};}
      }
    }else credentials.push({username:unit.username||'',details:unit.account_info||'',description:unit.account_info||'',credentials:unit.username||'',product:'Produto digital'});
  }
  const {data:ticketItems}=await db.from('kaneki_tickets').select('id').eq('order_id',orderId).limit(1);
  const deliveryStatus=ticketItems?.length&&!credentials.length?'ticket':status==='fulfilled'?'fulfilled':status==='paid'?'waiting_stock':'pending';
  return reply(res,200,{orderId,orderStatus:status,deliveryStatus,credentials,deliveredItems:[],deliveries});
}
