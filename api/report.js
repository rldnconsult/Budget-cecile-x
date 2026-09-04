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
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function wrapText(text, maxChars) {
  const words = safeText(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = (line + ' ' + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawText(page, text, x, y, options) {
  const { font, size = 10, color = rgb(0.19, 0.13, 0.2), maxChars = 80, lineHeight = size + 4, maxLines = 1 } = options;
  const lines = wrapText(text, maxChars).slice(0, maxLines);
  let cursor = y;
  for (const line of lines) {
    page.drawText(line, { x, y: cursor, size, font, color });
    cursor -= lineHeight;
  }
  return cursor;
}

function fitImage(width, height, maxW, maxH) {
  const scale = Math.min(maxW / width, maxH / height);
  return { width: width * scale, height: height * scale };
}

async function embedImage(pdfDoc, dataUrl) {
  const { mime, base64 } = stripDataUrl(dataUrl);
  const buffer = Buffer.from(base64, 'base64');
  if (mime.includes('png')) return pdfDoc.embedPng(buffer);
  return pdfDoc.embedJpg(buffer);
}

function addPage(pdfDoc) {
  return pdfDoc.addPage([595.28, 841.89]);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Méthode non supportée.' });

  try {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const state = payload.state || {};
    const expenses = Array.isArray(state.expenses) ? state.expenses : [];
    const attachments = Array.isArray(payload.attachments)
      ? payload.attachments.filter(a => a && a.include !== false && a.imageDataUrl)
      : [];

    const budget = Number(state.monthlyBudget || 0);
    const spent = expenses.filter(e => e.type !== 'planned').reduce((s, e) => s + Number(e.amount || 0), 0);
    const left = budget - spent;
    const byCat = {};
    for (const e of expenses) {
      const cat = safeText(e.category || 'Autres') || 'Autres';
      byCat[cat] = (byCat[cat] || 0) + Number(e.amount || 0);
    }
    const biggest = [...expenses].sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0)).slice(0, 8);

    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle('Rapport Budget Cecile');
    pdfDoc.setCreator('Budget Cecile Saclay');
    pdfDoc.setProducer('Budget Cecile Saclay');

    const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const ink = rgb(0.19, 0.13, 0.20);
    const muted = rgb(0.50, 0.38, 0.46);
    const accent = rgb(0.62, 0.09, 0.30);
    const okGreen = rgb(0.09, 0.40, 0.20);
    const alertRed = rgb(0.60, 0.11, 0.11);
    const palePink = rgb(1.00, 0.97, 0.99);
    const borderPink = rgb(0.97, 0.79, 0.87);

    let page = addPage(pdfDoc);
    const margin = 42;
    let y = 790;

    page.drawText('Rapport Budget Cecile', { x: margin, y, size: 22, font: bold, color: accent });
    y -= 24;
    page.drawText(`Genere le ${new Date().toLocaleDateString('fr-BE')}`, { x: margin, y, size: 10, font: regular, color: muted });
    y -= 35;

    page.drawRectangle({ x: margin, y: y - 82, width: 511, height: 82, color: palePink, borderColor: borderPink, borderWidth: 1 });
    page.drawText('Synthese', { x: margin + 18, y: y - 24, size: 13, font: bold, color: ink });
    page.drawText(left >= 0 ? 'Situation sous controle' : 'Budget depasse', { x: margin + 18, y: y - 48, size: 18, font: bold, color: left >= 0 ? okGreen : alertRed });
    page.drawText(`Budget: ${euro(budget)}   Depense: ${euro(spent)}   Reste: ${euro(left)}`, { x: margin + 18, y: y - 70, size: 12, font: regular, color: ink });
    y -= 120;

    page.drawText('Categories par poids budgetaire', { x: margin, y, size: 15, font: bold, color: ink });
    y -= 22;
    const sortedCats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sortedCats.length) {
      page.drawText('Aucune depense enregistree.', { x: margin, y, size: 11, font: regular, color: muted });
      y -= 18;
    } else {
      for (const [cat, val] of sortedCats) {
        const pct = budget ? `${(val / budget * 100).toFixed(1).replace('.', ',')} %` : '0 %';
        page.drawText(`${cat} - ${euro(val)} (${pct})`, { x: margin, y, size: 11, font: regular, color: ink });
        y -= 17;
      }
    }

    y -= 10;
    page.drawText('Plus grosses depenses', { x: margin, y, size: 15, font: bold, color: ink });
    y -= 22;
    if (!biggest.length) {
      page.drawText('Aucune depense enregistree.', { x: margin, y, size: 11, font: regular, color: muted });
    } else {
      for (const e of biggest) {
        const line = `${safeText(e.date || '')} - ${safeText(e.merchant || e.label || 'Depense')} - ${euro(e.amount)} - ${safeText(e.category || '')}${e.comment ? ' - ' + safeText(e.comment) : ''}`;
        y = drawText(page, line, margin, y, { font: regular, size: 10, color: ink, maxChars: 96, maxLines: 2, lineHeight: 13 });
        y -= 4;
        if (y < 80) { page = addPage(pdfDoc); y = 790; }
      }
    }

    if (payload.includeAttachments && attachments.length) {
      page = addPage(pdfDoc);
      y = 790;
      page.drawText('Annexes justificatifs', { x: margin, y, size: 18, font: bold, color: accent });
      y -= 32;

      const boxW = 245;
      const boxH = 265;
      const gap = 18;
      let x = margin;
      let col = 0;

      for (const att of attachments) {
        if (y - boxH < 42) {
          page = addPage(pdfDoc);
          y = 790;
          x = margin;
          col = 0;
        }

        page.drawRectangle({ x, y: y - boxH, width: boxW, height: boxH, borderColor: borderPink, borderWidth: 1, color: rgb(1, 1, 1) });
        drawText(page, `${att.label || att.merchant || 'Justificatif'} - ${euro(att.amount)}`, x + 10, y - 18, { font: bold, size: 9, color: ink, maxChars: 42, maxLines: 2, lineHeight: 11 });

        try {
          const img = await embedImage(pdfDoc, att.imageDataUrl);
          const dims = fitImage(img.width, img.height, boxW - 20, 180);
          const ix = x + (boxW - dims.width) / 2;
          const iy = y - 213 + (180 - dims.height) / 2;
          page.drawImage(img, { x: ix, y: iy, width: dims.width, height: dims.height });
        } catch (err) {
          page.drawText('Image non lisible', { x: x + 10, y: y - 105, size: 10, font: regular, color: alertRed });
        }

        drawText(page, `${att.date || ''} - ${att.category || ''}`, x + 10, y - 228, { font: regular, size: 8, color: muted, maxChars: 50, maxLines: 1 });
        if (att.comment) drawText(page, att.comment, x + 10, y - 244, { font: regular, size: 8, color: muted, maxChars: 55, maxLines: 2, lineHeight: 10 });

        if (col === 0) {
          x = margin + boxW + gap;
          col = 1;
        } else {
          x = margin;
          col = 0;
          y -= boxH + gap;
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
    console.error('report_pdf_error', error);
    sendJson(res, 500, { ok: false, error: 'Rapport PDF indisponible pour le moment.' });
  }
};
