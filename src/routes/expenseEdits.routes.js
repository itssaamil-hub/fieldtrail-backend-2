const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.patch("/:id", async (req, res) => {
  const { category, amount, salesmanId, note, spentOn } = req.body || {};
  const numAmount = Number(amount);
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Invalid expense." });
  if (!category || typeof category!=="string" || !category.trim() || category.trim().length>120) return res.status(400).json({ error: "Pick a valid category." });
  if (!Number.isFinite(numAmount) || numAmount <= 0 || numAmount>1000000000) return res.status(400).json({ error: "Enter a valid amount." });
  if (salesmanId && !UUID.test(String(salesmanId))) return res.status(400).json({ error: "Selected employee is not valid." });
  if (note!=null && (typeof note!=="string" || note.length>2000)) return res.status(400).json({ error: "Note must be at most 2000 characters." });
  if (spentOn && (!/^\d{4}-\d{2}-\d{2}$/.test(String(spentOn)) || !Number.isFinite(Date.parse(`${spentOn}T00:00:00Z`)))) return res.status(400).json({ error: "Enter a valid expense date." });

  const client=await db.pool.connect();
  try {
    await client.query('BEGIN');
    if (salesmanId) {
      const {rows:u}=await client.query("SELECT id FROM users WHERE id=$1 AND role='salesman' AND is_active=true FOR SHARE",[salesmanId]);
      if(!u.length) return await rollback(client,res,400,"Selected employee is not active.");
    }
    const { rows } = await client.query(
      `UPDATE expenses SET category=$2,amount=$3,salesman_id=$4,note=$5,spent_on=COALESCE($6::date,spent_on)
       WHERE id=$1 RETURNING id,category,amount,note,spent_on,salesman_id`,
      [req.params.id,category.trim(),numAmount,salesmanId||null,note?note.trim():null,spentOn||null]
    );
    if (!rows[0]) return await rollback(client,res,404,"Expense not found");
    const expense=rows[0];
    await client.query(
      `INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata)
       VALUES($1,'expense.updated','expense',$2,$3::jsonb)`,
      [req.user.id,expense.id,JSON.stringify({category:expense.category,amount:Number(expense.amount),spentOn:expense.spent_on})]
    );
    const user=expense.salesman_id?await client.query('SELECT full_name FROM users WHERE id=$1',[expense.salesman_id]):{rows:[]};
    await client.query('COMMIT');
    res.json({expense:{id:expense.id,category:expense.category,amount:Number(expense.amount),note:expense.note,spentOn:expense.spent_on,salesmanId:expense.salesman_id,salesmanName:user.rows[0]?.full_name||null}});
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
});

async function rollback(client,res,status,error){await client.query('ROLLBACK');res.status(status).json({error});return null;}

module.exports = router;
