import { createClient } from "@supabase/supabase-js";

const response = (statusCode, data) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(data),
});

export const handler = async (event) => {
  if (event.httpMethod !== "GET") return response(405, { error: "Método não permitido." });
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ECLIPSE_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ECLIPSE_API_KEY) return response(500, { error: "Variáveis de ambiente ausentes." });
  const auth = event.headers.authorization || event.headers.Authorization;
  if (!auth?.startsWith("Bearer ")) return response(401, { error: "Faça login." });
  const orderId = event.queryStringParameters?.orderId;
  if (!orderId) return response(400, { error: "orderId obrigatório." });

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await db.auth.getUser(auth.slice(7));
  if (authError || !authData?.user) return response(401, { error: "Sessão inválida." });
  const { data: order, error } = await db.from("orders")
    .select("id,user_id,status,total_cents,provider_charge_id")
    .eq("id", orderId).eq("user_id", authData.user.id).maybeSingle();
  if (error || !order) return response(404, { error: "Pedido não encontrado." });

  let verifiedStatus = order.status;
  if (order.provider_charge_id && ["pending", "paid"].includes(order.status)) {
    let res, charge;
    try {
      res = await fetch(`https://eclipsepaybr.com/v1/charges/${encodeURIComponent(order.provider_charge_id)}`, {
        headers: { "Authorization": `Bearer ${ECLIPSE_API_KEY}` }
      });
      charge = await res.json();
    } catch { return response(502, { error: "Não foi possível consultar a EclipsePay." }); }
    if (!res.ok || charge?.id !== order.provider_charge_id) return response(502, { error: "Falha ao verificar a cobrança na EclipsePay." });
    if (charge.kind !== "deposit" || charge.amountCents !== order.total_cents) return response(409, { error: "Valor ou tipo da cobrança não corresponde ao pedido." });

    if (charge.status === "completed" && order.status === "pending") {
      const { error: updateError } = await db.from("orders").update({
        status: "paid", paid_at: new Date().toISOString(), updated_at: new Date().toISOString()
      }).eq("id", order.id).eq("status", "pending");
      if (updateError) return response(500, { error: "Pagamento confirmado, mas não foi possível atualizar o pedido." });
      verifiedStatus = "paid";
    } else if (charge.status === "refunded") {
      await db.from("orders").update({ status: "refunded", updated_at: new Date().toISOString() }).eq("id", order.id);
      verifiedStatus = "refunded";
    } else if (charge.status === "failed" && order.status === "pending") {
      await db.from("orders").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", order.id);
      verifiedStatus = "failed";
    } else if (charge.status === "completed") {
      verifiedStatus = order.status;
    } else {
      verifiedStatus = charge.status;
    }
  }

  // A entrega ocorre somente depois da consulta autenticada ao provedor confirmar completed.
  if (verifiedStatus === "paid" || verifiedStatus === "fulfilled") {
    const { error: fulfillError } = await db.rpc("fulfill_digital_order", { p_order_id: order.id });
    if (fulfillError && !String(fulfillError.message || "").includes("order_not_paid")) {
      if (String(fulfillError.message || "").includes("insufficient_stock")) {
        return response(409, { orderId: order.id, paymentStatus: "completed", orderStatus: "paid", deliveryStatus: "waiting_stock", message: "Pagamento confirmado; a entrega aguarda reposição de estoque. Entre em contato com o suporte." });
      }
      return response(500, { error: "Pagamento verificado, mas a entrega precisa de análise do suporte." });
    }
  }

  const { data: latestOrder, error: latestError } = await db.from("orders")
    .select("id,status,paid_at,fulfilled_at").eq("id", order.id).eq("user_id", authData.user.id).single();
  if (latestError || !latestOrder) return response(500, { error: "Não foi possível consultar o estado final do pedido." });

  let credentials = [];
  if (latestOrder.status === "fulfilled") {
    const { data: inventory, error: inventoryError } = await db.from("digital_inventory")
      .select("id,product_id,secret_value,delivered_at")
      .eq("order_id", order.id).eq("delivered_to", authData.user.id).eq("status", "delivered")
      .order("delivered_at", { ascending: true });
    if (inventoryError) return response(500, { error: "Compra entregue, mas não foi possível carregar as credenciais." });
    const { data: items } = await db.from("order_items").select("product_id,product_name") .eq("order_id", order.id);
    const names = new Map((items || []).map(i => [i.product_id, i.product_name]));
    credentials = (inventory || []).map(item => ({ product: names.get(item.product_id) || item.product_id, credentials: item.secret_value, deliveredAt: item.delivered_at }));
  }

  return response(200, {
    orderId: latestOrder.id,
    paymentStatus: verifiedStatus === "fulfilled" ? "completed" : verifiedStatus,
    orderStatus: latestOrder.status,
    deliveryStatus: latestOrder.status === "fulfilled" ? "delivered" : latestOrder.status === "paid" ? "waiting_stock" : "pending",
    paidAt: latestOrder.paid_at,
    credentials
  });
};
