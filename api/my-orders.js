import {createClient} from '@supabase/supabase-js';
import {getDelivery} from './_lib/order-delivery.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');
 if(req.method!=='GET')return res.status(405).json({error:'Método não permitido'});
 try{
  const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
  if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:'Supabase não configurado'});
  const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  if(!token)return res.status(401).json({error:'Faça login'});
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:auth,error:authError}=await db.auth.getUser(token);
  if(authError||!auth?.user)return res.status(401).json({error:'Sessão inválida'});
  const userId=auth.user.id;
  const selected=String(req.query?.orderId||'');
  if(selected&&!UUID.test(selected))return res.status(400).json({error:'Pedido inválido'});
  const orderQuery=db.from('orders').select('id,status,total_cents,created_at,paid_at,fulfilled_at')
     .eq('user_id',userId).order('created_at',{ascending:false});
  const {data:orders,error:ordersError}=selected
    ?await orderQuery.eq('id',selected).limit(1)
    :await orderQuery.limit(200);
  if(ordersError)throw new Error('Falha ao consultar pedidos: '+ordersError.message);
  if(selected&&!orders?.length)return res.status(404).json({error:'Pedido não encontrado'});
  const ids=(orders||[]).map(o=>o.id);
  if(!ids.length)return res.status(200).json({orders:[]});
  const [itemResult,ticketResult,stockResult]=await Promise.all([
    db.from('order_items').select('order_id,product_id,product_name,product_image_url,quantity,unit_price_cents').in('order_id',ids),
    db.from('kaneki_tickets').select('id,order_id,status,created_at').eq('user_id',userId).in('order_id',ids).order('created_at',{ascending:false}),
    db.from('kaneki_account_stock').select('order_id').eq('delivered_to',userId).eq('status','delivered').in('order_id',ids)
  ]);
  if(itemResult.error)throw new Error('Falha ao consultar itens: '+itemResult.error.message);
  if(ticketResult.error)throw new Error('Falha ao consultar histórico de tickets: '+ticketResult.error.message);
  if(stockResult.error)throw new Error('Falha ao consultar histórico de entregas: '+stockResult.error.message);
  const itemsByOrder=new Map(),ticketsByOrder=new Map();
  for(const i of itemResult.data||[]){const group=itemsByOrder.get(i.order_id)||[];group.push(i);itemsByOrder.set(i.order_id,group);}
  for(const t of ticketResult.data||[]){const group=ticketsByOrder.get(t.order_id)||[];group.push({id:t.id,status:t.status,created_at:t.created_at});ticketsByOrder.set(t.order_id,group);}
  const stocked=new Set((stockResult.data||[]).map(u=>u.order_id));
  const formatted=(orders||[]).map(o=>({...o,items:itemsByOrder.get(o.id)||[],tickets:ticketsByOrder.get(o.id)||[],has_stock_delivery:stocked.has(o.id)}));
  if(!selected)return res.status(200).json({orders:formatted});
  const order=orders[0];
  if(!['paid','fulfilled'].includes(order.status))return res.status(200).json({order:formatted[0],delivery:null});
  // Recreate short-lived private file links every time the buyer opens the order;
  // never send credentials or signed links in the public/history listing.
  const delivery=await getDelivery(db,{...order,user_id:userId},{signedLinks:true});
  return res.status(200).json({order:formatted[0],delivery});
 }catch(error){
  console.error('my-orders history',error);
  return res.status(500).json({error:'Não foi possível carregar o histórico desta compra.'});
 }
}
