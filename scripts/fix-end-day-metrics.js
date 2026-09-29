const fs = require('fs');
const path = 'src/utils/dayClosing.js';
let s = fs.readFileSync(path, 'utf8');
const bad = "(SELECT count(DISTINCT entity_id)::int FROM activity_logs WHERE actor_id=$1 AND action='lead.status_changed' AND metadata->>'to'='won' AND metadata->>'from' IS DISTINCT FROM 'won' AND (al.created_at AT TIME ZONE 'Asia/Kolkata')::date=$2::date) AS won,";
const good = "(SELECT count(DISTINCT al.entity_id)::int FROM activity_logs al WHERE al.actor_id=$1 AND al.action='lead.status_changed' AND al.metadata->>'to'='won' AND al.metadata->>'from' IS DISTINCT FROM 'won' AND (al.created_at AT TIME ZONE 'Asia/Kolkata')::date=$2::date) AS won,";
if (!s.includes(bad)) throw new Error('Expected broken End Day won metrics query not found');
s = s.replace(bad, good);
fs.writeFileSync(path, s);
