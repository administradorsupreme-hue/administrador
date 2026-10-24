import { createClient } from '@supabase/supabase-js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET')return res.status(405).json({error:'Método não permitido'});
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(500).json({error:'Configuração do servidor incompleta.'});
 const token=(req.headers.authorization||'').match(/^Bearer (.+)$/i)?.[1];
 if(!token)return res.status(401).json({error:'Entre na sua conta.'});
 try{
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:auth,error:authError}=await db.auth.getUser(token);
  if(authError||!auth?.user)return res.status(401).json({error:'Sessão inválida.'});
  const {data:orders,error}=await db.from('orders').select('id,created_at,status,total_cents').eq('user_id',auth.user.id).order('created_at',{ascending:false}).limit(100);
  if(error)throw error;
  if(!orders?.length)return res.status(200).json({orders:[]});
  const {data:items,error:itemsError}=await db.from('order_items').select('order_id,product_id,product_name,quantity,unit_price_cents').in('order_id',orders.map(o=>o.id));
  if(itemsError)throw itemsError;
  const productIds=[...new Set((items||[]).map(i=>i.product_id).filter(Boolean))];
  let photos=new Map();
  if(productIds.length){const {data:products,error:productError}=await db.from('products').select('id,image_url').in('id',productIds);if(!productError)photos=new Map((products||[]).map(p=>[String(p.id),p.image_url]));}
  return res.status(200).json({orders:orders.map(o=>({...o,items:(items||[]).filter(i=>i.order_id===o.id).map(i=>({product_name:i.product_name,quantity:i.quantity,unit_price_cents:i.unit_price_cents,image_url:photos.get(String(i.product_id))||null}))}))});
 }catch(e){console.error('my-orders:',e);return res.status(500).json({error:'Não foi possível carregar o histórico de pedidos.'});}
}
