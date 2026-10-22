import { createClient } from "@supabase/supabase-js";

const response = (statusCode, data) => ({
  statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
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
  const { data: order, error } = await db.from("orders").select("id,user_id,status,total_cents,provider_charge_id")
    .eq("id", orderId).eq("user_id", authData.user.id).maybeSingle();
  if (error || !order) return response(404, { error: "Pedido não encontrado." });
  if (!order.provider_charge_id) return response(409, { error: "Cobrança ainda não vinculada." });

  let res, charge;
  try {
    res = await fetch(`https://eclipsepaybr.com/v1/charges/${encodeURIComponent(order.provider_charge_id)}`, {
      headers: { "Authorization": `Bearer ${ECLIPSE_API_KEY}` }
    });
    charge = await res.json();
  } catch { return response(502, { error: "Não foi possível consultar a EclipsePay." }); }
  if (!res.ok || charge?.id !== order.provider_charge_id) return response(502, { error: "Falha ao verificar a cobrança na EclipsePay." });
  if (charge.kind !== "deposit" || charge.amountCents !== order.total_cents) return response(409, { error: "Valor ou tipo da cobrança não corresponde ao pedido." });

  // O status só é marcado como pago após consulta autenticada na API do provedor.
  if (charge.status === "completed" && order.status === "pending") {
    const { error: updateError } = await db.from("orders").update({
      status: "paid", paid_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).eq("id", order.id).eq("status", "pending");
    if (updateError) return response(500, { error: "Pagamento confirmado, mas não foi possível atualizar o pedido." });
  } else if (charge.status === "refunded") {
    await db.from("orders").update({ status: "refunded", updated_at: new Date().toISOString() }).eq("id", order.id);
  } else if (charge.status === "failed" && order.status === "pending") {
    await db.from("orders").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", order.id);
  }
  return response(200, { orderId: order.id, paymentStatus: charge.status, orderStatus: charge.status === "completed" ? "paid" : charge.status });
};
