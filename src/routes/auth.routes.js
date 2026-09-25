const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { signToken } = require("../utils/tokens");
const { logActivity } = require("../utils/logging");

const router = express.Router();
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const DUMMY_HASH = "$2a$10$7EqJtq98hPqEX7fNZaFWoO5MXxE9FqP.pU0tqW9LwaZ4OqfXu6LeW";

function keyFor(req, phone) {
  return `${req.ip || req.socket?.remoteAddress || 'unknown'}|${phone}`;
}
function stateFor(key) {
  const now = Date.now();
  let state = attempts.get(key);
  if (!state || now - state.startedAt > WINDOW_MS) state = { count:0, startedAt:now };
  attempts.set(key, state);
  return state;
}
function recordFailure(key) {
  const state = stateFor(key);
  state.count += 1;
  attempts.set(key, state);
}

router.post("/login", async (req, res) => {
  const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!phone || !password || phone.length > 40 || password.length > 200) {
    return res.status(400).json({ error: "phone and password are required" });
  }

  const key = keyFor(req, phone);
  const state = stateFor(key);
  if (state.count >= MAX_ATTEMPTS) {
    const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (Date.now() - state.startedAt)) / 1000));
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: "Too many login attempts. Try again later." });
  }

  const { rows } = await db.query(
    `SELECT id, role, full_name, password_hash, is_active FROM users WHERE phone = $1`,
    [phone]
  );
  const user = rows[0];
  const ok = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
  if (!user || !user.is_active || !ok) {
    recordFailure(key);
    return res.status(401).json({ error: "Invalid credentials" });
  }

  attempts.delete(key);
  const token = signToken(user);
  await logActivity({ actorId: user.id, action: "user.login", entityType: "user", entityId: user.id, metadata:{ ip:req.ip || null } });

  res.json({
    token,
    user: { id: user.id, role: user.role, full_name: user.full_name },
  });
});

module.exports = router;
