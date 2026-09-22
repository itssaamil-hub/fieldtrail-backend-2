const db = require("../db");

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

async function findLeadDuplicates({ phone, businessName, subLocation }) {
  const phoneKey = normalizePhone(phone);
  const business = String(businessName || "").trim().toLowerCase();
  const location = String(subLocation || "").trim().toLowerCase();
  const matches = [];

  if (phoneKey.length >= 7) {
    const { rows } = await db.query(`
      SELECT l.id,l.business_name,l.sub_location,l.phone,l.status,l.salesman_id,u.full_name AS salesman_name
      FROM leads l LEFT JOIN users u ON u.id=l.salesman_id
      WHERE right(regexp_replace(coalesce(l.phone,''),'[^0-9]','','g'),10)=$1
      ORDER BY l.created_at DESC LIMIT 5`, [phoneKey]);
    for (const row of rows) matches.push({ ...row, matchType: "phone", exact: true });
  }

  if (business && location) {
    const { rows } = await db.query(`
      SELECT l.id,l.business_name,l.sub_location,l.phone,l.status,l.salesman_id,u.full_name AS salesman_name
      FROM leads l LEFT JOIN users u ON u.id=l.salesman_id
      WHERE lower(trim(l.business_name))=$1 AND lower(trim(coalesce(l.sub_location,'')))=$2
      ORDER BY l.created_at DESC LIMIT 5`, [business, location]);
    for (const row of rows) if (!matches.some(m => m.id === row.id)) matches.push({ ...row, matchType: "business_location", exact: false });
  }
  return matches;
}
module.exports = { normalizePhone, findLeadDuplicates };
