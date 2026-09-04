function send(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function parseFallback(text) {
  const amountCandidates = [...String(text || '').matchAll(/(\d{1,3}(?:[ .]\d{3})*[,.]\d{2})/g)]
    .map(m => Number(m[1].replace(/\s|\./g,'').replace(',','.')))
    .filter(n => n > 0 && n < 5000);
  const amount = amountCandidates.length ? Math.max(...amountCandidates) : null;
  const d = String(text || '').match(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](20\d{2}|\d{2})\b/);
  const date = d ? `${d[3].length === 2 ? '20'+d[3] : d[3]}-${String(d[2]).padStart(2,'0')}-${String(d[1]).padStart(2,'0')}` : null;
  return { amount, date };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok:false, error:'Méthode non supportée.' });
  if (!process.env.OPENAI_API_KEY) return send(res, 503, { ok:false, configured:false, error:'OPENAI_API_KEY manquant dans Vercel.' });

  try {
    let body = '';
    await new Promise(resolve => { req.on('data', c => body += c); req.on('end', resolve); });
    const { imageDataUrl, ocrText = '', hint = '' } = JSON.parse(body || '{}');
    if (!imageDataUrl && !ocrText) return send(res, 400, { ok:false, error:'Image ou texte requis.' });

    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        merchant: { type: ['string','null'] },
        amount: { type: ['number','null'] },
        date: { type: ['string','null'], description: 'Date ISO YYYY-MM-DD si trouvée' },
        category: { type: 'string', enum: ['food','transport','home','health','hygiene','study','clothes','gifts','outings','restaurants','subscriptions','bank','equipment','other'] },
        confidence: { type: 'number' },
        comment: { type: ['string','null'] },
        warnings: { type: 'array', items: { type: 'string' } }
      },
      required: ['merchant','amount','date','category','confidence','comment','warnings']
    };

    const content = [{ type:'input_text', text:`Tu lis un ticket de caisse français pour créer une dépense étudiante. Réponds uniquement avec les champs structurés. Priorité au montant TTC total, à la date d'achat et à l'enseigne. Catégories: food=alimentation/courses, restaurants=restaurant/snack/café, outings=sorties/loisirs, gifts=cadeaux, transport, health, hygiene, study, clothes, subscriptions, bank, equipment, home, other. Indice utilisateur: ${hint || 'aucun'}. Texte OCR local éventuel: ${ocrText || 'aucun'}` }];
    if (imageDataUrl) content.push({ type:'input_image', image_url:imageDataUrl, detail:'low' });

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_RECEIPT_MODEL || 'gpt-5-mini',
        input: [{ role:'user', content }],
        text: { format: { type:'json_schema', name:'receipt_expense', strict:true, schema } }
      })
    });

    const raw = await response.json();
    if (!response.ok) return send(res, response.status, { ok:false, configured:true, error: raw.error?.message || 'Erreur OpenAI', raw });
    const text = raw.output_text || raw.output?.flatMap(o => o.content || []).find(c => c.type === 'output_text')?.text || '{}';
    const parsed = JSON.parse(text);
    const fb = parseFallback(ocrText);
    if (!parsed.amount && fb.amount) parsed.amount = fb.amount;
    if (!parsed.date && fb.date) parsed.date = fb.date;
    return send(res, 200, { ok:true, configured:true, result: parsed });
  } catch (error) {
    return send(res, 500, { ok:false, configured:true, error:String(error.message || error) });
  }
};
