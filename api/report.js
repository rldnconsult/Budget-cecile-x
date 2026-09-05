function sendJson(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 28_000_000) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
function cleanText(value) { return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/€/g,'EUR').replace(/[–—]/g,'-').replace(/[“”]/g,'"').replace(/[’]/g,"'").replace(/[^\x20-\x7E]/g,'').trim(); }
function escapePdf(s) { return cleanText(s).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)'); }
function euro(value) { const n = Number(value || 0); return `${n.toFixed(2).replace('.', ',')} EUR`; }
function bytes(s) { return Buffer.from(s, 'binary'); }
function concat(parts) { return Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p))); }
function streamFromString(s) { const b = bytes(s); return concat([bytes(`<< /Length ${b.length} >>\nstream\n`), b, bytes('\nendstream')]); }
function streamImage(b,w,h) { return concat([bytes(`<< /Type /XObject /Subtype /Image /Width ${Math.round(w)} /Height ${Math.round(h)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${b.length} >>\nstream\n`), b, bytes('\nendstream')]); }
function stripDataUrl(dataUrl) { const raw=String(dataUrl||''); const m=raw.match(/^data:([^;]+);base64,(.*)$/); return {mime:(m?.[1]||'image/jpeg').toLowerCase(), base64:m?.[2]||raw}; }
function imageBuffer(dataUrl){ const {base64}=stripDataUrl(dataUrl); return Buffer.from(base64,'base64'); }
function wrap(text,max){ const words=cleanText(text).split(/\s+/).filter(Boolean),lines=[]; let line=''; for(const w of words){const n=(line+' '+w).trim(); if(n.length>max&&line){lines.push(line); line=w}else line=n} if(line) lines.push(line); return lines; }
function addText(cmd,text,x,y,size=10,max=80,maxLines=1,leading=size+4){ let yy=y; for(const line of wrap(text,max).slice(0,maxLines)){ cmd.push(`BT /F1 ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td (${escapePdf(line)}) Tj ET\n`); yy-=leading;} return yy; }
function addRect(cmd,x,y,w,h,fill='1 1 1',stroke='.95 .75 .84'){ cmd.push(`${fill} rg ${stroke} RG ${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re B\n`); }
function fit(iw,ih,mw,mh){ const s=Math.min(mw/iw,mh/ih); return {w:iw*s,h:ih*s}; }
function bucketName(id, labels){ return cleanText(labels?.[id] || id || 'Budget'); }
function catName(id, labels){ return cleanText(labels?.[id] || id || 'Categorie'); }
function buildPdf(data){ const pages=[], images=[]; const addPage=(orientation='portrait')=>{const p={size:orientation==='landscape'?[841.89,595.28]:[595.28,841.89],cmd:[],imgs:[]}; pages.push(p); return p;}; const expenses=Array.isArray(data.expenses)?data.expenses:[], attachments=Array.isArray(data.attachments)?data.attachments:[]; const budget=Number(data.monthlyBudget||0), spent=expenses.filter(e=>e.type!=='planned').reduce((s,e)=>s+Number(e.amount||0),0), left=budget-spent; const bucketLabels=data.bucketLabels||{ordinary:'Budget ordinaire',extraordinary:'Budget extraordinaire',school:'Budget scolaire'}, catLabels=data.categoryLabels||{}; let p=addPage('portrait'), cmd=p.cmd, y=790, m=42; addText(cmd,'Rapport budget Cecile',m,y,22,60,1,26); y-=26; addText(cmd,'Periode : '+(data.periodLabel||''),m,y,11,70); y-=16; addText(cmd,'Genere le '+new Date().toLocaleDateString('fr-BE'),m,y,10,70); y-=36; addRect(cmd,m,y-88,511,88,'1 .97 .99','.97 .78 .87'); addText(cmd,'Synthese',m+18,y-24,13,40); addText(cmd,left>=0?'Situation sous controle':'Budget depasse',m+18,y-51,18,50); addText(cmd,`Budget mensuel: ${euro(budget)}   Depense: ${euro(spent)}   Reste: ${euro(left)}`,m+18,y-74,12,90); y-=126; const byBucket={}, byCat={}; for(const e of expenses){const b=bucketName(e.budgetBucket||'ordinary',bucketLabels), c=catName(e.category||'other',catLabels); byBucket[b]=(byBucket[b]||0)+Number(e.amount||0); byCat[c]=(byCat[c]||0)+Number(e.amount||0);} addText(cmd,'Types de budget',m,y,15,50); y-=24; const bucketRows=Object.entries(byBucket).sort((a,b)=>b[1]-a[1]); if(!bucketRows.length){addText(cmd,'Aucune depense dans la periode.',m,y,11,60);y-=18}else for(const [b,v] of bucketRows){addText(cmd,`${b} - ${euro(v)}`,m,y,11,70); y-=17} y-=10; addText(cmd,'Categories',m,y,15,50); y-=24; const catRows=Object.entries(byCat).sort((a,b)=>b[1]-a[1]).slice(0,12); if(!catRows.length){addText(cmd,'Aucune depense dans la periode.',m,y,11,60);y-=18}else for(const [c,v] of catRows){addText(cmd,`${c} - ${euro(v)}`,m,y,11,76);y-=17} y-=10; addText(cmd,'Depenses principales',m,y,15,50); y-=24; const biggest=[...expenses].sort((a,b)=>Number(b.amount||0)-Number(a.amount||0)).slice(0,16); if(!biggest.length)addText(cmd,'Aucune depense dans la periode.',m,y,11,60); else for(const e of biggest){ if(y<80){p=addPage('portrait');cmd=p.cmd;y=790} const line=`${e.date||''} - ${e.merchant||'Depense'} - ${euro(e.amount)} - ${catName(e.category||'',catLabels)} - ${bucketName(e.budgetBucket||'ordinary',bucketLabels)}`; y=addText(cmd,line,m,y,10,96,2,13)-5; }
function drawAtt(page,att,x,y,w,h){const c=page.cmd; addRect(c,x,y,w,h,'1 1 1','.92 .75 .84'); addText(c,`${att.label||att.merchant||'Justificatif'} - ${euro(att.amount)}`,x+12,y+h-22,10,Math.floor(w/5.4),2,12); addText(c,`${att.date||''} - ${catName(att.category||'',catLabels)} - ${bucketName(att.budgetBucket||'ordinary',bucketLabels)}`,x+12,y+h-52,8,Math.floor(w/4.7),1,10); try{const id=images.length+1; const b=imageBuffer(att.imageDataUrl); images.push({name:'Im'+id,bytes:b,w:att.imageWidth||900,h:att.imageHeight||1200}); page.imgs.push(images[images.length-1]); const maxW=w-24,maxH=h-78,d=fit(att.imageWidth||900,att.imageHeight||1200,maxW,maxH),ix=x+(w-d.w)/2,iy=y+18+(maxH-d.h)/2; c.push(`q ${d.w.toFixed(1)} 0 0 ${d.h.toFixed(1)} ${ix.toFixed(1)} ${iy.toFixed(1)} cm /Im${id} Do Q\n`)}catch(e){addText(c,'Image non lisible',x+12,y+h/2,10,40)}} if(data.includeAttachments&&attachments.length){for(let i=0;i<attachments.length;){const a=attachments[i],next=attachments[i+1]; if(!next || (a.aspect&&a.aspect<.42)){const page=addPage('portrait'),[pw,ph]=page.size; addText(page.cmd,'Annexes justificatifs',28,ph-34,15,50); drawAtt(page,a,28,48,pw-56,ph-96); i++;} else {const page=addPage('landscape'),[pw,ph]=page.size,gap=18,bw=(pw-56-gap)/2,bh=ph-96; addText(page.cmd,'Annexes justificatifs',28,ph-34,15,50); drawAtt(page,a,28,48,bw,bh); drawAtt(page,next,28+bw+gap,48,bw,bh); i+=2;}}}
const objs=[null]; const reserve=()=>{objs.push(null); return objs.length-1;}; const fontId=reserve(), pagesId=reserve(), pageIds=[]; for(const page of pages){const xparts=[]; for(const im of page.imgs){im.objId=reserve(); objs[im.objId]=streamImage(im.bytes,im.w,im.h); xparts.push(`/${im.name} ${im.objId} 0 R`)} const contentId=reserve(); objs[contentId]=streamFromString(page.cmd.join('')); const [pw,ph]=page.size; const res=`<< /Font << /F1 ${fontId} 0 R >> ${xparts.length?`/XObject << ${xparts.join(' ')} >>`:''} >>`; const pageId=reserve(); pageIds.push(pageId); objs[pageId]=bytes(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources ${res} /Contents ${contentId} 0 R >>`);} objs[fontId]=bytes('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); objs[pagesId]=bytes(`<< /Type /Pages /Kids [${pageIds.map(id=>id+' 0 R').join(' ')}] /Count ${pageIds.length} >>`); const catalogId=reserve(); objs[catalogId]=bytes(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`); let parts=[bytes('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')], offsets=[0], pos=parts[0].length; for(let id=1;id<objs.length;id++){offsets[id]=pos; const o=concat([bytes(`${id} 0 obj\n`),objs[id],bytes('\nendobj\n')]); parts.push(o); pos+=o.length;} const xrefStart=pos; let xref=`xref\n0 ${objs.length}\n0000000000 65535 f \n`; for(let id=1;id<objs.length;id++)xref+=String(offsets[id]).padStart(10,'0')+' 00000 n \n'; xref+=`trailer\n<< /Size ${objs.length} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`; parts.push(bytes(xref)); return concat(parts);}
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Méthode non supportée.' });
  try {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const pdf = buildPdf({monthlyBudget:payload.state?.monthlyBudget,expenses:payload.state?.expenses||[],periodLabel:payload.report?.periodLabel,includeAttachments:payload.includeAttachments,attachments:payload.attachments||[],bucketLabels:payload.report?.bucketLabels,categoryLabels:payload.report?.categoryLabels});
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="rapport-budget-cecile.pdf"');
    res.setHeader('Content-Length', String(pdf.length));
    res.end(pdf);
  } catch (error) {
    console.error('report_pdf_error', error && (error.stack || error.message || error));
    sendJson(res, 500, { ok: false, error: 'Rapport PDF indisponible pour le moment.' });
  }
};
