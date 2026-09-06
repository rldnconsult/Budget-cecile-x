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
    const action = body.action === 'pull' ? 'pull' : 'push';
    const deviceId = String(body.deviceId || 'unknown').slice(0, 120);

    const rows = await sql`SELECT payload, revision FROM budget_public_state WHERE space_id = ${SHARED_SPACE_ID}`;

    if (action === 'pull') {
      if (!rows.length) return send(res, 404, { ok: false, configured: true, notFound: true });
      return send(res, 200, { ok: true, configured: true, payload: safeParseState(rows[0].payload), revision: Number(rows[0].revision) });
    }

    if (!body.payload || typeof body.payload !== 'object') {
      return send(res, 400, { ok: false, configured: true, error: 'Données manquantes.' });
    }

    const text = JSON.stringify(body.payload);
    if (!rows.length) {
      await sql`INSERT INTO budget_public_state (space_id, payload, revision, last_device_id) VALUES (${SHARED_SPACE_ID}, ${text}, 1, ${deviceId})`;
      return send(res, 200, { ok: true, configured: true, revision: 1, created: true });
    }

    const nextRevision = Number(rows[0].revision || 0) + 1;
    await sql`UPDATE budget_public_state SET payload = ${text}, revision = ${nextRevision}, last_device_id = ${deviceId}, updated_at = now() WHERE space_id = ${SHARED_SPACE_ID}`;
    return send(res, 200, { ok: true, configured: true, revision: nextRevision });
  } catch (error) {
    return send(res, 500, { ok: false, configured: true, error: 'Enregistrement en ligne indisponible pour l’instant.' });
  }
};

module.exports.config = { maxDuration: 60 };
