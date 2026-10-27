import {createHash, createDecipheriv} from 'node:crypto';

const isPaid = s => ['paid','completed','approved','succeeded'].includes(String(s || '').toLowerCase());
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function decrypt(encoded, secret) {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < 29) throw Error('Entrega criptografada inválida');
  const key = createHash('sha256').update(secret).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
}

/** A confirmação é feita no servidor, sempre consultando a cobrança e conferindo ID e valor. */
export async function verifyAndFulfill(db, order) {
  if (order.status !== 'pending' || !order.provider_charge_id) return order.status;
  if (!process.env.ECLIPSE_API_KEY) throw Error('Chave EclipsePay não configurada');
  const response = await fetch('https://eclipsepaybr.com/v1/charges/' + encodeURIComponent(order.provider_charge_id), {
    headers: {Authorization: 'Bearer ' + process.env.ECLIPSE_API_KEY, Accept: 'application/json'},
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw Error('Falha na consulta de pagamento junto à EclipsePay (' + response.status + ')');
  const raw = await response.json();
  const charge = raw?.data && typeof raw.data === 'object' ? raw.data : raw;
  if (String(charge?.id) !== String(order.provider_charge_id) ||
      !Number.isSafeInteger(charge?.amountCents) || charge.amountCents !== order.total_cents) {
    throw Error('Identificador ou valor da cobrança divergente; entrega bloqueada');
  }
  if (!isPaid(charge.status)) return order.status;
  const {data, error} = await db.rpc('kaneki_confirm_and_fulfill', {
    p_order_id: order.id, p_charge_id: String(charge.id)
  });
  if (error) throw Error('Pagamento confirmado, mas falhou a entrega: ' + error.message);
  return data?.status || 'paid';
}

/** Dados acessíveis somente pelo comprador autenticado ou pelo processo de e-mail no servidor. */
export async function getDelivery(db, order, {signedLinks = false} = {}) {
  const {data:units, error:unitsError} = await db.from('kaneki_account_stock')
    .select('id,product_id,encrypted_data,account_info,username').eq('order_id', order.id)
    .eq('delivered_to', order.user_id).eq('status', 'delivered');
  if (unitsError) throw Error('Falha ao carregar a entrega');
  const ids = [...new Set((units || []).map(u => String(u.product_id)).filter(Boolean))];
  let productMap = new Map();
  if (ids.length) {
    const {data:products, error} = await db.from('products').select('id,name,image_url').in('id', ids);
    if (!error) productMap = new Map((products || []).map(p => [String(p.id), p]));
  }
  // O resumo também funciona caso o administrador exclua o produto do catálogo.
  const {data:orderedItems} = await db.from('order_items')
    .select('product_id,product_name,product_image_url').eq('order_id',order.id);
  const historyMap = new Map((orderedItems || []).map(i => [String(i.product_id),i]));
  const credentials = [], deliveries = [];
  for (const unit of units || []) {
    const product = productMap.get(String(unit.product_id));
    const history = historyMap.get(String(unit.product_id));
    const item = {product: history?.product_name || product?.name || 'Produto digital', image: history?.product_image_url || product?.image_url || ''};
    if (unit.encrypted_data) {
      if (!process.env.STOCK_ENCRYPTION_KEY) throw Error('Chave de entrega não configurada');
      const info = decrypt(unit.encrypted_data, process.env.STOCK_ENCRYPTION_KEY);
      item.username = info.username || '';
      item.password = info.password || '';
      item.description = info.details || '';
      item.details = item.description;
      item.credentials = [item.username && 'Usuário: ' + item.username, item.password && 'Senha: ' + item.password].filter(Boolean).join('\n');
      if (info.fileInfo?.path) {
        item.attachment = {name: info.fileInfo.name || 'Arquivo', mime: info.fileInfo.mime || ''};
        if (signedLinks) {
          const {data:signed} = await db.storage.from('kaneki-private-deliveries').createSignedUrl(info.fileInfo.path, 300);
          if (signed?.signedUrl) {
            item.attachment.url = signed.signedUrl;
            deliveries.push({filename: item.attachment.name, url: signed.signedUrl});
          }
        }
      }
    } else {
      item.username = unit.username || '';
      item.password = '';
      item.details = unit.account_info || '';
      item.description = item.details;
      item.credentials = item.username ? 'Usuário: ' + item.username : '';
    }
    credentials.push(item);
  }
  const {data:ticketRows, error:ticketError} = await db.from('kaneki_tickets')
    .select('id').eq('order_id', order.id).limit(1);
  if (ticketError) throw Error('Falha ao consultar ticket');
  const ticket = Boolean(ticketRows?.length);
  const deliveryStatus = ticket && !credentials.length ? 'ticket' :
    order.status === 'fulfilled' && credentials.length ? 'fulfilled' :
    ['paid','fulfilled'].includes(order.status) ? 'waiting_stock' : 'pending';
  return {credentials, deliveries, deliveryStatus};
}

function orderLink() {
  const origin = String(process.env.STORE_PUBLIC_URL || '').trim();
  if (!/^https:\/\/[^/?#]+\/?$/i.test(origin)) return '';
  return origin.replace(/\/$/, '') + '/#orders';
}

/** Uma única notificação por pedido. Reservas atômicas impedem reenvio simultâneo por webhook/polling. */
export async function sendOrderEmail(db, order) {
  if (!['paid','fulfilled'].includes(order.status)) return 'pending';
  if (order.email_sent_at) return 'sent';
  if (!order.delivery_email) return 'no_email'; // Pedidos antigos não tinham endereço salvo.
  if (!process.env.RESEND_API_KEY || !process.env.ORDER_EMAIL_FROM) return 'not_configured';

  const delivery = await getDelivery(db, order);
  if (delivery.deliveryStatus !== 'fulfilled' && delivery.deliveryStatus !== 'ticket') return 'waiting_delivery';

  const now = new Date();
  const expired = new Date(now.getTime() - 3 * 60 * 1000).toISOString();
  const {data:claimed, error:claimError} = await db.from('orders')
    .update({email_claimed_at: now.toISOString(), email_last_error: null})
    .eq('id', order.id).is('email_sent_at', null)
    .or(`email_claimed_at.is.null,email_claimed_at.lt.${expired}`)
    .select('id').maybeSingle();
  if (claimError) throw Error('Falha ao reservar envio de e-mail: ' + claimError.message);
  if (!claimed) return 'processing';

  try {
    const {data:rows, error:itemsError} = await db.from('order_items')
      .select('product_name,product_image_url,quantity,unit_price_cents').eq('order_id', order.id);
    if (itemsError) throw Error('Falha ao consultar produtos do pedido');
    const items = rows || [];
    const name = String(order.customer_name || 'Cliente').slice(0,120);
    const reference = order.id.slice(0,8).toUpperCase();
    const url = orderLink();
    const purchased = items.map(i => `${i.product_name} × ${i.quantity}`).join(', ') || 'Produtos digitais';
    const paragraphs = [];
    if (delivery.deliveryStatus === 'ticket') {
      paragraphs.push('O pagamento foi confirmado e seu ticket de atendimento está aberto. Entre no site para receber seu produto com o suporte.');
    } else {
      paragraphs.push('Pagamento confirmado! Seus produtos digitais estão disponíveis no site em Meus pedidos.');
      for (const [i, unit] of delivery.credentials.entries()) {
        // Enviar os dados textuais já entregues ao destinatário VERIFICADO da conta.
        // Arquivos permanecem no bucket privado; acessar pelo site autenticado.
        const fields = [`Entrega ${i+1}: ${unit.product}`];
        if (unit.username) fields.push('Usuário: ' + unit.username);
        if (unit.password) fields.push('Senha: ' + unit.password);
        if (unit.description) fields.push('Descrição: ' + unit.description);
        if (unit.attachment) fields.push('Arquivo disponível em Meus pedidos: ' + unit.attachment.name);
        paragraphs.push(fields.join('\n'));
      }
    }
    const text = [`Olá, ${name}!`, `Pedido #${reference}`, 'Produtos: ' + purchased, '', ...paragraphs,
      url ? '\nAcesse Meus pedidos: ' + url : '\nAcesse a área Meus pedidos da loja para consultar a entrega.'].join('\n\n');
    const listHtml = items.map(i => `<div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #e9dff0">${/^https:\/\//i.test(i.product_image_url||'')?`<img src="${html(i.product_image_url)}" alt="" width="66" height="66" style="object-fit:cover;border-radius:10px;vertical-align:middle;margin-right:12px">`:''}<strong>${html(i.product_name)} × ${Number(i.quantity)||1}</strong></div>`).join('');
    const htmlBody = `<div style="font-family:Arial,sans-serif;color:#1a1630;max-width:620px;margin:auto"><h1 style="color:#8a23d1">KANEKI STORE</h1><p>Olá, <strong>${html(name)}</strong>!</p><h2>Seu pedido #${reference}</h2><p><b>Produtos comprados:</b></p>${listHtml}${paragraphs.map(p=>`<div style="white-space:pre-wrap;background:#f6f1fb;border-radius:10px;padding:14px;margin:12px 0">${html(p)}</div>`).join('')}<p>${url ? `<a href="${html(url)}" style="color:#8a23d1">Ver entrega em Meus pedidos</a>` : 'Acesse Meus pedidos na loja para rever sua entrega.'}</p><p style="font-size:12px;color:#7c7c8b">Este e-mail contém informações privadas da sua compra. Não compartilhe seus dados de acesso.</p></div>`;
    const reply = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(12000),
      headers: {'Authorization':'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type':'application/json',
        'Idempotency-Key': 'kaneki-delivery-' + order.id, 'User-Agent': 'KANEKI-STORE/1.0'},
      body: JSON.stringify({from: process.env.ORDER_EMAIL_FROM, to:[order.delivery_email],
        subject: `KANEKI STORE — sua compra #${reference} foi ${delivery.deliveryStatus === 'ticket' ? 'confirmada' : 'entregue'}`,
        text, html: htmlBody})
    });
    if (!reply.ok) {
      const body = await reply.text().catch(()=> '');
      throw Error('Resend HTTP ' + reply.status + ': ' + body.slice(0,300));
    }
    const {error:markError} = await db.from('orders').update({email_sent_at: new Date().toISOString(), email_claimed_at:null, email_last_error:null})
      .eq('id',order.id).eq('email_claimed_at',now.toISOString());
    if (markError) throw Error('Falha ao registrar envio: ' + markError.message);
    return 'sent';
  } catch (error) {
    await db.from('orders').update({email_claimed_at:null,email_last_error:String(error.message||error).slice(0,500)})
      .eq('id',order.id).eq('email_claimed_at',now.toISOString());
    console.error('Falha no envio do pedido', order.id, error.message);
    return 'failed';
  }
}
