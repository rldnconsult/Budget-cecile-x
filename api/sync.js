const { neon } = require('@neondatabase/serverless');

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
      if (body.length > 45_000_000) req.destroy(new Error('Données trop volumineuses.'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function ensureSchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS budget_sync_spaces (
    space_id text PRIMARY KEY,
    pass_hash text NOT NULL,
    encrypted_state text NOT NULL,
    revision bigint NOT NULL DEFAULT 1,
    last_device_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;
}

function safeParseState(value) {
  try { return JSON.parse(value || 'null'); } catch (_) { return null; }
}

module.exports = async function handler(req, res) {
  if (!process.env.DATABASE_URL) {
    return send(res, 503, { ok:false, configured:false, error:'Accès en ligne non configuré.' });
  }
  const sql = neon(process.env.DATABASE_URL);
  await ensureSchema(sql);

  try {
    if (req.method === 'GET') {
      const { spaceId, passHash } = req.query || {};
      if (!spaceId || !passHash) return send(res, 400, { ok:false, error:'Lien incomplet.' });
      const rows = await sql`SELECT pass_hash, encrypted_state, revision, updated_at FROM budget_sync_spaces WHERE space_id = ${spaceId}`;
      if (!rows.length) return send(res, 404, { ok:false, configured:true, notFound:true });
      if (rows[0].pass_hash !== passHash) return send(res, 403, { ok:false, configured:true, error:'Lien incorrect.' });
      return send(res, 200, { ok:true, configured:true, payload:safeParseState(rows[0].encrypted_state), revision:Number(rows[0].revision), updatedAt:rows[0].updated_at });
    }

    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const { action = 'push', spaceId, passHash, payload, deviceId = 'unknown' } = body;
      if (!spaceId || !passHash) return send(res, 400, { ok:false, configured:true, error:'Lien incomplet.' });

      const rows = await sql`SELECT pass_hash, encrypted_state, revision FROM budget_sync_spaces WHERE space_id = ${spaceId}`;
      if (action === 'pull') {
        if (!rows.length) return send(res, 404, { ok:false, configured:true, notFound:true });
        if (rows[0].pass_hash !== passHash) return send(res, 403, { ok:false, configured:true, error:'Lien incorrect.' });
        return send(res, 200, { ok:true, configured:true, payload:safeParseState(rows[0].encrypted_state), revision:Number(rows[0].revision) });
      }

      if (!payload || typeof payload !== 'object') return send(res, 400, { ok:false, configured:true, error:'Données manquantes.' });
      const text = JSON.stringify(payload);
      if (!rows.length) {
        await sql`INSERT INTO budget_sync_spaces (space_id, pass_hash, encrypted_state, revision, last_device_id) VALUES (${spaceId}, ${passHash}, ${text}, 1, ${deviceId})`;
        return send(res, 200, { ok:true, configured:true, revision:1, created:true });
      }
      if (rows[0].pass_hash !== passHash) return send(res, 403, { ok:false, configured:true, error:'Lien incorrect.' });
      const nextRevision = Number(rows[0].revision || 0) + 1;
      await sql`UPDATE budget_sync_spaces SET encrypted_state = ${text}, revision = ${nextRevision}, last_device_id = ${deviceId}, updated_at = now() WHERE space_id = ${spaceId}`;
      return send(res, 200, { ok:true, configured:true, revision:nextRevision });
    }

    return send(res, 405, { ok:false, configured:true, error:'Méthode non supportée.' });
  } catch (error) {
    return send(res, 500, { ok:false, configured:true, error:'Accès en ligne indisponible pour l’instant.' });
  }
};

module.exports.config = { maxDuration: 60 };
