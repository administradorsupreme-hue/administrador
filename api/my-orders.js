import {createClient} from '@supabase/supabase-js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET')return res.status(405).json({error:'Método não permitido'});
 const token=(req.headers.authorization||'').match(/^Bearer (.+)$/)?.[1];
 if(!token)return res.status(401).json({error:'Entre na sua conta para consultar seus pedidos.'});
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(500).json({error:'Servidor não configurado.'});
 const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data:auth,error:authError}=await db.auth.getUser(token);
 if(authError||!auth?.user)return res.status(401).json({error:'Sessão inválida. Faça login novamente.'});
 const {data:orders,error}=await db.from('orders').select('id,created_at,status,total_cents').eq('user_id',auth.user.id).order('created_at',{ascending:false}).limit(100);
 if(error)return res.status(500).json({error:'Não foi possível carregar o histórico de pedidos.'});
 const ids=(orders||[]).map(o=>o.id);
 if(!ids.length)return res.status(200).json({orders:[]});
 const {data:items,error:itemsError}=await db.from('order_items').select('order_id,product_name,quantity,unit_price_cents').in('order_id',ids);
 if(itemsError)return res.status(500).json({error:'Não foi possível carregar os itens dos pedidos.'});
 return res.status(200).json({orders:orders.map(o=>({...o,items:(items||[]).filter(i=>i.order_id===o.id).map(({product_name,quantity,unit_price_cents})=>({product_name,quantity,unit_price_cents}))}))});
}
