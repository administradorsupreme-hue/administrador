import { createClient } from '@supabase/supabase-js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Método não permitido'});
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:'Servidor não configurado'});
 const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const token=(req.headers.authorization||'').replace(/^Bearer /,'');
 const {data:{user},error}=await db.auth.getUser(token);
 if(error||!user)return res.status(401).json({error:'Entre na sua conta'});
 const id=req.method==='GET'?req.query.ticketId:req.body?.ticketId;
 if(typeof id!=='string'||!UUID.test(id))return res.status(400).json({error:'Ticket inválido'});
 const {data:ticket,error:ticketError}=await db.from('kaneki_tickets').select('*').eq('id',id).eq('user_id',user.id).maybeSingle();
 if(ticketError||!ticket)return res.status(404).json({error:'Ticket não encontrado'});
 if(req.method==='POST'){
   if(ticket.status!=='open')return res.status(409).json({error:'Ticket encerrado'});
   const body=typeof req.body?.message==='string'?req.body.message.trim():'';
   const files=req.body?.attachments||[];
   if(!Array.isArray(files)||files.length>5||body.length>5000)return res.status(400).json({error:'Mensagem inválida'});
   if(!body&&!files.length)return res.status(400).json({error:'Mensagem vazia'});
   for(const f of files){if(typeof f.path!=='string'||!f.path.startsWith(id+'/'+user.id+'/')||f.path.length>500)return res.status(400).json({error:'Anexo inválido'});}
   const rows=files.length?files.map((f,i)=>({ticket_id:id,sender_id:user.id,body:i===0?body:'',file_path:f.path})):[{ticket_id:id,sender_id:user.id,body}];
   const {error:insertError}=await db.from('kaneki_ticket_messages').insert(rows);
   if(insertError)return res.status(500).json({error:'Falha ao enviar mensagem'});
   return res.status(200).json({ok:true});
 }
 const {data:messages,error:messageError}=await db.from('kaneki_ticket_messages').select('*').eq('ticket_id',id).order('created_at');
 if(messageError)return res.status(500).json({error:'Falha ao carregar mensagens'});
 const mapped=[];
 for(const m of messages||[]){let attachments=[];if(m.file_path){const {data}=await db.storage.from('kaneki-ticket-files').createSignedUrl(m.file_path,120);if(data?.signedUrl)attachments=[{url:data.signedUrl,name:'Anexo',size:0}];}mapped.push({id:m.id,message:m.body,sender_role:m.sender_id===user.id?'customer':'admin',created_at:m.created_at,attachments});}
 return res.status(200).json({ticket,messages:mapped});
}
