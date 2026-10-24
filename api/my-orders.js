import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido.' });
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
  if (!token) return res.status(401).json({ error: 'Entre na sua conta para consultar seus pedidos.' });
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY na Vercel.' });
  try {
    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: auth, error: authError } = await db.auth.getUser(token);
    if (authError || !auth?.user?.id) return res.status(401).json({ error: 'Sessão inválida. Entre novamente.' });
    const { data: orders, error } = await db.from('orders').select('id,created_at,status,total_cents').eq('user_id', auth.user.id).order('created_at', { ascending: false }).limit(100);
    if (error) { console.error('my-orders orders:', error); return res.status(500).json({ error: 'Falha ao consultar pedidos. Confira a tabela orders e a coluna user_id.' }); }
    if (!orders?.length) return res.status(200).json({ orders: [] });
    const { data: items, error: itemsError } = await db.from('order_items').select('order_id,product_name,quantity,unit_price_cents').in('order_id', orders.map(o => o.id));
    if (itemsError) { console.error('my-orders items:', itemsError); return res.status(500).json({ error: 'Falha ao consultar os itens. Confira as colunas de order_items.' }); }
    const byOrder = new Map();
    for (const item of items || []) { const key = String(item.order_id); if (!byOrder.has(key)) byOrder.set(key, []); byOrder.get(key).push({ product_name: item.product_name, quantity: item.quantity, unit_price_cents: item.unit_price_cents }); }
    return res.status(200).json({ orders: orders.map(order => ({ ...order, items: byOrder.get(String(order.id)) || [] })) });
  } catch (err) { console.error('my-orders unexpected:', err); return res.status(500).json({ error: 'Erro interno ao carregar os pedidos.' }); }
}
