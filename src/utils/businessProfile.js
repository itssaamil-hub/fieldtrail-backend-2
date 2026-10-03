const db = require('../db');

async function getBusinessName(query = db.query) {
  const { rows } = await query('SELECT business_name FROM business_profile WHERE id = 1');
  const value = rows[0]?.business_name;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

module.exports = { getBusinessName };
