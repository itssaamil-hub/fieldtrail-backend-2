const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { signToken } = require("../utils/tokens");
const { logActivity } = require("../utils/logging");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const DUMMY_HASH = "$2a$10$7EqJtq98hPqEX7fNZaFWoO5MXxE9FqP.pU0tqW9LwaZ4OqfXu6LeW";

function keyFor(req, phone) {
  return `${req.ip || req.socket?.remoteAddress || "unknown"}|${phone}`;
}
function stateFor(key) {
  const now = Date.now();
  let state = attempts.get(key);
  if (!state || now - state.startedAt > WINDOW_MS) state = { count: 0, startedAt: now };
  attempts.set(key, state);
  return state;
}
function recordFailure(key) {
  const state = stateFor(key);
  state.count += 1;
  attempts.set(key, state);
}
function pruneAttempts() {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, state] of attempts) {
    if (!state || state.startedAt < cutoff) attempts.delete(key);
  }
}

router.post("/login", async (req, res) => {
  pruneAttempts();
  const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!phone || !password || phone.length > 40 || password.length > 200) {
    return res.status(400).json({ error: "phone and password are required" });
  }

  const key = keyFor(req, phone);
  const state = stateFor(key);
  if (state.count >= MAX_ATTEMPTS) {
    const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (Date.now() - state.startedAt)) / 1000));
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "Too many login attempts. Try again later." });
  }

  const { rows } = await db.query(
    `SELECT id, role, full_name, phone, password_hash, is_active, auth_version FROM users WHERE phone = $1`,
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
  await logActivity({ actorId: user.id, action: "user.login", entityType: "user", entityId: user.id, metadata: { ip: req.ip || null } });

  res.json({
    token,
    user: { id: user.id, role: user.role, full_name: user.full_name, phone: user.phone },
  });
});

router.get("/me", requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, role, full_name, phone, is_active FROM users WHERE id = $1`,
    [req.user.id]
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ error: "Account not found" });
  res.json({ user });
});

router.patch("/me", requireAuth, async (req, res) => {
  const fullName = typeof req.body?.fullName === "string" ? req.body.fullName.trim() : "";
  const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
  if (fullName.length < 2 || fullName.length > 120) {
    return res.status(400).json({ error: "Name must be between 2 and 120 characters" });
  }
  if (!/^\+?[0-9]{8,15}$/.test(phone)) {
    return res.status(400).json({ error: "Enter a valid phone number" });
  }

  try {
    const { rows } = await db.query(
      `UPDATE users
       SET full_name = $1, phone = $2
       WHERE id = $3
       RETURNING id, role, full_name, phone, is_active`,
      [fullName, phone, req.user.id]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: "Account not found" });
    await logActivity({ actorId: req.user.id, action: "user.profile_updated", entityType: "user", entityId: req.user.id, metadata: { phone } });
    return res.json({ user });
  } catch (err) {
    if (err?.code === "23505") return res.status(409).json({ error: "That phone number is already in use" });
    throw err;
  }
});

router.post("/change-password", requireAuth, async (req, res) => {
  const currentPassword = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
  const newPassword = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current password and new password are required" });
  }
  if (newPassword.length < 8 || newPassword.length > 200) {
    return res.status(400).json({ error: "New password must be between 8 and 200 characters" });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: "New password must be different from the current password" });
  }

  const { rows } = await db.query(`SELECT password_hash FROM users WHERE id = $1`, [req.user.id]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: "Account not found" });

  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Current password is incorrect" });

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db.query(
    `UPDATE users
     SET password_hash = $1, auth_version = auth_version + 1
     WHERE id = $2`,
    [passwordHash, req.user.id]
  );
  await logActivity({ actorId: req.user.id, action: "user.password_changed", entityType: "user", entityId: req.user.id, metadata: { ip: req.ip || null } });
  res.json({ ok: true, reauthenticate: true });
});

module.exports = router;
