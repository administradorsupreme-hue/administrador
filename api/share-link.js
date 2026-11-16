import {createClient} from '@supabase/supabase-js';

// Share-specific page: live Open Graph tags with a versioned URL per image.
// Visitors are redirected immediately to the storefront.
const ORIGIN='https://ccgquinques-dun.vercel.app';
const escapeAttr=s=>String(s).replace(/[&"'<>]/g,c=>({'&':'&amp;','"':'&quot;',"'":'&#39;','<':'&lt;','>':'&gt;'}[c]));
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store, max-age=0, must-revalidate');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='GET')return res.status(405).end();
  let image=ORIGIN+'/assets/kaneki-link-default.png';
  try{
    const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
    if(SUPABASE_URL&&SUPABASE_SERVICE_ROLE_KEY){
      const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
      const {data,error}=await db.from('kaneki_site_design').select('share_image_url').eq('id',1).maybeSingle();
      const value=data?.share_image_url;
      if(!error&&value){
        const candidate=new URL(value),sup=new URL(SUPABASE_URL);
        if(candidate.protocol==='https:'&&candidate.host===sup.host&&candidate.pathname.startsWith('/storage/v1/object/public/kaneki-brand/')){
          image=candidate.toString();
        }
      }
    }
  }catch(e){console.warn('share-link: fallback image:',e?.message||e);}
  // Version every image URL based on its unique upload path to bypass image caches.
  const version=encodeURIComponent(String(req.query?.image||'').slice(0,120));
  if(version){image+=(image.includes('?')?'&':'?')+'rev='+version;}
  const page=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta property="og:type" content="website"><meta property="og:site_name" content="KANEKI STORE"><meta property="og:title" content="KANEKI STORE | Produtos digitais"><meta property="og:description" content="Blox Fruits, Robux e outros produtos digitais com Pix e CCGWallet.">
<meta property="og:url" content="${escapeAttr(ORIGIN)}"><meta property="og:image" content="${escapeAttr(image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="KANEKI STORE"><meta name="twitter:image" content="${escapeAttr(image)}">
<meta http-equiv="refresh" content="0;url=${escapeAttr(ORIGIN)}"><link rel="canonical" href="${escapeAttr(ORIGIN)}"><title>KANEKI STORE</title></head><body><p>Redirecionando para a <a href="${escapeAttr(ORIGIN)}">KANEKI STORE</a>...</p><script>location.replace(${JSON.stringify(ORIGIN)});</script></body></html>`;
  res.setHeader('Content-Type','text/html; charset=utf-8');
  return res.status(200).send(page);
}
