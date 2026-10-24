import {createClient} from '@supabase/supabase-js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET')return res.status(405).json({error:'Método não permitido'});
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:'Supabase não configurado'});
 const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 if(!token)return res.status(401).json({error:'Faça login'});
 const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data,error}=await db.auth.getUser(token);
 if(error||!data?.user)return res.status(401).json({error:'Sessão inválida'});
 const {data:orders,error:ordersErr}=await db.from('orders').select('id,status,total_cents,created_at,paid_at,fulfilled_at').eq('user_id',data.user.id).order('created_at',{ascending:false}).limit(100);
 if(ordersErr)return res.status(500).json({error:'Falha ao consultar pedidos'});
 const ids=(orders||[]).map(x=>x.id);
 if(!ids.length)return res.status(200).json({orders:[]});
 const {data:items,error:itemsErr}=await db.from('order_items').select('order_id,product_id,product_name,quantity,unit_price_cents').in('order_id',ids);
 if(itemsErr)return res.status(500).json({error:'Falha ao consultar itens'});
 return res.status(200).json({orders:orders.map(o=>({...o,items:(items||[]).filter(i=>i.order_id===o.id)}))});
}
