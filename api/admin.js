import {createCipheriv,randomBytes,createHash} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
export default async function handler(req,res){
 // Compatibilidade com a aba Personalização sem criar outra função serverless.
 const extraActions = new Set(['settings','saveSettings','coupons','saveCoupon','notifications','addNotification','sales','orders','customers']);
 const requestedAction = req.method === 'GET' ? req.query?.action : req.body?.action;
 if(req.query?.extra === '1' || extraActions.has(requestedAction)) return adminExtrasHandler(req,res);
 res.setHeader('Cache-Control','no-store');
 if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Método inválido'});
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:'Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY na Vercel'});
 const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const token=(req.headers.authorization||'').replace(/^Bearer /i,'');
 const {data:{user},error:authError}=await db.auth.getUser(token);
 if(authError||!user)return res.status(401).json({error:'Faça login na loja'});
 const {data:member,error:memberError}=await db.from('kaneki_admins').select('*').eq('user_id',user.id).maybeSingle();
 if(memberError||!member)return res.status(403).json({error:'Sua conta não tem permissão de administrador'});
 const isOwner=String(user.email||'').toLowerCase()===String(process.env.KANEKI_OWNER_EMAIL||'administradorsupreme@gmail.com').toLowerCase();
 const send=async q=>{const {data,error}=await q;if(error)throw Error(error.message);return data};
 try{
 const action=req.method==='GET'?req.query.action:req.body?.action;
 if(action==='access')return res.json({allowed:true,owner:String(user.email||'').toLowerCase()==='administradorsupreme@gmail.com'});
 if(['adminList','adminGrant','adminRevoke'].includes(action)){
   if(String(user.email||'').toLowerCase()!=='administradorsupreme@gmail.com')return res.status(403).json({error:'Somente o proprietário pode gerenciar administradores'});
   const findUser=async term=>{
     const query=String(term||'').trim().toLowerCase();
     if(!query||query.length>160)return null;
     for(let page=1;page<=30;page++){
       const {data,error}=await db.auth.admin.listUsers({page,perPage:100});
       if(error)throw error;
       const users=data?.users||[];
       const found=users.find(u=>String(u.email||'').toLowerCase()===query||
         [u.user_metadata?.username,u.user_metadata?.user_name,u.user_metadata?.name,u.user_metadata?.full_name].some(n=>String(n||'').toLowerCase()===query));
       if(found)return found;
       if(users.length<100)break;
     }
     return null;
   };
   if(action==='adminList'){
     const members=await send(db.from('kaneki_admins').select('user_id'));
     const items=[];
     for(const m of members){
       const {data,error}=await db.auth.admin.getUserById(m.user_id);
       if(error)continue;
       const u=data?.user;
       if(u)items.push({id:u.id,email:u.email||'',username:u.user_metadata?.username||u.user_metadata?.user_name||u.user_metadata?.name||'',owner:String(u.email||'').toLowerCase()==='administradorsupreme@gmail.com'});
     }
     return res.json({items});
   }
   if(req.method!=='POST')return res.status(405).json({error:'Método inválido'});
   const target=await findUser(req.body?.identifier);
   if(!target)return res.status(404).json({error:'Usuário não encontrado. A pessoa precisa ter conta cadastrada no site.'});
   if(action==='adminGrant'){
     await send(db.from('kaneki_admins').upsert({user_id:target.id},{onConflict:'user_id'}));
     return res.json({ok:true,email:target.email});
   }
   if(String(target.email||'').toLowerCase()==='administradorsupreme@gmail.com')return res.status(403).json({error:'O proprietário não pode ser removido'});
   await send(db.from('kaneki_admins').delete().eq('user_id',target.id));
   return res.json({ok:true});
 }
 if(action==='access')return res.json({allowed:true});
 if(action==='overview'){
  const [products,categories,tickets,orders]=await Promise.all([send(db.from('products').select('id,name,category,price_cents,image_url,is_active,description,stock_quantity,infinite_stock,delivery_type').order('name').limit(500)),send(db.from('kaneki_store_categories').select('*').order('name')),isOwner?send(db.from('kaneki_tickets').select('id,order_id,user_id,status,created_at').eq('status','open').order('created_at',{ascending:false}).limit(100)):Promise.resolve([]),send(db.from('orders').select('id,status,created_at').order('created_at',{ascending:false}).limit(100))]);
  // Customer names and profile images for the WhatsApp-style owner inbox.
  // Do not expose client profiles to other admins or unauthenticated users.
  const customerIds=[...new Set(tickets.map(t=>t.user_id).filter(Boolean))];
  const customerProfiles=new Map();
  if(isOwner){
   await Promise.all(customerIds.map(async id=>{
    try{
     const {data,error}=await db.auth.admin.getUserById(id);
     if(error||!data?.user)return;
     const account=data.user,meta=account.user_metadata||{};
     const rawAvatar=String(meta.avatar_url||meta.picture||'').trim();
     const avatar_url=/^https:\/\/[^\s]+$/i.test(rawAvatar)?rawAvatar.slice(0,1000):null;
     const name=String(meta.full_name||meta.name||meta.user_name||meta.username||account.email?.split('@')[0]||'Cliente').slice(0,90);
     customerProfiles.set(id,{name,email:String(account.email||'').slice(0,254),avatar_url});
    }catch(err){console.warn('Perfil do ticket indisponível',err?.message)}
   }));
  }
  const ticketOrderIds=[...new Set(tickets.map(t=>t.order_id).filter(Boolean))];
  const itemsByOrder=new Map();
  if(isOwner&&ticketOrderIds.length){
   for(let i=0;i<ticketOrderIds.length;i+=100){
    const batch=ticketOrderIds.slice(i,i+100);
    const {data:items,error:ie}=await db.from('order_items').select('order_id,product_name,product_image_url,quantity').in('order_id',batch);
    if(ie){console.warn('Produtos dos tickets indisponíveis:',ie.message);break;}
    for(const item of items||[]){const list=itemsByOrder.get(item.order_id)||[];list.push({name:item.product_name,image_url:item.product_image_url,quantity:item.quantity});itemsByOrder.set(item.order_id,list)}
   }
  }
  return res.json({products,categories,tickets:tickets.map(t=>({...t,customer:customerProfiles.get(t.user_id)||{name:'Cliente',email:'',avatar_url:null},items:itemsByOrder.get(t.order_id)||[]})),orders});
 }
 if(action==='stockList'){
  const productId=String(req.query.productId||'');if(!productId||productId.length>300)return res.status(400).json({error:'Produto inválido'});
  const items=await send(db.from('kaneki_account_stock').select('id,username_hint,status,created_at').eq('product_id',productId).order('created_at',{ascending:false}).limit(500));
  return res.json({items,available:items.filter(x=>x.status==='available').length});
 }
 if(action==='feedbackList'){
  if(!isOwner)return res.status(403).json({error:'Somente o proprietário pode gerenciar avaliações'});
  const rows=await send(db.from('kaneki_ticket_feedback').select('id,ticket_id,order_id,user_id,product_name,rating,comment,is_public,created_at').order('created_at',{ascending:false}).limit(300));
  const ids=[...new Set(rows.map(x=>x.user_id))];const names=new Map();
  await Promise.all(ids.map(async id=>{try{const {data}=await db.auth.admin.getUserById(id);const u=data?.user;names.set(id,{name:String(u?.user_metadata?.full_name||u?.user_metadata?.name||u?.email?.split('@')[0]||'Cliente').slice(0,100),email:u?.email||''})}catch(e){}}));
  return res.json({items:rows.map(x=>({...x,customer:names.get(x.user_id)||{name:'Cliente',email:''}}))});
 }
 if(action==='messages'){
  if(!isOwner)return res.status(403).json({error:'Somente o dono pode visualizar os tickets dos clientes'});
  const ticketId=String(req.query.ticketId||'');if(!/^[\da-f-]{36}$/i.test(ticketId))return res.status(400).json({error:'Ticket inválido'});
  const ticket=await send(db.from('kaneki_tickets').select('id').eq('id',ticketId).maybeSingle());
  if(!ticket)return res.status(404).json({error:'Ticket não encontrado'});
  const messages=await send(db.from('kaneki_ticket_messages').select('id,body,sender_id,created_at,file_path').eq('ticket_id',ticketId).order('created_at'));
  const mapped=await Promise.all(messages.map(async m=>{
    let attachments=[];if(m.file_path?.startsWith(ticketId+'/')){
     const {data:link}=await db.storage.from('kaneki-ticket-files').createSignedUrl(m.file_path,180);
     if(link?.signedUrl){const name=m.file_path.split('/').pop().replace(/^[\da-f-]{36}-/i,'');const ext=name.split('.').pop().toLowerCase();const mime={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',zip:'application/zip',pdf:'application/pdf'}[ext]||'application/octet-stream';attachments=[{url:link.signedUrl,name,mime,is_image:['jpg','jpeg','png','webp'].includes(ext)}];}
    }
    return {...m,sender_role:m.sender_id===user.id?'admin':'customer',attachments};
  }));
  return res.json({messages:mapped});
 }
 if(req.method!=='POST')return res.status(400).json({error:'Ação inválida'});
 const b=req.body||{};
 if(action==='saveProduct'){
  const name=String(b.name||'').trim(),category=String(b.category||'').trim(),price=Number(b.price);
  if(!name||name.length>160||!category||category.length>100||!Number.isFinite(price)||price<0||price>1000000)return res.status(400).json({error:'Dados do produto inválidos'});
  const deliveryType=b.delivery_type==='ticket'?'ticket':'account';const row={name,category,delivery_type:deliveryType,infinite_stock:deliveryType==='ticket',price_cents:Math.round(price*100),description:String(b.description||'').slice(0,3000),image_url:String(b.image_url||'').slice(0,2000)||null,is_active:b.is_active!==false};
  const saved=b.id?await send(db.from('products').update(row).eq('id',b.id).select('id')):await send(db.from('products').insert(row).select('id'));
  return res.json({ok:true,id:saved?.[0]?.id||b.id});
 }else if(action==='deleteProduct'){
  if(!b.id)return res.status(400).json({error:'Produto inválido'});
  const old=await send(db.from('products').select('id').eq('id',b.id).maybeSingle());if(!old)return res.status(404).json({error:'Produto não encontrado'});
  await send(db.from('kaneki_account_stock').delete().eq('product_id',b.id));
  await send(db.from('products').delete().eq('id',b.id));
  }else if(action==='stockAdd'){
  const productId=String(b.productId||''),username=String(b.username||'').trim(),password=String(b.password||''),details=String(b.details||'');
  if(!productId||productId.length>300||username.length>300||password.length>1000||details.length>4000)return res.status(400).json({error:'Dados do estoque inválidos'});
  const product=await send(db.from('products').select('id,delivery_type').eq('id',productId).maybeSingle());if(!product)return res.status(404).json({error:'Produto não encontrado'});if(product.delivery_type==='ticket')return res.status(409).json({error:'Este produto utiliza entrega por ticket, não estoque de contas'});
  let fileInfos=[];
  const incoming=b.attachments||[];
  if(!Array.isArray(incoming)||incoming.length>5)return res.status(400).json({error:'Máximo de 5 anexos por entrega'});
  for(const a of incoming){
   if(!a||typeof a.path!=='string'||!a.path.startsWith('deliveries/'+user.id+'/')||a.path.length>250)return res.status(400).json({error:'Anexo inválido'});
   const {data:obj,error:objErr}=await db.storage.from('kaneki-private-deliveries').createSignedUrl(a.path,60);
   if(objErr||!obj?.signedUrl)return res.status(400).json({error:'Arquivo não encontrado no armazenamento privado'});
   const mime=String(a.mime||'');
   const allowed=['image/png','image/jpeg','image/webp','video/mp4','video/webm','application/pdf','text/plain','application/zip'];
   const isZip=/\.zip$/i.test(String(a.name||a.path||''));
   const maxSize=isZip?50000000:40*1024*1024;
   if(!allowed.includes(mime)||!Number.isFinite(Number(a.size))||Number(a.size)<=0||Number(a.size)>maxSize|| (isZip&&mime!=='application/zip'))return res.status(400).json({error:'Tipo/tamanho de anexo inválido (ZIP: até 50 MB)'});
   fileInfos.push({path:a.path,name:String(a.name||'Arquivo').slice(0,100),mime,size:Number(a.size||0)});
  }
  // Compatível com produtos de estoque cadastrados no sistema anterior.
  if(b.attachment){
   const match=/^data:(application\/pdf|text\/plain|application\/zip|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.attachment));
   if(!match)return res.status(400).json({error:'Formato antigo de anexo inválido'});
   const bytes=Buffer.from(match[2],'base64');if(!bytes.length||bytes.length>4*1024*1024)return res.status(400).json({error:'Arquivo inválido ou maior que 4 MB'});
   const mime=match[1],ext={'application/pdf':'pdf','text/plain':'txt','application/zip':'zip','image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[mime];
   const path=`deliveries/${user.id}/${randomBytes(16).toString('hex')}.${ext}`;
   const {error}=await db.storage.from('kaneki-private-deliveries').upload(path,bytes,{contentType:mime,upsert:false});if(error)throw Error('Falha ao anexar: '+error.message);
   fileInfos.push({path,name:String(b.filename||'arquivo').slice(0,100),mime,size:bytes.length});
  }
  if(!username&&!password&&!details&&!fileInfos.length)return res.status(400).json({error:'Adicione conteúdo para entrega'});
  const secret=process.env.STOCK_ENCRYPTION_KEY;if(!secret||secret.length<32)return res.status(503).json({error:'Configure STOCK_ENCRYPTION_KEY na Vercel (mínimo 32 caracteres)'});
  const key=createHash('sha256').update(secret).digest(),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  const encrypted=Buffer.concat([cipher.update(JSON.stringify({username,password,details,fileInfo:fileInfos[0]||null,fileInfos}),'utf8'),cipher.final()]);
  const payload=Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
  await send(db.from('kaneki_account_stock').insert({product_id:productId,username_hint:username?username.slice(0,2)+'***':(fileInfos.length?'📎 Arquivo':'📝 Descrição'),encrypted_data:payload,status:'available'}));
 }else if(action==='stockDelete'){
  const id=String(b.id||'');if(!/^[0-9a-f-]{36}$/i.test(id))return res.status(400).json({error:'Unidade inválida'});
  await send(db.from('kaneki_account_stock').delete().eq('id',id));
 }else if(action==='uploadCategoryIcon'){
  const input=String(b.image||'');const m=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(input);
  if(!m)return res.status(400).json({error:'Imagem inválida: use PNG, JPG ou WEBP'});
  const bytes=Buffer.from(m[2],'base64');if(!bytes.length||bytes.length>2*1024*1024)return res.status(400).json({error:'Imagem deve ter até 2 MB'});
  const signature=m[1]==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):m[1]==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
  if(!signature)return res.status(400).json({error:'Conteúdo da imagem inválido'});
  const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[m[1]];
  const path=`categories/${user.id}/${crypto.randomUUID()}.${ext}`;
  const {error}=await db.storage.from('category-icons').upload(path,bytes,{contentType:m[1],upsert:false,cacheControl:'3600'});
  if(error)throw Error('Falha ao enviar imagem: '+error.message);
  const {data:publicUrl}=db.storage.from('category-icons').getPublicUrl(path);
  return res.json({url:publicUrl.publicUrl});
 }else if(action==='saveCategory'){
  const name=String(b.name||'').trim();if(!name||name.length>100)return res.status(400).json({error:'Nome inválido'});
  const slug=b.slug?String(b.slug).trim():name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  if(!slug)return res.status(400).json({error:'Nome inválido'});
  const icon_url=b.icon_url==null||b.icon_url===''?null:String(b.icon_url).trim();if(icon_url&&(!/^https:\/\//i.test(icon_url)||icon_url.length>2000))return res.status(400).json({error:'URL da imagem inválida'});await send(db.from('kaneki_store_categories').upsert({slug,name,color:/^#[\da-f]{6}$/i.test(b.color)?b.color:'#8b5cf6',color_secondary:/^#[\da-f]{6}$/i.test(b.color_secondary)?b.color_secondary:(/^#[\da-f]{6}$/i.test(b.color)?b.color:'#8b5cf6'),icon_url},{onConflict:'slug'}));
 }else if(action==='deleteCategory'){
  const slug=String(b.slug||'');if(!slug||slug==='roblox')return res.status(400).json({error:'Categoria protegida'});
  const count=await send(db.from('products').select('id').eq('category',slug).eq('is_active',true).limit(1));
  if(count.length)return res.status(409).json({error:'Remova ou mova os produtos desta categoria antes'});
  await send(db.from('kaneki_store_categories').delete().eq('slug',slug));
 }else if(action==='reply'){
  if(!isOwner)return res.status(403).json({error:'Somente o dono pode responder'});
  const message=String(b.message||'').trim(),ticketId=String(b.ticketId||''),attachments=b.attachments||[];
  if((!message&&!attachments.length)||message.length>5000||!/^[\da-f-]{36}$/i.test(ticketId)||!Array.isArray(attachments)||attachments.length>5)return res.status(400).json({error:'Mensagem inválida'});
  const t=await send(db.from('kaneki_tickets').select('id,status').eq('id',ticketId).maybeSingle());
  if(!t)return res.status(404).json({error:'Ticket não encontrado'});
  if(t.status!=='open')return res.status(409).json({error:'Ticket encerrado. Reabra para responder.'});
  for(const a of attachments){
   if(typeof a.path!=='string'||!a.path.startsWith(ticketId+'/'+user.id+'/')||a.path.length>300)return res.status(400).json({error:'Anexo inválido'});
   const {data:obj,error:uploadErr}=await db.storage.from('kaneki-ticket-files').createSignedUrl(a.path,60);
   if(uploadErr||!obj?.signedUrl)return res.status(400).json({error:'Anexo não encontrado'});
  }
  const rows=attachments.length?attachments.map((a,i)=>({ticket_id:ticketId,sender_id:user.id,body:i===0?message:'',file_path:a.path})):[{ticket_id:ticketId,sender_id:user.id,body:message}];
  await send(db.from('kaneki_ticket_messages').insert(rows));
 }else if(action==='feedbackPublish'){
  if(!isOwner)return res.status(403).json({error:'Somente o proprietário pode publicar avaliações'});
  if(!/^[\da-f-]{36}$/i.test(String(b.id||''))||typeof b.is_public!=='boolean')return res.status(400).json({error:'Avaliação inválida'});
  await send(db.from('kaneki_ticket_feedback').update({is_public:b.is_public}).eq('id',b.id));
 }else if(action==='ticketStatus'){
  if(!isOwner)return res.status(403).json({error:'Somente o dono pode encerrar tickets'});
  if(!['open','closed'].includes(b.status)||!/^[\da-f-]{36}$/i.test(String(b.ticketId||'')))return res.status(400).json({error:'Status inválido'});
  await send(db.from('kaneki_tickets').update({status:b.status}).eq('id',b.ticketId));
 }else return res.status(400).json({error:'Ação inválida'});
 return res.json({ok:true});
 }catch(e){console.error('admin',e);return res.status(500).json({error:e.message||'Erro interno'});}
}

async function adminExtrasHandler(req,res){res.setHeader('Cache-Control','no-store');if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Método inválido'});const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:'Configure o Supabase na Vercel'});const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});try{const token=(req.headers.authorization||'').replace(/^Bearer /i,'');if(!token)return res.status(401).json({error:'Sem sessão'});const {data:{user},error}=await db.auth.getUser(token);if(error||!user)return res.status(401).json({error:'Sessão inválida'});const {data:admin,error:ae}=await db.from('kaneki_admins').select('user_id').eq('user_id',user.id).maybeSingle();if(ae||!admin)return res.status(403).json({error:'Acesso restrito'});const act=req.method==='GET'?req.query.action:req.body?.action;const get=async q=>{const {data,error}=await q;if(error)throw error;return data};if(req.method==='GET'){if(act==='settings'){const rows=await get(db.from('kaneki_site_settings').select('key,value'));return res.json({settings:Object.fromEntries(rows.map(x=>[x.key,x.value]))})}if(act==='coupons')return res.json({items:await get(db.from('kaneki_coupons').select('*').order('created_at',{ascending:false}).limit(200))});if(act==='notifications')return res.json({items:await get(db.from('kaneki_notifications').select('*').order('created_at',{ascending:false}).limit(100))});if(['sales','orders','customers'].includes(act)){const rows=await get(db.from('orders').select('*').order('created_at',{ascending:false}).limit(500));const paid=rows.filter(x=>['paid','approved','completed','delivered'].includes(String(x.status).toLowerCase()));const amount=x=>Number(x.total_cents??x.amount_cents??0)||0;if(act==='sales')return res.json({count:rows.length,paid:paid.length,revenue:paid.reduce((n,x)=>n+amount(x),0)});if(act==='orders')return res.json({items:rows});const map=new Map();for(const o of rows){if(!o.user_id)continue;const a=map.get(o.user_id)||{cliente:o.user_id,pedidos:0,total:0};a.pedidos++;if(paid.includes(o))a.total+=amount(o)/100;map.set(o.user_id,a)}return res.json({items:[...map.values()].sort((a,b)=>b.pedidos-a.pedidos)})}return res.status(400).json({error:'Ação inválida'})}const b=req.body||{};if(act==='saveSettings'){const keys=['store_name','announcement','logo_url','banner_url','primary_color','discord_url'];const rows=keys.map(key=>({key,value:String(b[key]||'').slice(0,500)}));for(const row of rows){if(['logo_url','banner_url','discord_url'].includes(row.key)&&row.value&&!/^https:\/\//i.test(row.value))return res.status(400).json({error:'Use URLs HTTPS'});}await get(db.from('kaneki_site_settings').upsert(rows,{onConflict:'key'}));return res.json({ok:true})}if(act==='saveCoupon'){const code=String(b.code||'').trim().toUpperCase();const percent=Number(b.percent);if(!/^[A-Z0-9_-]{3,32}$/.test(code)||!Number.isInteger(percent)||percent<1||percent>100)return res.status(400).json({error:'Cupom inválido'});const max=b.max_uses?Number(b.max_uses):null;if(max!==null&&(!Number.isInteger(max)||max<1))return res.status(400).json({error:'Limite inválido'});await get(db.from('kaneki_coupons').upsert({code,percent,max_uses:max,expires_at:b.expires_at?new Date(b.expires_at).toISOString():null},{onConflict:'code'}));return res.json({ok:true})}if(act==='addNotification'){const title=String(b.title||'').trim().slice(0,120),body=String(b.body||'').trim().slice(0,2000);if(!title||!body)return res.status(400).json({error:'Preencha os campos'});await get(db.from('kaneki_notifications').insert({title,body,created_by:user.id}));return res.json({ok:true})}return res.status(400).json({error:'Ação inválida'})}catch(e){console.error('admin-extras',e);return res.status(500).json({error:e.message||'Erro interno'})}}

