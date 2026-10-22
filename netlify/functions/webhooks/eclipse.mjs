/**
 * Webhook EclipsePay.
 * A documentação consultada exige HMAC sobre o corpo original, mas os detalhes
 * do cabeçalho e formato não puderam ser recuperados nesta sessão. Não aceitar
 * eventos sem verificar assinatura e consultar GET /v1/charges/{id}.
 */
const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(body),
});
export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Método não permitido." });
  return json(501, {
    received: false,
    error: "Webhook não ativado: falta configurar o cabeçalho e o algoritmo HMAC conforme a documentação oficial.",
    note: "Enquanto isso, o status pode ser consultado com GET /.netlify/functions/get-charge-status?orderId=... pelo comprador autenticado."
  });
};
