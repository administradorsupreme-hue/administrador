import { createClient } from '@supabase/supabase-js';
import {createDecipheriv,createHash} from 'node:crypto';

const send = (res, code, body) => res.status(code).json(body);
const PAID = new Set(['paid', 'completed']);
const FAILED = new Set(['failed', 'refunded']);
const text = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return send(res, 405, { error: 'Método não permitido.' });
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ECLIPSE_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ECLIPSE_API_KEY) {
    return send(res, 500, { error: 'Configuração de pagamento incompleta no servidor.' });
  }
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return send(res, 401, { error: 'Faça login.' });
  const orderId = req.query?.orderId;
  if (typeof orderId !== 'string' || !/^[0-9a-f-]{36}$/i.test(orderId)) return send(res, 400, { error: 'Pedido inválido.' });

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await db.auth.getUser(auth.slice(7));
  if (authError || !authData?.user) return send(res, 401, { error: 'Sessão inválida. Entre novamente.' });
  const { data: order, error: orderError } = await db.from('orders')
    .select('id,user_id,status,total_cents,provider_charge_id')
    .eq('id', orderId).eq('user_id', authData.user.id).maybeSingle();
  if (orderError) return send(res, 500, { error: 'Falha ao consultar o pedido.' });
  if (!order) return send(res, 404, { error: 'Pedido não encontrado.' });

  let paymentStatus = order.status === 'fulfilled' || order.status === 'paid' ? 'completed' : order.status;
  if (order.status === 'pending') {
    if (!order.provider_charge_id) return send(res, 409, { error: 'Cobrança ainda não vinculada ao pedido. Contate o suporte com o número do pedido.' });
    let providerResponse;
    let payload;
    try {
      providerResponse = await fetch(`https://eclipsepaybr.com/v1/charges/${encodeURIComponent(order.provider_charge_id)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${ECLIPSE_API_KEY}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(9000)
      });
      payload = await providerResponse.json();
    } catch (err) {
      console.error('EclipsePay charge lookup failed:', err?.message);
      return send(res, 502, { error: 'Não foi possível consultar a cobrança na EclipsePay. Tente novamente em instantes.' });
    }
    if (!providerResponse.ok) {
      console.error('EclipsePay charge lookup HTTP:', providerResponse.status);
      return send(res, 502, { error: 'A EclipsePay não confirmou a consulta da cobrança.', providerHttpStatus: providerResponse.status });
    }
    // Some API clients wrap a resource in { data: {...} }; never trust a status without matching its charge ID and amount.
    const charge = payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : payload;
    if (!charge || String(charge.id ?? '') !== String(order.provider_charge_id)) {
      return send(res, 502, { error: 'A cobrança consultada não corresponde ao pedido.' });
    }
    const expected = Number(order.total_cents);
    const actual = Number(charge.amountCents);
    if (!Number.isSafeInteger(expected) || !Number.isSafeInteger(actual) || actual !== expected) {
      return send(res, 409, { error: 'Valor da cobrança diferente do total do pedido. Contate o suporte.' });
    }
    const providerStatus = text(charge.status);
    if (PAID.has(providerStatus)) {
      const { data: updated, error: updateError } = await db.from('orders')
        .update({ status: 'paid', paid_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', order.id).eq('status', 'pending').select('id').maybeSingle();
      if (updateError) return send(res, 500, { error: 'Pix aprovado, mas houve falha ao atualizar o pedido. Contate o suporte.' });
      // Another request may have updated the order concurrently; fetch the final state below.
      paymentStatus = 'completed';
    } else if (FAILED.has(providerStatus)) {
      const { error: updateError } = await db.from('orders')
        .update({ status: providerStatus, updated_at: new Date().toISOString() })
        .eq('id', order.id).eq('status', 'pending');
      if (updateError) return send(res, 500, { error: 'Não foi possível atualizar o estado da cobrança.' });
      paymentStatus = providerStatus;
    } else {
      paymentStatus = providerStatus || 'pending';
    }
  }

  const { data: current, error: currentError } = await db.from('orders')
    .select('id,status,paid_at,fulfilled_at').eq('id', order.id).eq('user_id', authData.user.id).single();
  if (currentError || !current) return send(res, 500, { error: 'Não foi possível consultar o pedido atualizado.' });

  // Ticket orders are handled by the private support workflow, not digital inventory.
  const { data: purchased, error: purchasedError } = await db.from('order_items')
    .select('product_id,products(delivery_type)').eq('order_id', order.id);
  if (purchasedError) return send(res, 500, { error: 'Falha ao identificar o tipo de entrega.' });
  const hasTicket = (purchased || []).some(item => item.products?.delivery_type === 'ticket');
  if (current.status === 'paid' && hasTicket) {
    const { data: ticket, error: ticketError } = await db.from('kaneki_tickets')
      .upsert({ order_id: order.id, user_id: authData.user.id }, { onConflict: 'order_id', ignoreDuplicates: true })
      .select('id').maybeSingle();
    if (ticketError) return send(res, 200, { orderId: order.id, paymentStatus: 'completed', orderStatus: 'paid', deliveryStatus: 'support_pending', message: 'Pagamento confirmado. Ticket aguardando criação pelo suporte.' });
    return send(res, 200, { orderId: order.id, paymentStatus: 'completed', orderStatus: 'paid', deliveryStatus: 'ticket', ticketId: ticket?.id || null, credentials: [], message: 'Pagamento confirmado. Abra Meus Tickets para conversar com a loja.' });
  }
  if (current.status === 'paid') {
    const { error: fulfillError } = await db.rpc('fulfill_kaneki_stock_order', { p_order_id: order.id });
    if (fulfillError) {
      const detail = String(fulfillError.message || '');
      if (detail.includes('insufficient_stock')) {
        return send(res, 200, { orderId: order.id, paymentStatus: 'completed', orderStatus: 'paid', deliveryStatus: 'waiting_stock', credentials: [], message: 'Pagamento confirmado. Entrega aguardando reposição de estoque.' });
      }
      console.error('Digital fulfillment failed:', detail);
      return send(res, 200, { orderId: order.id, paymentStatus: 'completed', orderStatus: 'paid', deliveryStatus: 'waiting_stock', credentials: [], message: 'Pagamento confirmado. Entrega em análise pelo suporte.' });
    }
  }

  const { data: latest, error: latestError } = await db.from('orders')
    .select('id,status,paid_at,fulfilled_at').eq('id', order.id).eq('user_id', authData.user.id).single();
  if (latestError || !latest) return send(res, 500, { error: 'Não foi possível consultar o estado final do pedido.' });
  let credentials = [];
  if (latest.status === 'fulfilled') {
    const {data:inventory,error:inventoryError}=await db.from('kaneki_account_stock').select('product_id,encrypted_data,delivered_at').eq('order_id',order.id).eq('delivered_to',authData.user.id).eq('status','delivered').order('delivered_at');
    if(inventoryError)return send(res,500,{error:'Erro ao consultar entrega.'});
    const {data:items,error:itemsError}=await db.from('order_items').select('product_id,product_name,products(image_url,description)').eq('order_id',order.id);
    if(itemsError)return send(res,500,{error:'Erro ao consultar produtos entregues.'});
    const names=new Map((items||[]).map(x=>[String(x.product_id),x]));
    const secret=process.env.STOCK_ENCRYPTION_KEY;
    if(!secret||secret.length<32)return send(res,500,{error:'Chave de entrega não configurada.'});
    const key=createHash('sha256').update(secret).digest();
    for(const item of inventory||[]){
      try{
        const raw=Buffer.from(item.encrypted_data,'base64');
        const decipher=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(12,28));
        const delivery=JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8'));
        const product=names.get(String(item.product_id));let attachment=null;
        if(delivery.fileInfo?.path){
          const {data:link,error:linkError}=await db.storage.from('kaneki-private-deliveries').createSignedUrl(delivery.fileInfo.path,3600,{download:delivery.fileInfo.name});
          if(linkError)throw linkError;
          attachment={url:link.signedUrl,name:delivery.fileInfo.name,mime:delivery.fileInfo.mime};
        }
        credentials.push({product:product?.product_name||String(item.product_id),image:product?.products?.image_url||null,description:delivery.details||'',credentials:[delivery.username?`Usuário: ${delivery.username}`:'',delivery.password?`Senha: ${delivery.password}`:''].filter(Boolean).join('\n'),attachment,deliveredAt:item.delivered_at});
      }catch(e){console.error('Failed to decrypt delivery',e.message);return send(res,500,{error:'Pagamento confirmado, mas não foi possível abrir a entrega. Contate o suporte.'});}
    }
  }
  return send(res, 200, {
    orderId: latest.id,
    paymentStatus: ['paid', 'fulfilled'].includes(latest.status) ? 'completed' : paymentStatus,
    orderStatus: latest.status,
    deliveryStatus: latest.status === 'fulfilled' ? 'delivered' : latest.status === 'paid' ? 'waiting_stock' : 'pending',
    paidAt: latest.paid_at,
    credentials
  });
}
