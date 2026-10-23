import { createClient } from "@supabase/supabase-js";
const ownerEmail = "administradorsupreme@gmail.com";
const out = (res, code, data) => res.status(code).json(data);
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET","POST"].includes(req.method)) return out(res,405,{error:"Método não permitido."});
  const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
  if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return out(res,500,{error:"Variáveis Supabase ausentes."});
  const auth=req.headers.authorization||req.headers.Authorization;
  if(!auth?.startsWith("Bearer "))return out(res,401,{error:"Faça login."});
  const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:authData,error:authError}=await db.auth.getUser(auth.slice(7));
  const user=authData?.user;
  if(authError||!user)return out(res,401,{error:"Sessão inválida."});
  const isAdmin=String(user.email||"").toLowerCase()===ownerEmail;
  if(req.method==="GET"){
    let q=db.from("support_tickets").select("id,order_id,user_id,subject,status,created_at,updated_at,last_message_at").order("last_message_at",{ascending:false});
    if(!isAdmin)q=q.eq("user_id",user.id);
    const {data,error}=await q;
    if(error)return out(res,500,{error:"Não foi possível carregar os tickets. Execute a migração de suporte."});
    return out(res,200,{tickets:data||[],isAdmin});
  }
  let body;try{body=typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{});}catch{return out(res,400,{error:"JSON inválido."});}
  const orderId=String(body.orderId||"");
  if(!orderId)return out(res,400,{error:"Pedido obrigatório."});
  const {data:order,error:orderErr}=await db.from("orders").select("id,user_id,status").eq("id",orderId).maybeSingle();
  if(orderErr||!order)return out(res,404,{error:"Pedido não encontrado."});
  if(!isAdmin&&order.user_id!==user.id)return out(res,403,{error:"Este pedido não pertence à sua conta."});
  if(!["paid","fulfilled"].includes(order.status))return out(res,409,{error:"O ticket só pode ser aberto depois da confirmação do pagamento."});
  const {data:ticket,error}=await db.from("support_tickets").upsert({order_id:order.id,user_id:order.user_id,subject:"Suporte sobre pedido "+order.id.slice(0,8),updated_at:new Date().toISOString()},{onConflict:"order_id"}).select("id,order_id,user_id,subject,status,created_at,updated_at,last_message_at").single();
  if(error)return out(res,500,{error:"Não foi possível criar o ticket. Execute a migração de suporte."});
  return out(res,200,{ticket});
}