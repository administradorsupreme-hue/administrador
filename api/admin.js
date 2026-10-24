import {createClient} from '@supabase/supabase-js';
export default async function handler(req,res){
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
 const send=async q=>{const {data,error}=await q;if(error)throw Error(error.message);return data};
 try{
 const action=req.method==='GET'?req.query.action:req.body?.action;
 if(action==='access')return res.json({allowed:true});
 if(action==='overview'){
  const [products,categories,tickets,orders]=await Promise.all([send(db.from('products').select('id,name,category,price_cents,image_url,is_active,description,stock_quantity,infinite_stock').order('name').limit(500)),send(db.from('kaneki_store_categories').select('*').order('name')),send(db.from('kaneki_tickets').select('id,order_id,user_id,status,created_at').order('created_at',{ascending:false}).limit(100)),send(db.from('orders').select('id,status,created_at').order('created_at',{ascending:false}).limit(100))]);
  return res.json({products,categories,tickets,orders});
 }
 if(action==='messages'){
  const ticketId=String(req.query.ticketId||'');if(!/^[\da-f-]{36}$/i.test(ticketId))return res.status(400).json({error:'Ticket inválido'});
  return res.json({messages:await send(db.from('kaneki_ticket_messages').select('id,body,sender_id,created_at').eq('ticket_id',ticketId).order('created_at'))});
 }
 if(req.method!=='POST')return res.status(400).json({error:'Ação inválida'});
 const b=req.body||{};
 if(action==='saveProduct'){
  const name=String(b.name||'').trim(),category=String(b.category||'').trim(),price=Number(b.price);
  if(!name||name.length>160||!category||category.length>100||!Number.isFinite(price)||price<0||price>1000000)return res.status(400).json({error:'Dados do produto inválidos'});
  const row={name,category,price_cents:Math.round(price*100),description:String(b.description||'').slice(0,3000),image_url:String(b.image_url||'').slice(0,2000)||null,is_active:b.is_active!==false};
  if(b.id)await send(db.from('products').update(row).eq('id',b.id).select());else await send(db.from('products').insert(row).select());
 }else if(action==='deleteProduct'){
  if(!b.id)return res.status(400).json({error:'Produto inválido'});
  await send(db.from('products').update({is_active:false}).eq('id',b.id));
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
  const icon_url=b.icon_url==null||b.icon_url===''?null:String(b.icon_url).trim();if(icon_url&&(!/^https:\/\//i.test(icon_url)||icon_url.length>2000))return res.status(400).json({error:'URL da imagem inválida'});await send(db.from('kaneki_store_categories').upsert({slug,name,color:/^#[\da-f]{6}$/i.test(b.color)?b.color:'#8b5cf6',icon_url},{onConflict:'slug'}));
 }else if(action==='deleteCategory'){
  const slug=String(b.slug||'');if(!slug||slug==='roblox')return res.status(400).json({error:'Categoria protegida'});
  const count=await send(db.from('products').select('id').eq('category',slug).eq('is_active',true).limit(1));
  if(count.length)return res.status(409).json({error:'Remova ou mova os produtos desta categoria antes'});
  await send(db.from('kaneki_store_categories').delete().eq('slug',slug));
 }else if(action==='reply'){
  const message=String(b.message||'').trim(),ticketId=String(b.ticketId||'');if(!message||message.length>5000||!/^[\da-f-]{36}$/i.test(ticketId))return res.status(400).json({error:'Mensagem inválida'});
  const t=await send(db.from('kaneki_tickets').select('id,status').eq('id',ticketId).maybeSingle());if(!t)return res.status(404).json({error:'Ticket não encontrado'});
  await send(db.from('kaneki_ticket_messages').insert({ticket_id:ticketId,sender_id:user.id,body:message}));
 }else if(action==='ticketStatus'){
  if(!['open','closed'].includes(b.status))return res.status(400).json({error:'Status inválido'});
  await send(db.from('kaneki_tickets').update({status:b.status}).eq('id',b.ticketId));
 }else return res.status(400).json({error:'Ação inválida'});
 return res.json({ok:true});
 }catch(e){console.error('admin',e);return res.status(500).json({error:e.message||'Erro interno'});}
}
