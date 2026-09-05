function send(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 28_000_000) req.destroy(new Error('Image trop lourde.'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function parseNumber(value) {
  const s = String(value || '').replace(/\s/g, '').replace(/(?<=\d)[.](?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function amountCandidatesFromText(text) {
  const lines = String(text || '').split(/\n+/).map(l => l.trim()).filter(Boolean);
  const out = [];
  const amountRe = /(?:€|eur|euro)?\s*(\d{1,4}(?:[ .]\d{3})*[,.]\d{2})\s*(?:€|eur|euro)?/ig;
  for (const line of lines) {
    let m;
    while ((m = amountRe.exec(line))) {
      const value = parseNumber(m[1]);
      if (!value || value <= 0 || value > 5000) continue;
      const n = normalizeText(line);
      let score = 0.45;
      if (/\b(total|tot\.?|montant|a payer|payer|net a payer|cb|carte|bancontact|visa|mastercard|ttc)\b/.test(n)) score += 0.35;
      if (/\b(rendu|monnaie|cashback|especes|recu|ht|tva|taxe|subtotal|sous-total|sous total)\b/.test(n)) score -= 0.25;
      if (/\b(total\s+ttc|montant\s+ttc|net\s+a\s+payer|a\s+payer)\b/.test(n)) score += 0.2;
      out.push({ value, label: line.slice(0, 90), confidence: Math.max(0.05, Math.min(0.98, score)) });
    }
  }
  const seen = new Set();
  return out
    .sort((a, b) => b.confidence - a.confidence || b.value - a.value)
    .filter(c => { const k = c.value.toFixed(2); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 8);
}

function pickAmount(primary, candidates) {
  const n = parseNumber(primary);
  if (n && n > 0 && n < 5000) return n;
  const arr = Array.isArray(candidates) ? candidates : [];
  const best = arr.find(c => Number(c.confidence || 0) >= 0.55) || arr.sort((a, b) => Number(b.value || 0) - Number(a.value || 0))[0];
  const v = parseNumber(best && best.value);
  return v && v > 0 && v < 5000 ? v : null;
}

function parseDate(text) {
  const s = String(text || '');
  const iso = s.match(/\b(20\d{2})[-/\.](\d{1,2})[-/\.](\d{1,2})\b/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  const d = s.match(/\b(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(20\d{2}|\d{2})\b/);
  if (!d) return null;
  let day = Number(d[1]), month = Number(d[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  const year = d[3].length === 2 ? '20' + d[3] : d[3];
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function merchantFromText(text) {
  const banned = /^(ticket|recu|facture|duplicata|date|heure|total|ttc|tva|siret|siren|ape|naf|tel|telephone|merci|bienvenue|carte|cb|visa|mastercard|client|caisse|caissier|www\.|http|adresse|france|belgique)$/i;
  const lines = String(text || '').split(/\n+/).map(l => l.trim().replace(/\s{2,}/g, ' ')).filter(l => l.length >= 3 && l.length <= 55);
  for (const line of lines.slice(0, 12)) {
    const clean = line.replace(/^[^a-zA-ZÀ-ÿ0-9]+|[^a-zA-ZÀ-ÿ0-9]+$/g, '');
    if (!clean || banned.test(normalizeText(clean))) continue;
    if (/\d{2}[/.:-]\d{2}/.test(clean) || /\d+[,\.]\d{2}/.test(clean)) continue;
    if (/[a-zA-ZÀ-ÿ]{3,}/.test(clean)) return clean.slice(0, 50);
  }
  return null;
}

function pickCategory(text, categories) {
  const t = normalizeText(text);
  const list = Array.isArray(categories) ? categories : [];
  let best = null;
  for (const c of list) {
    const words = String(c.words || '').split(',').map(w => normalizeText(w.trim())).filter(Boolean);
    let score = 0;
    for (const w of words) {
      if (w && t.includes(w)) score += Math.max(1, Math.min(4, Math.ceil(w.length / 4)));
    }
    if (!best || score > best.score) best = { id: c.id, score };
  }
  return best && best.score > 0 ? best.id : 'other';
}

function safeCategories(categories) {
  return (Array.isArray(categories) ? categories : [])
    .filter(c => c && c.id && c.name)
    .slice(0, 80)
    .map(c => ({ id: String(c.id).slice(0, 60), name: String(c.name).slice(0, 80), words: String(c.words || '').slice(0, 500), defaultBucket: String(c.defaultBucket || 'ordinary') }));
}

async function callOpenAI({ imageDataUrl, optimizedImageDataUrl, categories, hint }) {
  const pointSchema = { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] };
  const candidateSchema = { type: 'object', additionalProperties: false, properties: { value: { type: 'number' }, label: { type: ['string', 'null'] }, confidence: { type: 'number' } }, required: ['value', 'label', 'confidence'] };
  const dateCandidateSchema = { type: 'object', additionalProperties: false, properties: { value: { type: ['string', 'null'] }, label: { type: ['string', 'null'] }, confidence: { type: 'number' } }, required: ['value', 'label', 'confidence'] };
  const receiptSchema = {
    type: 'object', additionalProperties: false,
    properties: {
      merchant: { type: ['string', 'null'] },
      amount: { type: ['number', 'null'] },
      date: { type: ['string', 'null'], description: 'Date ISO YYYY-MM-DD si trouvée' },
      categoryId: { type: ['string', 'null'] },
      category: { type: ['string', 'null'] },
      budgetBucket: { type: ['string', 'null'] },
      confidence: { type: 'number' },
      needsReview: { type: 'boolean' },
      comment: { type: ['string', 'null'] },
      warnings: { type: 'array', items: { type: 'string' } },
      rawText: { type: ['string', 'null'] },
      amountCandidates: { type: 'array', items: candidateSchema },
      dateCandidates: { type: 'array', items: dateCandidateSchema },
      crop: { type: ['object', 'null'], additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['x', 'y', 'width', 'height'] },
      corners: { type: ['object', 'null'], additionalProperties: false, properties: { tl: pointSchema, tr: pointSchema, br: pointSchema, bl: pointSchema }, required: ['tl', 'tr', 'br', 'bl'] }
    },
    required: ['merchant', 'amount', 'date', 'categoryId', 'category', 'budgetBucket', 'confidence', 'needsReview', 'comment', 'warnings', 'rawText', 'amountCandidates', 'dateCandidates', 'crop', 'corners']
  };
  const schema = { type: 'object', additionalProperties: false, properties: { receipts: { type: 'array', items: receiptSchema }, globalWarnings: { type: 'array', items: { type: 'string' } } }, required: ['receipts', 'globalWarnings'] };
  const categoryText = categories.length ? categories.map(c => `- ${c.id}: ${c.name}; type par défaut: ${c.defaultBucket}; mots-clés: ${c.words || '-'}`).join('\n') : '- other: Divers à vérifier';
  const content = [{
    type: 'input_text',
    text: `Tu lis des tickets de caisse pour une application de budget étudiant. Objectif: pour CHAQUE ticket visible, extraire les champs utiles et les bords du document.\n\nImages fournies:\n1) photo originale complète;\n2) version préparée par l'app si disponible.\nLes coordonnées crop/corners doivent toujours être relatives à la PHOTO ORIGINALE, normalisées entre 0 et 1.\n\nTravail obligatoire par ticket:\n- détecter précisément le papier: crop serré avec petite marge;\n- si les 4 coins du papier sont visibles, donner corners tl,tr,br,bl; sinon corners=null mais crop obligatoire si le ticket est visible;\n- retranscrire les lignes lisibles principales dans rawText;\n- extraire merchant = enseigne/fournisseur principal, pas l'adresse, pas la caisse, pas la ville;\n- extraire amount = montant final payé/TTC/total carte. Évite TVA, HT, rendu monnaie, sous-total;\n- extraire date = date d'achat en YYYY-MM-DD;\n- amountCandidates doit lister les montants plausibles avec le libellé de leur ligne;\n- dateCandidates doit lister les dates plausibles;\n- choisir categoryId parmi les catégories ci-dessous. Si aucune ne correspond, other.\n\nNe renvoie null pour merchant/amount/date que si c'est réellement illisible. Si plusieurs montants existent, privilégie TOTAL, TOTAL TTC, Montant, À payer, CB, Carte.\n\nCatégories disponibles:\n${categoryText}\n\nIndice utilisateur: ${hint || 'aucun'}`
  }];
  if (imageDataUrl) content.push({ type: 'input_image', image_url: imageDataUrl, detail: 'high' });
  if (optimizedImageDataUrl && optimizedImageDataUrl !== imageDataUrl) content.push({ type: 'input_image', image_url: optimizedImageDataUrl, detail: 'high' });

  const models = process.env.OPENAI_RECEIPT_MODEL
    ? [process.env.OPENAI_RECEIPT_MODEL]
    : ['gpt-5', 'gpt-5-mini'];
  let lastError = null;
  for (const model of models) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55000);
    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          input: [{ role: 'user', content }],
          max_output_tokens: 1800,
          text: { format: { type: 'json_schema', name: 'receipt_deep_read', strict: true, schema } }
        })
      });
      clearTimeout(timer);
      const raw = await response.json();
      if (!response.ok) {
        lastError = raw.error?.message || 'Lecture automatique impossible.';
        if (/model|not found|does not exist|unsupported/i.test(lastError) && models.length > 1) continue;
        const status = response.status || 502;
        const err = new Error(lastError);
        err.status = status;
        throw err;
      }
      const text = raw.output_text || raw.output?.flatMap(o => o.content || []).find(c => c.type === 'output_text')?.text || '{}';
      return JSON.parse(text);
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (error.name === 'AbortError') break;
      if (models.length <= 1) break;
    }
  }
  throw lastError || new Error('Lecture automatique impossible.');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Méthode non supportée.' });
  if (!process.env.OPENAI_API_KEY) return send(res, 503, { ok: false, configured: false, error: 'Lecture automatique indisponible.' });
  try {
    const body = JSON.parse((await readBody(req)) || '{}');
    const { imageDataUrl = '', optimizedImageDataUrl = '', ocrText = '', hint = '' } = body;
    const categories = safeCategories(body.categories);
    if (!imageDataUrl && !optimizedImageDataUrl && !ocrText) return send(res, 400, { ok: false, error: 'Image requise.' });

    let parsed = await callOpenAI({ imageDataUrl, optimizedImageDataUrl, categories, hint });
    let receipts = Array.isArray(parsed.receipts) ? parsed.receipts : [];
    if (!receipts.length) {
      receipts = [{ merchant: null, amount: null, date: null, categoryId: 'other', category: 'other', budgetBucket: null, confidence: 0, needsReview: true, comment: null, warnings: ['Aucun ticket détecté avec certitude.'], rawText: null, amountCandidates: [], dateCandidates: [], crop: null, corners: null }];
    }

    receipts = receipts.map(r => {
      const rawText = [r.rawText, ocrText].filter(Boolean).join('\n');
      const candidates = [
        ...(Array.isArray(r.amountCandidates) ? r.amountCandidates : []),
        ...amountCandidatesFromText(rawText)
      ];
      const amount = pickAmount(r.amount, candidates);
      const date = r.date || parseDate(rawText);
      const merchant = r.merchant || merchantFromText(rawText);
      const categoryId = r.categoryId || r.category || pickCategory(`${merchant || ''}\n${rawText}`, categories);
      const confidence = Math.max(0, Math.min(1, Number(r.confidence || 0)));
      return {
        ...r,
        merchant,
        amount,
        date,
        categoryId,
        category: categoryId,
        budgetBucket: r.budgetBucket || null,
        confidence,
        needsReview: Boolean(r.needsReview || !merchant || !amount || !date || confidence < 0.6),
        rawText: r.rawText || null,
        amountCandidates: candidates.slice(0, 8),
        dateCandidates: Array.isArray(r.dateCandidates) ? r.dateCandidates.slice(0, 8) : [],
        warnings: Array.isArray(r.warnings) ? r.warnings : []
      };
    });

    return send(res, 200, { ok: true, configured: true, results: receipts, globalWarnings: parsed.globalWarnings || [] });
  } catch (error) {
    const status = error && error.status ? error.status : 504;
    return send(res, status, { ok: false, configured: true, error: 'Lecture automatique impossible pour ce ticket. Tu peux le relancer ou compléter à la main.' });
  }
};

module.exports.config = { maxDuration: 60 };
