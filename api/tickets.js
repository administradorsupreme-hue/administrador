import { createClient } from '@supabase/supabase-js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET')return res.status(405).json({error:'Método não permitido'});
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:'Servidor não configurado'});
 const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const token=(req.headers.authorization||'').replace(/^Bearer /,'');
 const {data:{user},error}=await db.auth.getUser(token);
 if(error||!user)return res.status(401).json({error:'Entre na sua conta'});
 const {data,error:err}=await db.from('kaneki_tickets').select('id,order_id,user_id,status,created_at').eq('user_id',user.id).order('created_at',{ascending:false});
 if(err)return res.status(500).json({error:'Falha ao carregar tickets'});
 return res.status(200).json({tickets:(data||[]).map(t=>({...t,subject:'Atendimento do pedido '+t.order_id,last_message_at:t.created_at}))});
}
