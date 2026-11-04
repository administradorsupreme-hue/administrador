
import {createClient} from '@supabase/supabase-js';
// GET /api/brand-image?kind=share|icon
// Public images only. Never returns user information or service credentials.
export default async function handler(req,res){
  res.setHeader('Cache-Control','public, max-age=60, s-maxage=60');
  res.setHeader('X-Content-Type-Options','nosniff');
  const kind=String(req.query?.kind||'share').toLowerCase()==='icon'?'icon':'share';
  const origin='https://ccgquinques-dun.vercel.app';
  const fallback=origin+(kind==='icon'?'/assets/kaneki-favicon-default.png':'/assets/kaneki-link-default.png');
  if(req.method!=='GET')return res.status(405).end();
  try{
    const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
    if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)return res.redirect(302,fallback);
    const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data,error}=await db.from('kaneki_site_design').select('share_image_url,favicon_image_url').eq('id',1).maybeSingle();
    if(error||!data)return res.redirect(302,fallback);
    const url=data[kind==='icon'?'favicon_image_url':'share_image_url'];
    if(!url)return res.redirect(302,fallback);
    const u=new URL(url),sup=new URL(SUPABASE_URL);
    if(u.protocol!=='https:'||u.host!==sup.host||!u.pathname.startsWith('/storage/v1/object/public/kaneki-brand/'))return res.redirect(302,fallback);
    const response=await fetch(u.toString(),{signal:AbortSignal.timeout(6000)});
    if(!response.ok)return res.redirect(302,fallback);
    const mime=(response.headers.get('content-type')||'').split(';')[0].toLowerCase();
    if(!['image/png','image/jpeg','image/webp'].includes(mime))return res.redirect(302,fallback);
    const length=Number(response.headers.get('content-length')||0);
    if(length>2500000)return res.redirect(302,fallback);
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length>2500000)return res.redirect(302,fallback);
    res.setHeader('Content-Type',mime);
    return res.status(200).send(bytes);
  }catch(e){console.warn('brand-image fallback',e?.message||e);return res.redirect(302,fallback);}
}
