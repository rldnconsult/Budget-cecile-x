const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

function sendJson(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}
function euro(value) {
  const n = Number(value || 0);
  return `${n.toFixed(2).replace('.', ',')} EUR`;
}
function safeText(value) {
  return String(value ?? '')
    .replace(/€/g, 'EUR')
    .replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '')
    .trim();
}
function stripDataUrl(dataUrl) {
  const raw = String(dataUrl || '');
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
  if (!match) return { mime: '', base64: raw };
  return { mime: match[1].toLowerCase(), base64: match[2] };
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 25_000_000) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
function wrapText(text, maxChars) {
  const words = safeText(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > maxChars && line) { lines.push(line); line = word; }
    else line = (line + ' ' + word).trim();
  }
  if (line) lines.push(line);
  return lines;
}
function drawText(page, text, x, y, options) {
  const { font, size = 10, color = rgb(0.19, 0.13, 0.2), maxChars = 80, lineHeight = size + 4, maxLines = 1 } = options;
  const lines = wrapText(text, maxChars).slice(0, maxLines);
  let cursor = y;
  for (const line of lines) { page.drawText(line, { x, y: cursor, size, font, color }); cursor -= lineHeight; }
  return cursor;
}
function fitImage(width, height, maxW, maxH, mode='contain') {
  const scale = mode === 'cover' ? Math.max(maxW / width, maxH / height) : Math.min(maxW / width, maxH / height);
  return { width: width * scale, height: height * scale, scale };
}
async function embedImage(pdfDoc, dataUrl) {
  const { mime, base64 } = stripDataUrl(dataUrl);
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('empty image');
  if (mime.includes('png')) return pdfDoc.embedPng(buffer);
  return pdfDoc.embedJpg(buffer);
}
const A4 = { portrait:[595.28, 841.89], landscape:[841.89, 595.28] };
function addA4(pdfDoc, orientation='portrait') { return pdfDoc.addPage(A4[orientation] || A4.portrait); }
function bucketName(id, labels) { return safeText(labels?.[id] || id || 'Budget'); }
function categoryName(id, labels) { return safeText(labels?.[id] || id || 'Catégorie'); }
function groupAttachments(items) {
  const groups = [];
  for (let i = 0; i < items.length;) {
    const a = items[i];
    const ar = Number(a.imageAspect || 0);
    const veryTall = ar && ar < 0.38;
    const next = items[i+1];
    if (veryTall || !next) { groups.push([a]); i += 1; }
    else { groups.push([a, next]); i += 2; }
  }
  return groups;
}
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Méthode non supportée.' });
  try {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const state = payload.state || {};
    const report = payload.report || {};
    const expenses = Array.isArray(state.expenses) ? state.expenses : [];
    const categories = Array.isArray(state.categories) ? state.categories : [];
    const catLabels = report.categoryLabels || Object.fromEntries(categories.map(c => [c.id, c.name]));
    const bucketLabels = report.bucketLabels || {ordinary:'Budget ordinaire',extraordinary:'Budget extraordinaire',school:'Budget scolaire'};
    const attachments = Array.isArray(payload.attachments) ? payload.attachments.filter(a => a && a.include !== false && a.imageDataUrl) : [];
    const budget = Number(state.monthlyBudget || 0);
    const spent = expenses.filter(e => e.type !== 'planned').reduce((s, e) => s + Number(e.amount || 0), 0);
    const left = budget - spent;
    const byCat = {};
    const byBucket = {};
    for (const e of expenses) {
      const cat = categoryName(e.category || 'other', catLabels);
      byCat[cat] = (byCat[cat] || 0) + Number(e.amount || 0);
      const b = bucketName(e.budgetBucket || 'ordinary', bucketLabels);
      byBucket[b] = (byBucket[b] || 0) + Number(e.amount || 0);
    }
    const biggest = [...expenses].sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0)).slice(0, 12);
    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle('Rapport Budget Cecile');
    pdfDoc.setCreator('Budget Cecile');
    pdfDoc.setProducer('Budget Cecile');
    const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const ink = rgb(0.19, 0.13, 0.20), muted = rgb(0.50, 0.38, 0.46), accent = rgb(0.62, 0.09, 0.30), okGreen = rgb(0.09, 0.40, 0.20), alertRed = rgb(0.60, 0.11, 0.11), palePink = rgb(1.00, 0.97, 0.99), borderPink = rgb(0.97, 0.79, 0.87);
    let page = addA4(pdfDoc, 'portrait');
    const margin = 42;
    let y = 790;
    page.drawText('Rapport Budget Cecile', { x: margin, y, size: 22, font: bold, color: accent });
    y -= 24;
    page.drawText(`Periode : ${safeText(report.periodLabel || '')}`, { x: margin, y, size: 11, font: regular, color: muted });
    y -= 16;
    page.drawText(`Genere le ${new Date().toLocaleDateString('fr-BE')}`, { x: margin, y, size: 10, font: regular, color: muted });
    y -= 32;
    page.drawRectangle({ x: margin, y: y - 88, width: 511, height: 88, color: palePink, borderColor: borderPink, borderWidth: 1 });
    page.drawText('Synthese', { x: margin + 18, y: y - 24, size: 13, font: bold, color: ink });
    page.drawText(left >= 0 ? 'Situation sous controle' : 'Budget depasse', { x: margin + 18, y: y - 50, size: 18, font: bold, color: left >= 0 ? okGreen : alertRed });
    page.drawText(`Budget mensuel: ${euro(budget)}   Depense: ${euro(spent)}   Reste: ${euro(left)}`, { x: margin + 18, y: y - 72, size: 12, font: regular, color: ink });
    y -= 126;
    page.drawText('Types de budget', { x: margin, y, size: 15, font: bold, color: ink });
    y -= 22;
    const bucketRows = Object.entries(byBucket).sort((a,b)=>b[1]-a[1]);
    if (!bucketRows.length) { page.drawText('Aucune depense dans la periode.', { x: margin, y, size: 11, font: regular, color: muted }); y -= 18; }
    else for (const [b,val] of bucketRows) { page.drawText(`${b} - ${euro(val)}`, { x: margin, y, size: 11, font: regular, color: ink }); y -= 17; }
    y -= 10;
    page.drawText('Categories', { x: margin, y, size: 15, font: bold, color: ink });
    y -= 22;
    const sortedCats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (!sortedCats.length) { page.drawText('Aucune depense dans la periode.', { x: margin, y, size: 11, font: regular, color: muted }); y -= 18; }
    else for (const [cat, val] of sortedCats) { const pct = budget ? `${(val / budget * 100).toFixed(1).replace('.', ',')} %` : '0 %'; page.drawText(`${cat} - ${euro(val)} (${pct})`, { x: margin, y, size: 11, font: regular, color: ink }); y -= 17; }
    y -= 10;
    page.drawText('Depenses principales', { x: margin, y, size: 15, font: bold, color: ink });
    y -= 22;
    if (!biggest.length) page.drawText('Aucune depense dans la periode.', { x: margin, y, size: 11, font: regular, color: muted });
    else {
      for (const e of biggest) {
        const line = `${safeText(e.date || '')} - ${safeText(e.merchant || e.label || 'Depense')} - ${euro(e.amount)} - ${categoryName(e.category || '', catLabels)} - ${bucketName(e.budgetBucket || 'ordinary', bucketLabels)}${e.comment ? ' - ' + safeText(e.comment) : ''}`;
        y = drawText(page, line, margin, y, { font: regular, size: 10, color: ink, maxChars: 96, maxLines: 2, lineHeight: 13 });
        y -= 4;
        if (y < 80) { page = addA4(pdfDoc, 'portrait'); y = 790; }
      }
    }
    if (payload.includeAttachments && attachments.length) {
      const groups = groupAttachments(attachments);
      for (const group of groups) {
        const orientation = group.length === 2 ? 'landscape' : 'portrait';
        page = addA4(pdfDoc, orientation);
        const [pw, ph] = page.getSize();
        const m = 28;
        page.drawText('Annexes justificatifs', { x: m, y: ph - 34, size: 15, font: bold, color: accent });
        page.drawText(`Periode : ${safeText(report.periodLabel || '')}`, { x: m + 170, y: ph - 33, size: 9, font: regular, color: muted });
        if (group.length === 1) {
          const att = group[0];
          const boxX = m, boxY = 48, boxW = pw - m * 2, boxH = ph - 96;
          await drawAttachment(pdfDoc, page, att, boxX, boxY, boxW, boxH, {regular,bold,ink,muted,borderPink,alertRed,catLabels,bucketLabels});
        } else {
          const gap = 18;
          const boxW = (pw - m*2 - gap) / 2, boxH = ph - 96;
          await drawAttachment(pdfDoc, page, group[0], m, 48, boxW, boxH, {regular,bold,ink,muted,borderPink,alertRed,catLabels,bucketLabels});
          await drawAttachment(pdfDoc, page, group[1], m + boxW + gap, 48, boxW, boxH, {regular,bold,ink,muted,borderPink,alertRed,catLabels,bucketLabels});
        }
      }
    }
    const bytes = await pdfDoc.save();
    const buffer = Buffer.from(bytes);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="rapport-budget-cecile.pdf"');
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  } catch (error) {
    console.error('report_pdf_error', error && (error.stack || error.message || error));
    sendJson(res, 500, { ok: false, error: 'Rapport PDF indisponible pour le moment.' });
  }
};
async function drawAttachment(pdfDoc, page, att, x, y, w, h, ctx) {
  const { regular, bold, ink, muted, borderPink, alertRed, catLabels, bucketLabels } = ctx;
  page.drawRectangle({ x, y, width: w, height: h, borderColor: borderPink, borderWidth: 1, color: rgb(1,1,1) });
  let top = y + h - 20;
  drawText(page, `${att.label || att.merchant || 'Justificatif'} - ${euro(att.amount)}`, x + 12, top, { font: bold, size: 10, color: ink, maxChars: Math.floor(w/5.4), maxLines: 2, lineHeight: 12 });
  top -= 28;
  drawText(page, `${att.date || ''} - ${categoryName(att.category || '', catLabels)} - ${bucketName(att.budgetBucket || 'ordinary', bucketLabels)}`, x + 12, top, { font: regular, size: 8, color: muted, maxChars: Math.floor(w/4.7), maxLines: 1 });
  try {
    const img = await embedImage(pdfDoc, att.imageDataUrl);
    const imageTopPad = 58, imageBottomPad = att.comment ? 42 : 24;
    const maxW = w - 24, maxH = h - imageTopPad - imageBottomPad;
    const dims = fitImage(img.width, img.height, maxW, maxH);
    const ix = x + (w - dims.width) / 2;
    const iy = y + imageBottomPad + (maxH - dims.height) / 2;
    page.drawImage(img, { x: ix, y: iy, width: dims.width, height: dims.height });
  } catch (err) {
    page.drawText('Image non lisible', { x: x + 12, y: y + h / 2, size: 10, font: regular, color: alertRed });
  }
  if (att.comment) drawText(page, att.comment, x + 12, y + 20, { font: regular, size: 8, color: muted, maxChars: Math.floor(w/4.7), maxLines: 2, lineHeight: 10 });
}
