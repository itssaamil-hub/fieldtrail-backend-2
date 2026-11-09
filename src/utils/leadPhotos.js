const BUCKET = 'engage-lead-photos';
const MAX_BYTES = 150 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function photoPath(salesmanId, clientUuid) {
  if (!UUID.test(String(salesmanId)) || !UUID.test(String(clientUuid))) throw fail('Invalid photo identifier');
  return `${String(salesmanId).toLowerCase()}/${String(clientUuid).toLowerCase()}.webp`;
}
function parsePhoto(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 210000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw fail('Invalid photo data');
  const data = Buffer.from(value, 'base64');
  if (!data.length || data.length > MAX_BYTES) throw fail('Restaurant photo must be 150 KB or less');
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP')
    throw fail('Restaurant photo must be a WebP image');
  return data;
}
function config() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!/^https:\/\/[^/]+\.supabase\.co$/.test(url) || !key) throw fail('Photo storage is not configured', 503);
  return {url,key};
}
function validPath(path) {
  if (typeof path !== 'string' || !/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.webp$/i.test(path)) throw fail('Invalid photo path');
  return path;
}
async function storage(method, route, bytes) {
  const {url,key} = config();
  let res;
  try {
    res = await fetch(`${url}/storage/v1${route}`, {
      method, headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        ...(bytes ? {'Content-Type':'image/webp','x-upsert':'true'} : {})
      }, body: bytes, signal: AbortSignal.timeout(12000)
    });
  } catch {
    throw fail('Photo storage is temporarily unavailable', 503);
  }
  if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
    throw fail('Photo storage operation failed', 503);
  }
  return res;
}
async function upload(path, bytes) {
  validPath(path);
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) throw fail('Invalid photo size');
  await storage('POST', `/object/${BUCKET}/${path}`, bytes);
}
async function download(path) {
  validPath(path);
  const res = await storage('GET', `/object/authenticated/${BUCKET}/${path}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES || !bytes.length) throw fail('Stored photo is invalid', 502);
  return bytes;
}
async function remove(path) {
  validPath(path);
  await storage('DELETE', `/object/${BUCKET}/${path}`);
}
async function queueDeletion(query, path) {
  if (!path) return;
  validPath(path);
  await query('INSERT INTO lead_photo_cleanup_queue(path) VALUES($1) ON CONFLICT DO NOTHING', [path]);
}
let flushing = false;
async function flushDeletions(db, onlyPath = null) {
  if (flushing) return;
  flushing = true;
  try {
    const rows = await db.query(`SELECT path FROM lead_photo_cleanup_queue
      WHERE ($1::text IS NULL OR path=$1) ORDER BY created_at LIMIT 30`, [onlyPath]);
    for (const row of rows.rows) {
      try {
        await remove(row.path);
        await db.query('DELETE FROM lead_photo_cleanup_queue WHERE path=$1', [row.path]);
      } catch (err) {
        await db.query('UPDATE lead_photo_cleanup_queue SET attempts=attempts+1,last_error=$2 WHERE path=$1',
          [row.path, String(err.message || 'Storage failure').slice(0,200)]).catch(() => {});
      }
    }
  } finally { flushing = false; }
}
module.exports = {MAX_BYTES, BUCKET, fail, photoPath, parsePhoto, upload, download, remove, queueDeletion, flushDeletions};
