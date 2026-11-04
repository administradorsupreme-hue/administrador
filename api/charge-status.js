import {createClient} from '@supabase/supabase-js';
import {verifyAndFulfill, getDelivery, sendOrderEmail} from './_lib/order-delivery.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (res, status, body) => res.status(status).json(body);

export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if(req.method !== 'GET') return reply(res,405,{error:'Método não permitido'});
  const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY} = process.env;
  if(!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return reply(res,503,{error:'Supabase não configurado'});
  const orderId=String(req.query.orderId||'');
  if(!uuid.test(orderId)) return reply(res,400,{error:'Pedido inválido'});
  const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  if(!token) return reply(res,401,{error:'Entre na sua conta'});
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:auth,error:authError}=await db.auth.getUser(token);
  if(authError||!auth?.user) return reply(res,401,{error:'Sessão inválida'});
  const {data:order,error:orderError}=await db.from('orders')
    .select('id,user_id,status,total_cents,provider_charge_id,paid_at,customer_name,delivery_email,email_sent_at')
    .eq('id',orderId).eq('user_id',auth.user.id).maybeSingle();
  if(orderError) return reply(res,500,{error:'Falha ao consultar pedido. Execute a atualização SQL do checkout.'});
  if(!order) return reply(res,404,{error:'Pedido não encontrado'});
  try {
    if(order.status === 'pending' && order.provider_charge_id) await verifyAndFulfill(db,order);
    const {data:updated,error:updatedError}=await db.from('orders')
      .select('id,user_id,status,total_cents,customer_name,delivery_email,email_sent_at')
      .eq('id',orderId).eq('user_id',auth.user.id).single();
    if(updatedError) throw Error('Não foi possível atualizar o pedido');
    const delivery=await getDelivery(db,updated,{signedLinks:true});
    // Entrega e histórico NÃO dependem de a integração de e-mail estar configurada.
    let emailStatus='pending';
    try { emailStatus=await sendOrderEmail(db,updated); }
    catch(err) { console.error('Notificação de compra:',err.message); emailStatus='failed'; }
    return reply(res,200,{orderId,orderStatus:updated.status,...delivery,emailStatus,deliveredItems:[]});
  }catch(error) {
    console.error('charge-status',orderId,error.message);
    return reply(res,502,{error:error.message || 'Não foi possível confirmar o pagamento'});
  }
}
