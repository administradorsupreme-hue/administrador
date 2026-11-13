import {createClient} from '@supabase/supabase-js';
const modes=['mobile','emulador','misto'];
const gels=['normal','infinito','tres'];
const amounts=[50,30,20,10,5,3,2,1,0.5,0.3,0.2,0.1];
const squads=[1,2,3,4];

const DEFAULT_AP_SETTINGS={
 title:'AP Apostado',subtitle:'Encontre jogadores para partidas 1v1, 2v2, 3v3 ou 4v4.',
 amounts:[50,30,20,10,5,3,2,1,0.5,0.3,0.2,0.1],
 enabled:{mobile:[1,2,3,4],emulador:[1,2,3,4],misto:[2,3,4]},
 labels:{mobile:'Mobile',emulador:'Emulador',misto:'Misto'},
 options:{'mobile-1':['🧊 Gelo Normal','❄️ Gelo Infinito'],'emulador-1':['🧊 Gelo Normal','❄️ Gelo Infinito'],
 'mobile-2':['✅ Normal','🔫 Full Ump Xm8'],'mobile-3':['✅ Normal','🔫 Full Ump Xm8'],'mobile-4':['✅ Normal','🔫 Full Ump Xm8'],
 'emulador-2':['✅ Normal','🔫 Full Ump Xm8'],'emulador-3':['✅ Normal','🔫 Full Ump Xm8'],'emulador-4':['✅ Normal','🔫 Full Ump Xm8'],
 'misto-2':['🖥️ 1 Emu'],'misto-3':['🖥️ 1 Emu','🖥️ 2 Emu'],'misto-4':['🖥️ 1 Emu','🖥️ 2 Emu','🖥️ 3 Emu']},
 roomImage:'',buttonText:'AP'
};
async function apSettings(db){const {data,error}=await db.from('ap_settings').select('config').eq('id',1).maybeSingle();if(error)throw error;return {...DEFAULT_AP_SETTINGS,...data?.config,options:{...DEFAULT_AP_SETTINGS.options,...data?.config?.options},enabled:{...DEFAULT_AP_SETTINGS.enabled,...data?.config?.enabled}};}

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
   const settings=await apSettings(db);
   const {data:entries,error:e}=await db.from('ap_entries').select('id,mode,gelo,amount,squad,status,match_id,created_at').eq('user_id',user.id).in('status',['waiting','matched']).order('created_at',{ascending:false}).limit(1);
   if(e)throw e;
   let match=null;
   if(entries?.[0]?.match_id){const r=await db.from('ap_matches').select('id,mode,gelo,amount,squad,players,created_at,status').eq('id',entries[0].match_id).maybeSingle();if(r.error)throw r.error;match=r.data;}
   if(match){
    const link=await db.from('ap_ticket_links').select('ticket_id').eq('match_id',match.id).maybeSingle();if(link.error)throw link.error;
    if(link.data?.ticket_id){
     const t=await db.from('kaneki_tickets').select('id,status').eq('id',link.data.ticket_id).maybeSingle();if(t.error)throw t.error;
     if(t.data?.status==='closed'){
      const end=await db.rpc('ap_close_ticket',{p_user:user.id,p_ticket:link.data.ticket_id});if(end.error)throw end.error;
      match=null;entries.length=0;
     }else match.ticket_id=link.data.ticket_id;
    }
    if(match&&!match.ticket_id){const t=await db.rpc('ap_ensure_ticket',{p_match:match.id});if(t.error)throw t.error;match.ticket_id=t.data;}
   }
   const {data:waiting,error:w}=await db.from('ap_entries').select('mode,gelo,amount,squad').eq('status','waiting').limit(1000);
   if(w)throw w;
   const counts={};for(const item of waiting||[]){const key=[item.mode,item.gelo,item.amount,item.squad].join(':');counts[key]=(counts[key]||0)+1;}
   return res.status(200).json({entry:entries?.[0]||null,match,counts,settings});
  }
  if(action==='join'){
   const {mode,gelo}=req.body||{},amount=Number(req.body?.amount),squad=Number(req.body?.squad);
   const settings=await apSettings(db);
   const options=settings.options?.[`${mode}-${squad}`]||[];
   const choiceIndex={normal:0,infinito:1,tres:2}[gelo];
   if(!modes.includes(mode)||!gels.includes(gelo)||!settings.amounts.includes(amount)||!squads.includes(squad)||!settings.enabled?.[mode]?.includes(squad)||choiceIndex===undefined||choiceIndex>=options.length)return res.status(400).json({error:'Sala ou valor desativado pelo administrador'});
   const name=String(user.user_metadata?.full_name||user.user_metadata?.name||user.email?.split('@')[0]||'Jogador').trim().slice(0,50);
   const {data,error}=await db.rpc('ap_join_queue',{p_user:user.id,p_name:name,p_mode:mode,p_gelo:gelo,p_amount:amount,p_squad:squad});
   if(error)throw error;
   return res.json({ok:true,result:data});
  }
  if(action==='leave'){
   // Não permitir que a pessoa abandone uma partida já formada sem encerrar o ticket.
   const active=await db.from('ap_entries').select('id').eq('user_id',user.id).eq('status','matched').limit(1);if(active.error)throw active.error;
   if(active.data?.length)return res.status(409).json({error:'Encerre seu ticket de AP antes de entrar em outra partida.'});
   const {error}=await db.from('ap_entries').update({status:'cancelled'}).eq('user_id',user.id).eq('status','waiting');if(error)throw error;return res.json({ok:true});
  }
  if(action==='closeTicket'){
   const id=String(req.body?.ticketId||'');if(!uuid.test(id))return res.status(400).json({error:'Ticket inválido'});
   const result=await db.rpc('ap_close_ticket',{p_user:user.id,p_ticket:id});
   if(result.error){if(result.error.message?.includes('not participant'))return res.status(403).json({error:'Você não participa desse ticket'});throw result.error;}
   return res.json({ok:true});
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
