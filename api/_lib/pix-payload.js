// EMV Pix estático sem PSP: QR de transferência, SEM confirmação automática.
const emv=(id,value)=>id+String(Buffer.byteLength(String(value),'utf8')).padStart(2,'0')+value;
function crc16(str){let crc=0xffff;for(const byte of Buffer.from(str,'utf8')){crc^=byte<<8;for(let i=0;i<8;i++)crc=(crc&0x8000)?(crc<<1)^0x1021:crc<<1;crc&=0xffff;}return crc.toString(16).toUpperCase().padStart(4,'0');}
export function makePix(key,amount,recipient,city,reference){
 const k=String(key||'').trim();const name=String(recipient||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9 .-]/g,' ').trim().slice(0,25);const town=String(city||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9 .-]/g,' ').trim().slice(0,15);
 if(!k||k.length>77||/[\x00-\x1f]/.test(k)||!(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(k)||/^\+?[0-9]{10,14}$/.test(k)||/^[0-9]{11}$/.test(k)||/^[0-9]{14}$/.test(k)||/^[a-f0-9-]{32,36}$/i.test(k))||name.length<2||town.length<2||!Number.isFinite(amount)||amount<0.01||amount>100000)return null;
 const gui=emv('00','br.gov.bcb.pix')+emv('01',k);
 const tx=String(reference).replace(/[^A-Z0-9]/g,'').slice(0,25)||'***';
 const payload=emv('00','01')+emv('26',gui)+emv('52','0000')+emv('53','986')+emv('54',Number(amount).toFixed(2))+emv('58','BR')+emv('59',name)+emv('60',town)+emv('62',emv('05',tx))+'6304';
 return payload+crc16(payload);
}
