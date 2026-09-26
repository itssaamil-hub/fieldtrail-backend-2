const jwt = require("jsonwebtoken");

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error("JWT_SECRET is not configured");
  return value;
}

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      name: user.full_name,
      ver: Number.isInteger(user.auth_version) ? user.auth_version : Number(user.auth_version || 0),
    },
    secret(),
    { algorithm: "HS256", expiresIn: process.env.JWT_EXPIRES_IN || "12h" }
  );
}

function verifyToken(token) {
  return jwt.verify(token, secret(), { algorithms: ["HS256"] });
}

module.exports = { signToken, verifyToken };
