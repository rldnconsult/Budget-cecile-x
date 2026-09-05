function send(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 18_000_000) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
function parseFallback(text) {
  const amountCandidates = [...String(text || '').matchAll(/(\d{1,3}(?:[ .]\d{3})*[,.]\d{2})/g)]
    .map(m => Number(m[1].replace(/\s|\./g,'').replace(',','.')))
    .filter(n => n > 0 && n < 5000);
  const amount = amountCandidates.length ? Math.max(...amountCandidates) : null;
  const d = String(text || '').match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2}|\d{2})\b/);
  const date = d ? `${d[3].length === 2 ? '20'+d[3] : d[3]}-${String(d[2]).padStart(2,'0')}-${String(d[1]).padStart(2,'0')}` : null;
  return { amount, date };
}
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok:false, error:'Méthode non supportée.' });
  if (!process.env.OPENAI_API_KEY) return send(res, 503, { ok:false, configured:false, error:'Lecture automatique indisponible.' });
  try {
    const { imageDataUrl, ocrText = '', hint = '' } = JSON.parse((await readBody(req)) || '{}');
    if (!imageDataUrl && !ocrText) return send(res, 400, { ok:false, error:'Image requise.' });
    const pointSchema = { type:'object', additionalProperties:false, properties:{ x:{type:'number'}, y:{type:'number'} }, required:['x','y'] };
    const receiptSchema = {
      type:'object', additionalProperties:false,
      properties:{
        merchant:{type:['string','null']},
        amount:{type:['number','null']},
        date:{type:['string','null'], description:'Date ISO YYYY-MM-DD si trouvée'},
        category:{type:'string', enum:['food','transport','home','health','hygiene','study','clothes','gifts','outings','restaurants','subscriptions','bank','equipment','other']},
        confidence:{type:'number'},
        comment:{type:['string','null']},
        warnings:{type:'array',items:{type:'string'}},
        crop:{type:['object','null'], additionalProperties:false, properties:{x:{type:'number'},y:{type:'number'},width:{type:'number'},height:{type:'number'}}, required:['x','y','width','height']},
        corners:{type:['object','null'], additionalProperties:false, properties:{tl:pointSchema,tr:pointSchema,br:pointSchema,bl:pointSchema}, required:['tl','tr','br','bl']}
      },
      required:['merchant','amount','date','category','confidence','comment','warnings','crop','corners']
    };
    const schema = { type:'object', additionalProperties:false, properties:{ receipts:{type:'array', items:receiptSchema}, globalWarnings:{type:'array', items:{type:'string'}} }, required:['receipts','globalWarnings'] };
    const content = [{ type:'input_text', text:`Analyse une photo de justificatif pour une étudiante. Il peut y avoir un seul ticket ou plusieurs tickets visibles sur la même photo. Renvoie un objet par ticket reconnu indépendamment. Pour chaque ticket, extrais le montant TTC total, la date d'achat, l'enseigne, la catégorie probable, puis fournis deux indications géométriques pour conserver le justificatif proprement: (1) crop rectangulaire normalisé x,y,width,height entre 0 et 1 autour du ticket avec petite marge, (2) si les quatre coins du ticket sont visibles, corners normalisés tl,tr,br,bl pour permettre un redressage de perspective. Priorité absolue aux coordonnées fiables de rognage/redressage. Si les coins ne sont pas suffisamment fiables, mets corners à null mais donne crop. Catégories: food=alimentation/courses, restaurants=restaurant/snack/café, outings=sorties/loisirs, gifts=cadeaux, transport, health, hygiene, study, clothes, subscriptions, bank, equipment, home, other. Indice utilisateur: ${hint || 'aucun'}. Texte OCR éventuel: ${ocrText || 'aucun'}.` }];
    if (imageDataUrl) content.push({ type:'input_image', image_url:imageDataUrl, detail:'auto' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 28000);
    const response = await fetch('https://api.openai.com/v1/responses', {
      method:'POST', signal: controller.signal,
      headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({
        model: process.env.OPENAI_RECEIPT_MODEL || 'gpt-5-mini',
        input:[{role:'user',content}],
        max_output_tokens: 1100,
        text:{format:{type:'json_schema',name:'receipt_batch',strict:true,schema}}
      })
    });
    clearTimeout(timer);
    const raw = await response.json();
    if (!response.ok) return send(res, response.status, { ok:false, configured:true, error:raw.error?.message || 'Lecture automatique impossible.' });
    const text = raw.output_text || raw.output?.flatMap(o => o.content || []).find(c => c.type === 'output_text')?.text || '{}';
    let parsed = JSON.parse(text);
    let receipts = Array.isArray(parsed.receipts) ? parsed.receipts : [];
    if (!receipts.length) receipts = [{ merchant:null, amount:null, date:null, category:'other', confidence:0, comment:null, warnings:['Aucun ticket détecté avec certitude.'], crop:null, corners:null }];
    const fb = parseFallback(ocrText);
    receipts = receipts.map(r => ({...r, amount: r.amount || fb.amount || null, date: r.date || fb.date || null, category: r.category || 'other', confidence: Math.max(0, Math.min(1, Number(r.confidence || 0))) }));
    return send(res, 200, { ok:true, configured:true, results:receipts, globalWarnings:parsed.globalWarnings || [] });
  } catch (error) {
    return send(res, 504, { ok:false, configured:true, error:'Lecture automatique trop longue. Le ticket reste à compléter.' });
  }
};
