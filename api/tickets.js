import { createClient } from '@supabase/supabase-js';

async function listTickets(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET')return res.status(405).json({error:'Método não permitido'});
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:'Servidor não configurado'});
 const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const token=(req.headers.authorization||'').replace(/^Bearer /,'');
 const {data:{user},error}=await db.auth.getUser(token);
 if(error||!user)return res.status(401).json({error:'Entre na sua conta'});
 const {data,error:err}=await db.from('kaneki_tickets').select('id,order_id,user_id,status,created_at').eq('user_id',user.id).eq('status','open').order('created_at',{ascending:false});
 if(err)return res.status(500).json({error:'Falha ao carregar tickets'});
 return res.status(200).json({tickets:(data||[]).map(t=>({...t,subject:'Atendimento do pedido '+t.order_id,last_message_at:t.created_at}))});
}


const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function ticketMessages(req,res){
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
   for(const f of files){if(typeof f.path!=='string'||!f.path.startsWith(id+'/'+user.id+'/')||f.path.length>500||!/\.(?:png|jpe?g|webp|pdf|zip)$/i.test(f.path))return res.status(400).json({error:'Anexo inválido'});}
   const rows=files.length?files.map((f,i)=>({ticket_id:id,sender_id:user.id,body:i===0?body:'',file_path:f.path})):[{ticket_id:id,sender_id:user.id,body}];
   const {error:insertError}=await db.from('kaneki_ticket_messages').insert(rows);
   if(insertError)return res.status(500).json({error:'Falha ao enviar mensagem'});
   return res.status(200).json({ok:true});
 }
 const {data:messages,error:messageError}=await db.from('kaneki_ticket_messages').select('*').eq('ticket_id',id).order('created_at');
 if(messageError)return res.status(500).json({error:'Falha ao carregar mensagens'});
 const mapped=[];
 for(const m of messages||[]){let attachments=[];if(m.file_path?.startsWith(id+'/')){const {data}=await db.storage.from('kaneki-ticket-files').createSignedUrl(m.file_path,300);if(data?.signedUrl){const original=String(m.file_path.split('/').pop()||'Arquivo').replace(/^[0-9a-f-]{36}-/i,'');const ext=(original.split('.').pop()||'').toLowerCase();const mimeMap={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',pdf:'application/pdf',zip:'application/zip'};attachments=[{url:data.signedUrl,name:original,mime:mimeMap[ext]||'application/octet-stream',is_image:['png','jpg','jpeg','webp'].includes(ext)}];}}mapped.push({id:m.id,message:m.body,sender_role:m.sender_id===user.id?'customer':'admin',created_at:m.created_at,attachments});}
 return res.status(200).json({ticket,messages:mapped});
}

async function feedbackHandler(req,res){
 res.setHeader('Cache-Control','no-store');
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:'Servidor não configurado'});
 const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const mode=String(req.query?.mode||'');
 if(mode==='public'){
  if(req.method!=='GET')return res.status(405).json({error:'Método inválido'});
  const {data,error}=await db.from('kaneki_ticket_feedback').select('id,product_name,rating,comment,created_at').eq('is_public',true).order('created_at',{ascending:false}).limit(30);
  return error?res.status(500).json({error:'Não foi possível carregar as avaliações'}):res.json({items:data||[]});
 }
 if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Método inválido'});
 const token=String(req.headers.authorization||'').replace(/^Bearer /i,'');
 const {data:{user},error:authErr}=await db.auth.getUser(token);
 if(authErr||!user)return res.status(401).json({error:'Entre na conta'});
 if(req.method==='GET'){
  const {data:tickets,error}=await db.from('kaneki_tickets').select('id,order_id,created_at').eq('user_id',user.id).eq('status','closed').order('created_at',{ascending:false}).limit(100);
  if(error)return res.status(500).json({error:'Falha ao carregar avaliações pendentes'});
  const ids=(tickets||[]).map(t=>t.id);
  if(!ids.length)return res.json({pending:[]});
  const {data:ratings,error:rateErr}=await db.from('kaneki_ticket_feedback').select('ticket_id').in('ticket_id',ids);
  if(rateErr)return res.status(500).json({error:'Falha ao carregar avaliações'});
  const rated=new Set((ratings||[]).map(r=>r.ticket_id));
  const pending=(tickets||[]).filter(t=>!rated.has(t.id));
  return res.json({pending});
 }
 const ticketId=String(req.body?.ticketId||''),rating=Number(req.body?.rating),comment=String(req.body?.comment||'').trim();
 if(!UUID.test(ticketId)||!Number.isInteger(rating)||rating<1||rating>5||comment.length>1000)return res.status(400).json({error:'Avaliação inválida'});
 const {data:ticket,error:ticketErr}=await db.from('kaneki_tickets').select('id,order_id,status,user_id').eq('id',ticketId).eq('user_id',user.id).maybeSingle();
 if(ticketErr||!ticket||ticket.status!=='closed')return res.status(403).json({error:'Avaliação disponível somente para ticket encerrado da sua conta'});
 const {data:items}=await db.from('order_items').select('product_name').eq('order_id',ticket.order_id).limit(1);
 const productName=String(items?.[0]?.product_name||'Compra na KANEKI STORE').slice(0,180);
 const {error:insertErr}=await db.from('kaneki_ticket_feedback').insert({ticket_id:ticketId,order_id:ticket.order_id,user_id:user.id,product_name:productName,rating,comment,is_public:false});
 if(insertErr){if(insertErr.code==='23505')return res.status(409).json({error:'Você já avaliou este ticket'});return res.status(500).json({error:'Não foi possível salvar a avaliação: '+insertErr.message})}
 return res.json({ok:true});
}

export default async function handler(req,res){
  if(['feedback','public'].includes(String(req.query?.mode||'')))return feedbackHandler(req,res);
  if(req.query?.mode==='messages') return ticketMessages(req,res);
  return listTickets(req,res);
}
