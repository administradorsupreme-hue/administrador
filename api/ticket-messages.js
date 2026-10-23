import { createClient } from "@supabase/supabase-js";
const ownerEmail="administradorsupreme@gmail.com";
const out=(res,code,data)=>res.status(code).json(data);
const safeName=v=>String(v||"arquivo").replace(/[\\/\r\n\0]/g,"_").slice(0,180);
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(!["GET","POST"].includes(req.method))return out(res,405,{error:"Método não permitido."});
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return out(res,500,{error:"Variáveis Supabase ausentes."});
 const auth=req.headers.authorization||req.headers.Authorization;
 if(!auth?.startsWith("Bearer "))return out(res,401,{error:"Faça login."});
 const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data:ad,error:ae}=await db.auth.getUser(auth.slice(7)),user=ad?.user;
 if(ae||!user)return out(res,401,{error:"Sessão inválida."});
 const isAdmin=String(user.email||"").toLowerCase()===ownerEmail;
 let body={};try{body=req.method==="GET"?{}:(typeof req.body==="string"?JSON.parse(req.body||"{}"):req.body||{});}catch{return out(res,400,{error:"JSON inválido."});}
 const ticketId=String(req.method==="GET"?(req.query?.ticketId||""):(body.ticketId||""));
 if(!ticketId)return out(res,400,{error:"ticketId obrigatório."});
 const {data:ticket,error:te}=await db.from("support_tickets").select("id,user_id,order_id,status").eq("id",ticketId).maybeSingle();
 if(te||!ticket)return out(res,404,{error:"Ticket não encontrado."});
 if(!isAdmin&&ticket.user_id!==user.id)return out(res,403,{error:"Você não tem acesso a este ticket."});
 if(req.method==="GET"){
  const {data,error}=await db.from("support_messages").select("id,ticket_id,sender_id,sender_email,sender_role,message,attachments,created_at").eq("ticket_id",ticketId).order("created_at",{ascending:true});
  if(error)return out(res,500,{error:"Não foi possível carregar as mensagens. Verifique a migração de anexos."});
  const messages=await Promise.all((data||[]).map(async m=>({ ...m, attachments: await Promise.all((Array.isArray(m.attachments)?m.attachments:[]).map(async a=>{const {data:signed}=await db.storage.from("support-attachments").createSignedUrl(a.path,300);return {...a,url:signed?.signedUrl||null};})) })));
  return out(res,200,{ticket,messages});
 }
 const message=String(body.message||"").trim();
 const attachments=Array.isArray(body.attachments)?body.attachments:[];
 if((!message&&!attachments.length)||message.length>5000)return out(res,400,{error:"Escreva uma mensagem de até 5000 caracteres ou anexe um arquivo."});
 if(attachments.length>5)return out(res,400,{error:"Anexe no máximo 5 arquivos por mensagem."});
 if(ticket.status==="closed"&&!isAdmin)return out(res,409,{error:"Este ticket foi encerrado."});
 const clean=[];let total=0;
 for(const a of attachments){
  const path=String(a?.path||""); const name=safeName(a?.name); const size=Number(a?.size||0); const mime=String(a?.mime||"application/octet-stream");
  if(!path.startsWith(`${ticketId}/${user.id}/`)||path.includes(".."))return out(res,400,{error:"Caminho de anexo inválido."});
  if(!size||size>10485760)return out(res,400,{error:"Cada arquivo deve ter até 10 MB."});
  total+=size; if(total>20971520)return out(res,400,{error:"O total de anexos por mensagem deve ser até 20 MB."});
  const {data:obj,error:oe}=await db.storage.from("support-attachments").list(`${ticketId}/${user.id}`,{search:path.split('/').pop(),limit:10});
  if(oe||!obj?.some(x=>x.name===path.split('/').pop()))return out(res,400,{error:"Um anexo não foi encontrado no armazenamento privado."});
  clean.push({path,name,mime,size});
 }
 const now=new Date().toISOString();
 const {data:inserted,error:ie}=await db.from("support_messages").insert({ticket_id:ticketId,sender_id:user.id,sender_email:user.email||"",sender_role:isAdmin?"admin":"customer",message:message||"Arquivo(s) anexado(s).",attachments:clean}).select("id,ticket_id,sender_id,sender_email,sender_role,message,attachments,created_at").single();
 if(ie)return out(res,500,{error:"Não foi possível enviar a mensagem."});
 await db.from("support_tickets").update({status:isAdmin?"waiting_customer":"waiting_admin",updated_at:now,last_message_at:now}).eq("id",ticketId);
 const withUrls={...inserted,attachments:await Promise.all(clean.map(async a=>{const {data:signed}=await db.storage.from("support-attachments").createSignedUrl(a.path,300);return {...a,url:signed?.signedUrl||null};}))};
 return out(res,200,{message:withUrls});
}
