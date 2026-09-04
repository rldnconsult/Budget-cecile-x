const { neon } = require('@neondatabase/serverless');

function send(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
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
  await sql`CREATE TABLE IF NOT EXISTS budget_sync_events (
    id bigserial PRIMARY KEY,
    space_id text NOT NULL,
    device_id text,
    event_type text NOT NULL,
    revision bigint,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
}

module.exports = async function handler(req, res) {
  if (!process.env.DATABASE_URL) {
    return send(res, 503, { ok:false, configured:false, error:'DATABASE_URL manquant dans Vercel.' });
  }
  const sql = neon(process.env.DATABASE_URL);
  await ensureSchema(sql);

  try {
    if (req.method === 'GET') {
      const { spaceId, passHash } = req.query || {};
      if (!spaceId || !passHash) return send(res, 400, { ok:false, error:'spaceId/passHash manquant.' });
      const rows = await sql`SELECT space_id, pass_hash, encrypted_state, revision, updated_at FROM budget_sync_spaces WHERE space_id = ${spaceId}`;
      if (!rows.length) return send(res, 404, { ok:false, notFound:true });
      if (rows[0].pass_hash !== passHash) return send(res, 403, { ok:false, error:'Code de synchronisation incorrect.' });
      return send(res, 200, { ok:true, configured:true, encryptedState: rows[0].encrypted_state, revision: Number(rows[0].revision), updatedAt: rows[0].updated_at });
    }

    if (req.method === 'POST') {
      let body = '';
      await new Promise(resolve => { req.on('data', c => body += c); req.on('end', resolve); });
      const payload = JSON.parse(body || '{}');
      const { spaceId, passHash, encryptedState, clientRevision = 0, deviceId = 'unknown' } = payload;
      if (!spaceId || !passHash || !encryptedState) return send(res, 400, { ok:false, error:'payload incomplet.' });

      const rows = await sql`SELECT pass_hash, revision FROM budget_sync_spaces WHERE space_id = ${spaceId}`;
      if (!rows.length) {
        await sql`INSERT INTO budget_sync_spaces (space_id, pass_hash, encrypted_state, revision, last_device_id) VALUES (${spaceId}, ${passHash}, ${encryptedState}, 1, ${deviceId})`;
        await sql`INSERT INTO budget_sync_events (space_id, device_id, event_type, revision) VALUES (${spaceId}, ${deviceId}, 'create', 1)`;
        return send(res, 200, { ok:true, configured:true, revision:1, created:true });
      }
      if (rows[0].pass_hash !== passHash) return send(res, 403, { ok:false, error:'Code de synchronisation incorrect.' });
      const remoteRevision = Number(rows[0].revision);
      if (clientRevision && clientRevision < remoteRevision) {
        return send(res, 409, { ok:false, conflict:true, remoteRevision, message:'Une version en ligne plus récente existe.' });
      }
      const nextRevision = remoteRevision + 1;
      await sql`UPDATE budget_sync_spaces SET encrypted_state = ${encryptedState}, revision = ${nextRevision}, last_device_id = ${deviceId}, updated_at = now() WHERE space_id = ${spaceId}`;
      await sql`INSERT INTO budget_sync_events (space_id, device_id, event_type, revision) VALUES (${spaceId}, ${deviceId}, 'update', ${nextRevision})`;
      return send(res, 200, { ok:true, configured:true, revision:nextRevision });
    }

    return send(res, 405, { ok:false, error:'Méthode non supportée.' });
  } catch (error) {
    return send(res, 500, { ok:false, configured:true, error:String(error.message || error) });
  }
};
