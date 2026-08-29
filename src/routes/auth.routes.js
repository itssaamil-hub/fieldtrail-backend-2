const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { signToken } = require("../utils/tokens");
const { logActivity } = require("../utils/logging");

const router = express.Router();

// POST /auth/login  { phone, password }
router.post("/login", async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) {
    return res.status(400).json({ error: "phone and password are required" });
  }

  const { rows } = await db.query(
    `SELECT id, role, full_name, password_hash, is_active FROM users WHERE phone = $1`,
    [phone]
  );
  const user = rows[0];
  if (!user || !user.is_active) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const token = signToken(user);
  await logActivity({ actorId: user.id, action: "user.login", entityType: "user", entityId: user.id });

  res.json({
    token,
    user: { id: user.id, role: user.role, full_name: user.full_name },
  });
});

module.exports = router;
