import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

async function listTickets(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET')return res.status(405).json({error:'Método não permitido'});
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:'Servidor não configurado'});
 const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const token=(req.headers.authorization||'').replace(/^Bearer /,'');
 const {data:{user},error}=await db.auth.getUser(token);
 if(error||!user)return res.status(401).json({error:'Entre na sua conta'});
 const {data,error:err}=await db.from('kaneki_tickets').select('id,order_id,user_id,status,created_at').eq('user_id',user.id).order('created_at',{ascending:false}).limit(300);
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
 if(mode==='feedbackPhoto'){
  if(req.method!=='POST')return res.status(405).json({error:'Método inválido'});
  const token=String(req.headers.authorization||'').replace(/^Bearer /i,'');
  const {data:{user},error:authError}=await db.auth.getUser(token);
  if(authError||!user)return res.status(401).json({error:'Entre na conta para anexar foto'});
  const ticketId=String(req.body?.ticketId||''),raw=String(req.body?.image||'');
  if(!UUID.test(ticketId)||raw.length>2100000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(raw))return res.status(400).json({error:'Envie uma foto JPG compactada (até 1,5 MB)'});
  const {data:t,error:te}=await db.from('kaneki_tickets').select('id').eq('id',ticketId).eq('user_id',user.id).eq('status','closed').maybeSingle();
  if(te||!t)return res.status(403).json({error:'Você só pode avaliar um ticket seu já encerrado'});
  const {data:old}=await db.from('kaneki_ticket_feedback').select('id').eq('ticket_id',ticketId).maybeSingle();
  if(old)return res.status(409).json({error:'Este ticket já foi avaliado'});
  const bytes=Buffer.from(raw.slice('data:image/jpeg;base64,'.length),'base64');
  if(!bytes.length||bytes.length>1500*1024||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)return res.status(400).json({error:'Arquivo de imagem inválido ou maior que 1,5 MB'});
  const path=`${ticketId}/${user.id}/${randomUUID()}.jpg`;
  const {error:uploadError}=await db.storage.from('kaneki-review-photos').upload(path,bytes,{contentType:'image/jpeg',upsert:false});
  if(uploadError)return res.status(500).json({error:'Falha no armazenamento da foto: '+uploadError.message});
  return res.json({path});
 }
 if(mode==='public'){
  if(req.method!=='GET')return res.status(405).json({error:'Método inválido'});
  const {data,error}=await db.from('kaneki_ticket_feedback').select('id,product_name,rating,comment,created_at,photo_path,reviewer_name,reviewer_avatar_url').eq('is_public',true).order('created_at',{ascending:false}).limit(30);
  if(error)return res.status(500).json({error:'Não foi possível carregar as avaliações'});
  const items=await Promise.all((data||[]).map(async row=>{
   let photo_url=null;
   if(row.photo_path){const {data:signed}=await db.storage.from('kaneki-review-photos').createSignedUrl(row.photo_path,1200);photo_url=signed?.signedUrl||null;}
   const {photo_path,...publicRow}=row;
   return {...publicRow,photo_url};
  }));
  return res.json({items});
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
 const allowPublic=req.body?.allowPublic===true;
 let photoPath=null;
 const requestedPath=String(req.body?.photoPath||'');
 if(requestedPath){
  const prefix=`${ticketId}/${user.id}/`;
  if(!requestedPath.startsWith(prefix)||!/^[-0-9a-f]{36}\.jpg$/i.test(requestedPath.slice(prefix.length)))return res.status(400).json({error:'Foto não pertence a este ticket'});
  const {data:stored,error:listError}=await db.storage.from('kaneki-review-photos').list(`${ticketId}/${user.id}`,{limit:100});
  if(listError||!(stored||[]).some(x=>x.name===requestedPath.slice(prefix.length)))return res.status(400).json({error:'Foto não encontrada no armazenamento'});
  photoPath=requestedPath;
 }
 const reviewerName=String(user.user_metadata?.full_name||user.user_metadata?.name||user.user_metadata?.user_name||'Cliente').trim().slice(0,70)||'Cliente';
 const avatar=String(user.user_metadata?.avatar_url||user.user_metadata?.picture||'');
 const reviewerAvatarUrl=/^https:\/\/[^\s<>"']{1,1500}$/i.test(avatar)?avatar:null;
 const {data:items}=await db.from('order_items').select('product_name').eq('order_id',ticket.order_id).limit(1);
 const productName=String(items?.[0]?.product_name||'Compra na KANEKI STORE').slice(0,180);
 const {error:insertErr}=await db.from('kaneki_ticket_feedback').insert({ticket_id:ticketId,order_id:ticket.order_id,user_id:user.id,product_name:productName,rating,comment,is_public:false,allow_public:allowPublic,photo_path:photoPath,reviewer_name:reviewerName,reviewer_avatar_url:reviewerAvatarUrl});
 if(insertErr){if(insertErr.code==='23505')return res.status(409).json({error:'Você já avaliou este ticket'});return res.status(500).json({error:'Não foi possível salvar a avaliação: '+insertErr.message})}
 return res.json({ok:true});
}

export default async function handler(req,res){
  // A Vercel normalmente preenche req.query; aceitar também o body evita
  // um POST cair por engano na rota de listagem (que permite só GET).
  let urlMode='';
  try{urlMode=new URL(req.url||'/', 'http://localhost').searchParams.get('mode')||'';}catch(_error){}
  const mode=String(req.query?.mode||req.body?.mode||urlMode||'');
  if(mode==='capabilities'){
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Kaneki-Review-Api','2');
    if(req.method!=='GET')return res.status(405).json({error:'Método inválido'});
    return res.status(200).json({reviewApi:2,feedback:true,photo:true});
  }
  if(['feedback','public','feedbackPhoto'].includes(mode)){
    res.setHeader('X-Kaneki-Review-Api','2');
    // Compatibilidade quando a requisição chegar com mode no body/URL.
    req.query={...(req.query||{}),mode};
    return feedbackHandler(req,res);
  }
  if(mode==='messages')return ticketMessages(req,res);
  return listTickets(req,res);
}
