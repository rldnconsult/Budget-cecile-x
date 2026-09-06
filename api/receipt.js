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
      if (body.length > 22_000_000) req.destroy(new Error('Image trop lourde.'));
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
  const raw = String(value ?? '').trim();
  if (!raw || /^null$/i.test(raw)) return null;
  let s = raw.replace(/\s/g, '');
  s = s.replace(/(?<=\d)[.](?=\d{3}(\D|$))/g, '');
  s = s.replace(',', '.');
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
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
      let score = 0.35;
      if (/\b(total|tot\.?|montant|a payer|payer|net a payer|du|solde|cb|carte|bancontact|visa|mastercard|maestro|ttc)\b/.test(n)) score += 0.45;
      if (/\b(total\s+ttc|montant\s+ttc|net\s+a\s+payer|a\s+payer|total\s+du|montant\s+regle)\b/.test(n)) score += 0.2;
      if (/\b(rendu|monnaie|cashback|especes recues|recu|ht|tva|taxe|subtotal|sous-total|sous total|article|quantite|prix unitaire)\b/.test(n)) score -= 0.35;
      out.push({ value, label: line.slice(0, 110), confidence: Math.max(0.05, Math.min(0.98, score)) });
    }
  }
  const seen = new Set();
  return out
    .sort((a, b) => b.confidence - a.confidence || b.value - a.value)
    .filter(c => { const k = c.value.toFixed(2); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 10);
}

function pickAmount(primary, candidates) {
  const n = parseNumber(primary);
  if (n && n > 0 && n < 5000) return n;
  const arr = (Array.isArray(candidates) ? candidates : [])
    .map(c => ({ value: parseNumber(c && c.value), confidence: Number(c && c.confidence || 0), label: String(c && c.label || '') }))
    .filter(c => c.value && c.value > 0 && c.value < 5000);
  arr.sort((a, b) => b.confidence - a.confidence || b.value - a.value);
  return arr[0] ? Math.round(arr[0].value * 100) / 100 : null;
}

function parseDate(text) {
  const s = String(text || '');
  const iso = s.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  const d = s.match(/\b(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(20\d{2}|\d{2})\b/);
  if (!d) return null;
  let day = Number(d[1]), month = Number(d[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  const year = d[3].length === 2 ? '20' + d[3] : d[3];
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function merchantFromText(text) {
  const banned = /^(ticket|recu|reçu|facture|duplicata|date|heure|total|ttc|tva|siret|siren|ape|naf|tel|telephone|merci|bienvenue|carte|cb|visa|mastercard|client|caisse|caissier|www\.|http|adresse|france|belgique|paris|massy|palaiseau)$/i;
  const lines = String(text || '').split(/\n+/).map(l => l.trim().replace(/\s{2,}/g, ' ')).filter(l => l.length >= 3 && l.length <= 60);
  for (const line of lines.slice(0, 14)) {
    const clean = line.replace(/^[^a-zA-ZÀ-ÿ0-9]+|[^a-zA-ZÀ-ÿ0-9]+$/g, '');
    const n = normalizeText(clean);
    if (!clean || banned.test(n)) continue;
    if (/\d{2}[/.:-]\d{2}/.test(clean) || /\d+[,\.]\d{2}/.test(clean)) continue;
    if (/[a-zA-ZÀ-ÿ]{3,}/.test(clean)) return clean.slice(0, 55);
  }
  return null;
}

function safeCategories(categories) {
  return (Array.isArray(categories) ? categories : [])
    .filter(c => c && c.id && c.name)
    .slice(0, 80)
    .map(c => ({
      id: String(c.id).slice(0, 60),
      name: String(c.name).slice(0, 80),
      words: String(c.words || '').slice(0, 500),
      defaultBucket: ['ordinary', 'extraordinary', 'school'].includes(String(c.defaultBucket)) ? String(c.defaultBucket) : 'ordinary'
    }));
}

function findCategory(value, text, categories) {
  const list = Array.isArray(categories) ? categories : [];
  const v = normalizeText(value || '');
  if (v) {
    const direct = list.find(c => normalizeText(c.id) === v || normalizeText(c.name) === v || normalizeText(c.name).includes(v) || v.includes(normalizeText(c.name).split('/')[0].trim()));
    if (direct) return direct.id;
  }
  const t = normalizeText(`${value || ''}\n${text || ''}`);
  let best = { id: 'other', score: 0 };
  for (const c of list) {
    let score = 0;
    const name = normalizeText(c.name || '');
    if (name && t.includes(name.split('/')[0].trim())) score += 2;
    for (const raw of String(c.words || '').split(',')) {
      const w = normalizeText(raw.trim());
      if (w && t.includes(w)) score += Math.max(1, Math.min(5, Math.ceil(w.length / 4)));
    }
    if (score > best.score) best = { id: c.id, score };
  }
  return best.score ? best.id : 'other';
}

function bucketForCategory(categoryId, provided, categories) {
  const p = String(provided || '').toLowerCase();
  if (['ordinary', 'extraordinary', 'school'].includes(p)) return p;
  const found = (Array.isArray(categories) ? categories : []).find(c => c.id === categoryId);
  return found && found.defaultBucket ? found.defaultBucket : 'ordinary';
}

function extractOutputText(raw) {
  if (!raw) return '';
  if (typeof raw.output_text === 'string' && raw.output_text.trim()) return raw.output_text;
  const pieces = [];
  const walk = value => {
    if (!value) return;
    if (typeof value === 'string') return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (typeof value !== 'object') return;
    if (typeof value.text === 'string') pieces.push(value.text);
    if (typeof value.output_text === 'string') pieces.push(value.output_text);
    if (typeof value.content === 'string') pieces.push(value.content);
    if (Array.isArray(value.content)) walk(value.content);
    if (Array.isArray(value.output)) walk(value.output);
  };
  walk(raw.output);
  return pieces.find(p => p.trim()) || '';
}

function parseJsonOutput(text) {
  const s = String(text || '').trim();
  if (!s) throw new Error('Réponse vide.');
  try { return JSON.parse(s); } catch (_) {}
  const first = s.indexOf('{'), last = s.lastIndexOf('}');
  if (first >= 0 && last > first) return JSON.parse(s.slice(first, last + 1));
  throw new Error('Réponse illisible.');
}

async function callOpenAI({ imageDataUrl, categories, hint }) {
  const pointSchema = { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] };
  const candidateSchema = { type: 'object', additionalProperties: false, properties: { value: { type: ['number', 'string', 'null'] }, label: { type: ['string', 'null'] }, confidence: { type: 'number' } }, required: ['value', 'label', 'confidence'] };
  const receiptSchema = {
    type: 'object', additionalProperties: false,
    properties: {
      merchant: { type: ['string', 'null'] },
      amount: { type: ['number', 'string', 'null'] },
      date: { type: ['string', 'null'], description: 'Date ISO YYYY-MM-DD si trouvée' },
      category: { type: ['string', 'null'], description: 'Identifiant de catégorie le plus probable' },
      budgetBucket: { type: ['string', 'null'], description: 'ordinary, extraordinary ou school' },
      confidence: { type: 'number' },
      comment: { type: ['string', 'null'] },
      warnings: { type: 'array', items: { type: 'string' } },
      rawText: { type: ['string', 'null'] },
      amountCandidates: { type: 'array', items: candidateSchema },
      crop: { type: ['object', 'null'], additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['x', 'y', 'width', 'height'] },
      corners: { type: ['object', 'null'], additionalProperties: false, properties: { tl: pointSchema, tr: pointSchema, br: pointSchema, bl: pointSchema }, required: ['tl', 'tr', 'br', 'bl'] }
    },
    required: ['merchant', 'amount', 'date', 'category', 'budgetBucket', 'confidence', 'comment', 'warnings', 'rawText', 'amountCandidates', 'crop', 'corners']
  };
  const schema = { type: 'object', additionalProperties: false, properties: { receipts: { type: 'array', items: receiptSchema }, globalWarnings: { type: 'array', items: { type: 'string' } } }, required: ['receipts', 'globalWarnings'] };
  const categoryText = categories.length ? categories.map(c => `- ${c.id}: ${c.name}; type par défaut: ${c.defaultBucket}; mots-clés: ${c.words || '-'}`).join('\n') : '- other: Divers à vérifier';
  const content = [{
    type: 'input_text',
    text: `Analyse la photo d'un ou plusieurs tickets de caisse pour un budget étudiant. Réponds uniquement avec les champs demandés.

Priorités absolues:
1. détecter chaque ticket visible séparément;
2. extraire le fournisseur/enseigne, la date d'achat, le montant final payé TTC, la catégorie;
3. ne jamais laisser fournisseur/date/montant vides quand ils sont lisibles;
4. fournir un crop léger du papier avec une petite marge;
5. fournir les 4 coins uniquement s'ils sont visibles et fiables.

Règles de lecture:
- merchant = enseigne principale, pas l'adresse, pas la ville, pas le numéro de caisse;
- amount = total réellement payé, total TTC, montant carte, montant CB ou à payer; privilégie le montant final le plus bas dans le bloc de paiement si un rendu monnaie apparaît;
- ne pas choisir TVA, HT, sous-total, rendu monnaie ou prix unitaire;
- date au format YYYY-MM-DD;
- rawText doit contenir les lignes importantes lues sur le ticket;
- seules les dépenses ordinary consomment le budget; les valeurs extraordinary et school sont des frais d'information;
- amountCandidates doit contenir plusieurs montants possibles avec la ligne d'origine;
- category doit être l'identifiant le plus probable parmi les catégories disponibles; utilise les mots-clés et le type de commerce; budgetBucket doit valoir ordinary pour le budget ordinaire, extraordinary pour un frais exceptionnel à tracer seulement pour information, ou school pour la scolarité à tracer seulement pour information.

Catégories disponibles:
${categoryText}

Indice utilisateur: ${hint || 'aucun'}`
  }];
  if (imageDataUrl) content.push({ type: 'input_image', image_url: imageDataUrl, detail: 'high' });

  const model = process.env.OPENAI_RECEIPT_MODEL || 'gpt-5-mini';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 42000);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        input: [{ role: 'user', content }],
        max_output_tokens: 1500,
        text: { format: { type: 'json_schema', name: 'receipt_reader_v2110', strict: true, schema } }
      })
    });
    clearTimeout(timer);
    const raw = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(raw.error && raw.error.message ? raw.error.message : 'Lecture automatique impossible.');
      err.status = response.status || 502;
      throw err;
    }
    return parseJsonOutput(extractOutputText(raw));
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Méthode non supportée.' });
  if (!process.env.OPENAI_API_KEY) return send(res, 503, { ok: false, configured: false, error: 'Lecture automatique indisponible.' });
  try {
    const body = JSON.parse((await readBody(req)) || '{}');
    const imageDataUrl = body.imageDataUrl || body.optimizedImageDataUrl || body.originalImageDataUrl || '';
    const ocrText = body.ocrText || '';
    const categories = safeCategories(body.categories);
    if (!imageDataUrl && !ocrText) return send(res, 400, { ok: false, error: 'Image requise.' });

    const parsed = imageDataUrl ? await callOpenAI({ imageDataUrl, categories, hint: body.hint || '' }) : { receipts: [], globalWarnings: [] };
    let receipts = Array.isArray(parsed.receipts) ? parsed.receipts : [];
    if (!receipts.length && ocrText) receipts = [{ merchant: null, amount: null, date: null, category: null, budgetBucket: null, confidence: 0.25, comment: null, warnings: [], rawText: ocrText, amountCandidates: [], crop: null, corners: null }];

    receipts = receipts.map(r => {
      const rawText = [r.rawText, ocrText].filter(Boolean).join('\n');
      const amountCandidates = [
        ...(Array.isArray(r.amountCandidates) ? r.amountCandidates : []),
        ...amountCandidatesFromText(rawText)
      ];
      const merchant = (r.merchant && !/^null$/i.test(String(r.merchant))) ? String(r.merchant).trim().slice(0, 70) : merchantFromText(rawText);
      const amount = pickAmount(r.amount ?? r.total ?? r.totalAmount, amountCandidates);
      const date = parseDate(r.date) || parseDate(rawText);
      const category = findCategory(r.categoryId || r.category, `${merchant || ''}\n${rawText}\n${r.comment || ''}`, categories);
      const budgetBucket = bucketForCategory(category, r.budgetBucket, categories);
      const confidence = Math.max(0, Math.min(1, Number(r.confidence || 0.55)));
      const missing = [];
      if (!merchant) missing.push('fournisseur');
      if (!amount) missing.push('montant');
      if (!date) missing.push('date');
      return {
        merchant,
        amount,
        date,
        category,
        categoryId: category,
        budgetBucket,
        confidence,
        needsReview: missing.length > 0 || confidence < 0.62,
        comment: r.comment || null,
        warnings: [...(Array.isArray(r.warnings) ? r.warnings : []), ...(missing.length ? [`À vérifier : ${missing.join(', ')}`] : [])],
        rawText: rawText || null,
        amountCandidates: amountCandidates.slice(0, 10),
        crop: r.crop || null,
        corners: r.corners || null
      };
    });

    return send(res, 200, { ok: true, configured: true, version: '2.1.11', results: receipts, globalWarnings: parsed.globalWarnings || [] });
  } catch (error) {
    const status = error && error.status ? error.status : 504;
    return send(res, status, { ok: false, configured: true, version: '2.1.11', error: 'Lecture automatique impossible pour ce ticket. Relance la lecture ou complète à la main.' });
  }
};

module.exports.config = { maxDuration: 60 };
