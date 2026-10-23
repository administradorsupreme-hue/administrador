// Endpoint receptor de webhook para Vercel.
// NÃO marca pedidos como pagos automaticamente: confirme a autenticidade do evento
// e consulte a cobrança na API oficial antes de entregar qualquer produto.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
  // Não existe confirmação segura sem conhecer o formato oficial do evento/assinatura
  // e sem uma base de dados de pedidos para comparar valor, ID e estado.
  return res.status(501).json({
    received: false,
    error: 'Webhook ainda não ativado. Configure a validação oficial do EclipSePay e o armazenamento dos pedidos antes de cadastrar esta URL.'
  });
}
