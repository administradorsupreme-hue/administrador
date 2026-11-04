/** Verifica depósito no provedor ANTES de creditar saldo. É seguro chamar repetidamente. */
export async function verifyWalletDeposit(db, deposit) {
  if (deposit.status === 'credited') return 'credited';
  if (!deposit.provider_charge_id) return 'pending';
  if (!process.env.ECLIPSE_API_KEY) throw Error('EclipsePay não configurada');
  const response = await fetch('https://eclipsepaybr.com/v1/charges/' + encodeURIComponent(deposit.provider_charge_id), {
    headers: {Authorization: 'Bearer ' + process.env.ECLIPSE_API_KEY, Accept: 'application/json'},
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw Error('Falha ao conferir depósito na EclipsePay');
  const raw = await response.json();
  const charge = raw?.data && typeof raw.data === 'object' ? raw.data : raw;
  if (String(charge?.id) !== String(deposit.provider_charge_id) ||
      !Number.isSafeInteger(charge.amountCents) || charge.amountCents !== Number(deposit.charge_cents)) {
    throw Error('Valor ou identificador divergente; depósito bloqueado');
  }
  if (!['paid','completed','approved','succeeded'].includes(String(charge.status||'').toLowerCase())) return 'pending';
  const {data,error} = await db.rpc('kaneki_wallet_credit_deposit', {
    p_deposit_id:deposit.id,p_charge_id:String(charge.id),p_charge_cents:Number(charge.amountCents)
  });
  if (error) throw Error('Falha ao creditar depósito: '+error.message);
  return data?.status || 'pending';
}
