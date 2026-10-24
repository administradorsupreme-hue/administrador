import { createClient } from "@supabase/supabase-js";

const response = (res, statusCode, data) => res.status(statusCode).json(data);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return response(res, 405, { error: "Método não permitido." });
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ECLIPSE_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ECLIPSE_API_KEY) return response(res, 500, { error: "Variáveis de ambiente ausentes." });
  const auth = req.headers.authorization || req.headers.Authorization;
  if (!auth?.startsWith("Bearer ")) return response(res, 401, { error: "Faça login." });
  const orderId = req.query?.orderId;
  if (!orderId) return response(res, 400, { error: "orderId obrigatório." });

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await db.auth.getUser(auth.slice(7));
  if (authError || !authData?.user) return response(res, 401, { error: "Sessão inválida." });
  const { data: order, error } = await db.from("orders")
    .select("id,user_id,status,total_cents,provider_charge_id")
    .eq("id", orderId).eq("user_id", authData.user.id).maybeSingle();
  if (error || !order) return response(res, 404, { error: "Pedido não encontrado." });

  let verifiedStatus = order.status;
  if (order.provider_charge_id && ["pending", "paid"].includes(order.status)) {
    let res, charge;
    try {
      res = await fetch(`https://eclipsepaybr.com/v1/charges/${encodeURIComponent(order.provider_charge_id)}`, {
        headers: { "Authorization": `Bearer ${ECLIPSE_API_KEY}` }
      });
      charge = await res.json();
    } catch { return response(res, 502, { error: "Não foi possível consultar a EclipsePay." }); }
    if (!res.ok || String(charge?.id ?? "") !== String(order.provider_charge_id)) return response(res, 502, { error: "Falha ao verificar a cobrança na EclipsePay." });
    // create-charge salva total_cents já incluindo a taxa fixa de R$ 0,50.
    // Não somar a taxa novamente: isso rejeitaria pagamentos válidos por R$ 0,50 de diferença.
    const expectedChargeCents = Number(order.total_cents);
    if (!Number.isSafeInteger(expectedChargeCents) || !Number.isSafeInteger(Number(charge.amountCents)) || Number(charge.amountCents) !== expectedChargeCents) {
      return response(res, 409, { error: "O valor confirmado pela EclipsePay não corresponde ao total registrado do pedido (incluindo a taxa fixa de R$ 0,50)." });
    }

    if (["completed", "paid"].includes(charge.status) && order.status === "pending") {
      const { error: updateError } = await db.from("orders").update({
        status: "paid", paid_at: new Date().toISOString(), updated_at: new Date().toISOString()
      }).eq("id", order.id).eq("status", "pending");
      if (updateError) return response(res, 500, { error: "Pagamento confirmado, mas não foi possível atualizar o pedido." });
      verifiedStatus = "paid";
    } else if (charge.status === "refunded") {
      await db.from("orders").update({ status: "refunded", updated_at: new Date().toISOString() }).eq("id", order.id);
      verifiedStatus = "refunded";
    } else if (charge.status === "failed" && order.status === "pending") {
      await db.from("orders").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", order.id);
      verifiedStatus = "failed";
    } else if (["completed", "paid"].includes(charge.status)) {
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
        return response(res, 409, { orderId: order.id, paymentStatus: "completed", orderStatus: "paid", deliveryStatus: "waiting_stock", message: "Pagamento confirmado; a entrega aguarda reposição de estoque. Entre em contato com o suporte." });
      }
      return response(res, 500, { error: "Pagamento verificado, mas a entrega precisa de análise do suporte." });
    }
  }

  const { data: latestOrder, error: latestError } = await db.from("orders")
    .select("id,status,paid_at,fulfilled_at").eq("id", order.id).eq("user_id", authData.user.id).single();
  if (latestError || !latestOrder) return response(res, 500, { error: "Não foi possível consultar o estado final do pedido." });

  let credentials = [];
  if (latestOrder.status === "fulfilled") {
    const { data: inventory, error: inventoryError } = await db.from("digital_inventory")
      .select("id,product_id,secret_value,delivered_at")
      .eq("order_id", order.id).eq("delivered_to", authData.user.id).eq("status", "delivered")
      .order("delivered_at", { ascending: true });
    if (inventoryError) return response(res, 500, { error: "Compra entregue, mas não foi possível carregar as credenciais." });
    const { data: items } = await db.from("order_items").select("product_id,product_name") .eq("order_id", order.id);
    const names = new Map((items || []).map(i => [i.product_id, i.product_name]));
    credentials = (inventory || []).map(item => ({ product: names.get(item.product_id) || item.product_id, credentials: item.secret_value, deliveredAt: item.delivered_at }));
  }

  return response(res, 200, {
    orderId: latestOrder.id,
    paymentStatus: ["fulfilled", "paid"].includes(verifiedStatus) ? "completed" : verifiedStatus,
    orderStatus: latestOrder.status,
    deliveryStatus: latestOrder.status === "fulfilled" ? "delivered" : latestOrder.status === "paid" ? "waiting_stock" : "pending",
    paidAt: latestOrder.paid_at,
    credentials
  });
}
