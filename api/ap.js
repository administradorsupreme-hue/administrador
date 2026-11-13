import {createClient} from '@supabase/supabase-js';
const modes=['mobile','emulador','misto'];
const gels=['normal','infinito','tres'];
const amounts=[50,30,20,10,5,3,2,1,0.5,0.3,0.2,0.1];
const squads=[1,2,3,4];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store, private');
 if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Método inválido'});
 const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
 if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:'Supabase não configurado no servidor'});
 const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 const {data:{user},error:authError}=await db.auth.getUser(token);
 if(authError||!user)return res.status(401).json({error:'Entre com sua conta para acessar o AP'});
 const action=String((req.method==='GET'?req.query?.action:req.body?.action)||'status');
 try{
  if(action==='status'){
   const {data:entries,error:e}=await db.from('ap_entries').select('id,mode,gelo,amount,squad,status,match_id,created_at').eq('user_id',user.id).in('status',['waiting','matched']).order('created_at',{ascending:false}).limit(1);
   if(e)throw e;
   let match=null;
   if(entries?.[0]?.match_id){const r=await db.from('ap_matches').select('id,mode,gelo,amount,squad,players,created_at,status').eq('id',entries[0].match_id).maybeSingle();if(r.error)throw r.error;match=r.data;}
   const {data:waiting,error:w}=await db.from('ap_entries').select('mode,gelo,amount,squad').eq('status','waiting').limit(1000);
   if(w)throw w;
   const counts={};for(const item of waiting||[]){const key=[item.mode,item.gelo,item.amount,item.squad].join(':');counts[key]=(counts[key]||0)+1;}
   return res.status(200).json({entry:entries?.[0]||null,match,counts});
  }
  if(action==='join'){
   const {mode,gelo}=req.body||{},amount=Number(req.body?.amount),squad=Number(req.body?.squad);
   if(!modes.includes(mode)||!gels.includes(gelo)||!amounts.includes(amount)||!squads.includes(squad))return res.status(400).json({error:'Modalidade inválida'});
   const name=String(user.user_metadata?.full_name||user.user_metadata?.name||user.email?.split('@')[0]||'Jogador').trim().slice(0,50);
   const {data,error}=await db.rpc('ap_join_queue',{p_user:user.id,p_name:name,p_mode:mode,p_gelo:gelo,p_amount:amount,p_squad:squad});
   if(error)throw error;
   return res.json({ok:true,result:data});
  }
  if(action==='leave'){
   const {error}=await db.from('ap_entries').update({status:'cancelled'}).eq('user_id',user.id).in('status',['waiting','matched']);if(error)throw error;return res.json({ok:true});
  }
  if(action==='messages'){
   const id=String(req.query?.matchId||'');if(!uuid.test(id))return res.status(400).json({error:'Partida inválida'});
   const {data:match,error:e}=await db.from('ap_matches').select('id,players,mode,gelo,amount,squad,status').eq('id',id).maybeSingle();if(e)throw e;
   if(!match||!match.players.includes(user.id))return res.status(403).json({error:'Você não participa desta partida'});
   const {data:messages,error:m}=await db.from('ap_messages').select('id,sender_id,sender_name,body,created_at').eq('match_id',id).order('created_at',{ascending:true}).limit(200);if(m)throw m;
   return res.json({match,messages:messages||[]});
  }
  if(action==='send'){
   const id=String(req.body?.matchId||''),body=String(req.body?.message||'').trim();
   if(!uuid.test(id)||!body||body.length>1500)return res.status(400).json({error:'Mensagem inválida (máximo 1500 caracteres)'});
   const {data:match,error:e}=await db.from('ap_matches').select('players,status').eq('id',id).maybeSingle();if(e)throw e;
   if(!match||!match.players.includes(user.id)||match.status!=='open')return res.status(403).json({error:'Partida indisponível'});
   const name=String(user.user_metadata?.full_name||user.user_metadata?.name||user.email?.split('@')[0]||'Jogador').trim().slice(0,50);
   const {error:m}=await db.from('ap_messages').insert({match_id:id,sender_id:user.id,sender_name:name,body});if(m)throw m;
   return res.json({ok:true});
  }
  return res.status(400).json({error:'Ação desconhecida'});
 }catch(e){console.error('AP:',e);return res.status(500).json({error:e.code==='PGRST202'?'Instale o SQL do AP no Supabase antes de usar.':e.code==='42P01'||e.code==='PGRST205'?'Tabelas do AP não instaladas. Execute o SQL fornecido.':e.message||'Falha no servidor'});}
}
