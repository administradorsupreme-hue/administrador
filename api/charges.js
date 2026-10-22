// Vercel Serverless Function — cria uma cobrança Pix no EclipSePay.
// Configure ECLIPSE_API_KEY nas Environment Variables da Vercel.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
  if (!process.env.ECLIPSE_API_KEY) return res.status(500).json({ error: 'ECLIPSE_API_KEY não configurada na Vercel.' });
  try {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length || items.length > 50) return res.status(400).json({ error: 'Carrinho inválido.' });
    // Nunca confie nos preços enviados pelo navegador. Esta versão exige catálogo/preços no servidor.
    // Até cadastrar o catálogo real aqui, não cria cobranças para evitar valores manipulados.
    return res.status(501).json({ error: 'Configure o catálogo oficial de produtos e preços no servidor antes de ativar cobranças.' });
  } catch (e) {
    return res.status(500).json({ error: 'Falha interna ao preparar a cobrança.' });
  }
}
