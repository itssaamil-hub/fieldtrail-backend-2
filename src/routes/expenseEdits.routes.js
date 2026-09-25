const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { logActivity } = require("../utils/logging");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

// PATCH /admin/expenses/:id — correct an existing expense without deleting/recreating it.
router.patch("/:id", async (req, res) => {
  const { category, amount, salesmanId, note, spentOn } = req.body || {};
  const numAmount = Number(amount);

  if (!category || !String(category).trim()) {
    return res.status(400).json({ error: "Pick a category." });
  }
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: "Enter a valid amount." });
  }
  if (spentOn && !/^\d{4}-\d{2}-\d{2}$/.test(String(spentOn))) {
    return res.status(400).json({ error: "Enter a valid expense date." });
  }

  try {
    const { rows } = await db.query(
      `UPDATE expenses
       SET category = $2,
           amount = $3,
           salesman_id = $4,
           note = $5,
           spent_on = COALESCE($6::date, spent_on)
       WHERE id = $1
       RETURNING id, category, amount, note, spent_on, salesman_id`,
      [
        req.params.id,
        String(category).trim(),
        numAmount,
        salesmanId || null,
        note ? String(note).trim() : null,
        spentOn || null,
      ]
    );

    if (!rows[0]) return res.status(404).json({ error: "Expense not found" });

    const expense = rows[0];
    const user = expense.salesman_id
      ? await db.query(`SELECT full_name FROM users WHERE id = $1`, [expense.salesman_id])
      : { rows: [] };

    await logActivity({
      actorId: req.user.id,
      action: "expense.updated",
      entityType: "expense",
      entityId: expense.id,
      metadata: { category: expense.category, amount: Number(expense.amount), spentOn: expense.spent_on },
    });

    res.json({
      expense: {
        id: expense.id,
        category: expense.category,
        amount: Number(expense.amount),
        note: expense.note,
        spentOn: expense.spent_on,
        salesmanId: expense.salesman_id,
        salesmanName: user.rows[0]?.full_name || null,
      },
    });
  } catch (err) {
    if (err.code === "23503") return res.status(400).json({ error: "Selected employee is not valid." });
    throw err;
  }
});

module.exports = router;
