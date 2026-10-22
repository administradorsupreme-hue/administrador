import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const response = (statusCode, data) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(data),
});

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return response(405, { error: "Método não permitido." });
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ECLIPSE_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ECLIPSE_API_KEY) {
    return response(500, { error: "Configure SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e ECLIPSE_API_KEY no Netlify." });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "JSON inválido." }); }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20) {
    return response(400, { error: "Carrinho inválido." });
  }
  const auth = event.headers.authorization || event.headers.Authorization;
  if (!auth?.startsWith("Bearer ")) return response(401, { error: "Faça login antes de comprar." });

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await db.auth.getUser(auth.slice(7));
  if (authError || !authData?.user) return response(401, { error: "Sessão inválida. Entre novamente." });

  const normalized = body.items.map(i => ({ product_id: String(i?.product_id ?? ""), quantity: Number(i?.quantity) }));
  if (normalized.some(i => !i.product_id || !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 10)) {
    return response(400, { error: "Produto ou quantidade inválida." });
  }
  const ids = [...new Set(normalized.map(i => i.product_id))];
  const { data: products, error: productsError } = await db.from("products")
    .select("id,name,price_cents,is_active").in("id", ids);
  if (productsError) return response(500, { error: "Falha ao consultar catálogo. Confira a migração Supabase." });
  if (!products || products.length !== ids.length || products.some(p => !p.is_active)) {
    return response(400, { error: "Produto indisponível ou ainda não cadastrado no Supabase." });
  }

  const byId = new Map(products.map(p => [String(p.id), p]));
  const items = normalized.map(i => ({ ...i, product: byId.get(i.product_id) }));
  const totalCents = items.reduce((sum, i) => sum + i.product.price_cents * i.quantity, 0);
  if (!Number.isSafeInteger(totalCents) || totalCents < 80 || totalCents > 100000) {
    return response(400, { error: "O total deve ficar entre R$ 0,80 e R$ 1.000,00 por cobrança na EclipsePay." });
  }

  const orderId = randomUUID();
  const idempotencyKey = randomUUID();
  const { error: orderError } = await db.from("orders").insert({
    id: orderId, user_id: authData.user.id, status: "pending",
    total_cents: totalCents, provider: "eclipsepay", payment_reference: idempotencyKey
  });
  if (orderError) return response(500, { error: "Não foi possível registrar o pedido." });

  const { error: itemsError } = await db.from("order_items").insert(items.map(i => ({
    order_id: orderId, product_id: i.product_id, product_name: i.product.name,
    unit_price_cents: i.product.price_cents, quantity: i.quantity
  })));
  if (itemsError) {
    await db.from("orders").delete().eq("id", orderId);
    return response(500, { error: "Não foi possível registrar os itens do pedido." });
  }

  let payRes, pay;
  try {
    payRes = await fetch("https://eclipsepaybr.com/v1/charges", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ECLIPSE_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey
      },
      body: JSON.stringify({ amountCents: totalCents, description: `KaneKi pedido ${orderId}` })
    });
    pay = await payRes.json();
  } catch {
    return response(502, { error: "Não foi possível contactar a EclipsePay. Consulte os pedidos antes de tentar novamente." });
  }

  if (!payRes.ok || !pay?.id) {
    return response(502, { error: "A EclipsePay não criou a cobrança.", providerCode: pay?.code || null });
  }
  const { error: updateError } = await db.from("orders")
    .update({ provider_charge_id: pay.id, updated_at: new Date().toISOString() }).eq("id", orderId);
  if (updateError) return response(500, { error: "Cobrança criada, mas não foi possível vincular ao pedido. Contate o suporte com o pedido " + orderId });

  return response(200, {
    orderId, chargeId: pay.id, status: pay.status,
    amountCents: pay.amountCents, brCode: pay.brCode || null, expiresAt: pay.expiresAt || null
  });
};
