const { neon } = require('@neondatabase/serverless');

const SHARED_SPACE_ID = 'budget-cecile-x-main';

function send(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 60_000_000) req.destroy(new Error('Données trop volumineuses.'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function safeParseState(value) {
  try { return JSON.parse(value || 'null'); } catch (_) { return null; }
}

function stamp(x) {
  return Date.parse(x?.updatedAt || x?.createdAt || 0) || 0;
}

function newer(a, b) {
  return stamp(a) >= stamp(b);
}

function mergeById(remoteArr = [], localArr = []) {
  const map = new Map();
  for (const x of Array.isArray(remoteArr) ? remoteArr : []) if (x?.id) map.set(x.id, x);
  for (const x of Array.isArray(localArr) ? localArr : []) if (x?.id) {
    const cur = map.get(x.id);
    if (!cur || newer(x, cur)) map.set(x.id, x);
  }
  return [...map.values()];
}

function mergeReceipts(remote = {}, local = {}) {
  const out = { ...(remote || {}) };
  for (const [id, r] of Object.entries(local || {})) {
    if (!out[id] || newer(r, out[id])) out[id] = r;
  }
  return out;
}

function mergeCategories(remoteArr = [], localArr = []) {
  const map = new Map();
  for (const c of Array.isArray(remoteArr) ? remoteArr : []) if (c?.id) map.set(c.id, c);
  for (const c of Array.isArray(localArr) ? localArr : []) if (c?.id) {
    const cur = map.get(c.id);
    if (!cur || newer(c, cur) || JSON.stringify(cur) !== JSON.stringify(c)) map.set(c.id, { ...(cur || {}), ...c });
  }
  return [...map.values()];
}

function mergeForMigration(remote, local) {
  if (!remote || typeof remote !== 'object') return local;
  if (!local || typeof local !== 'object') return remote;
  const out = { ...remote };
  if (stamp(local) >= stamp(remote) && Number(local.monthlyBudget) > 0) out.monthlyBudget = local.monthlyBudget;
  out.categories = mergeCategories(remote.categories, local.categories);
  out.expenses = mergeById(remote.expenses, local.expenses);
  out.pendingReceipts = mergeById(remote.pendingReceipts, local.pendingReceipts);
  out.receipts = mergeReceipts(remote.receipts, local.receipts);
  out.updatedAt = new Date().toISOString();
  return out;
}

async function ensureSchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS budget_public_state (
    space_id text PRIMARY KEY,
    payload text NOT NULL,
    revision bigint NOT NULL DEFAULT 1,
    last_device_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;
}

module.exports = async function handler(req, res) {
  if (!process.env.DATABASE_URL) {
    return send(res, 503, { ok: false, configured: false, error: 'Enregistrement en ligne à activer.' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    await ensureSchema(sql);

    if (req.method === 'GET') {
      const rows = await sql`SELECT payload, revision, updated_at FROM budget_public_state WHERE space_id = ${SHARED_SPACE_ID}`;
      if (!rows.length) return send(res, 404, { ok: false, configured: true, notFound: true });
      return send(res, 200, { ok: true, configured: true, payload: safeParseState(rows[0].payload), revision: Number(rows[0].revision), updatedAt: rows[0].updated_at });
    }

    if (req.method !== 'POST') {
      return send(res, 405, { ok: false, configured: true, error: 'Méthode non supportée.' });
    }

    const body = JSON.parse((await readBody(req)) || '{}');
    const action = ['pull', 'push', 'migrate'].includes(body.action) ? body.action : 'push';
    const deviceId = String(body.deviceId || 'unknown').slice(0, 120);
    const rows = await sql`SELECT payload, revision FROM budget_public_state WHERE space_id = ${SHARED_SPACE_ID}`;

    if (action === 'pull') {
      if (!rows.length) return send(res, 404, { ok: false, configured: true, notFound: true });
      return send(res, 200, { ok: true, configured: true, payload: safeParseState(rows[0].payload), revision: Number(rows[0].revision) });
    }

    if (!body.payload || typeof body.payload !== 'object') {
      return send(res, 400, { ok: false, configured: true, error: 'Données manquantes.' });
    }

    let payload = body.payload;
    if (action === 'migrate' && rows.length) {
      payload = mergeForMigration(safeParseState(rows[0].payload), body.payload);
    }

    const text = JSON.stringify(payload);
    if (!rows.length) {
      await sql`INSERT INTO budget_public_state (space_id, payload, revision, last_device_id) VALUES (${SHARED_SPACE_ID}, ${text}, 1, ${deviceId})`;
      return send(res, 200, { ok: true, configured: true, revision: 1, created: true, payload });
    }

    const nextRevision = Number(rows[0].revision || 0) + 1;
    await sql`UPDATE budget_public_state SET payload = ${text}, revision = ${nextRevision}, last_device_id = ${deviceId}, updated_at = now() WHERE space_id = ${SHARED_SPACE_ID}`;
    return send(res, 200, { ok: true, configured: true, revision: nextRevision, payload: action === 'migrate' ? payload : undefined });
  } catch (error) {
    console.error('sync error', error);
    return send(res, 500, { ok: false, configured: true, error: 'Enregistrement en ligne indisponible pour l’instant.' });
  }
};

module.exports.config = { maxDuration: 60 };
