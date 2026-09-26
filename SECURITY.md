# Engage Backend Security Notes

## Runtime model

Engage uses a server-side Express API connected directly to PostgreSQL. Browser clients never receive database credentials. Secrets such as `DATABASE_URL`, `JWT_SECRET`, `CRON_SECRET`, and VAPID private keys belong only in the deployment environment.

## Authentication

- Passwords are hashed with bcrypt.
- JWTs are signed with HS256 using `JWT_SECRET`.
- JWTs include an `auth_version` claim. Changing a password increments the user's database auth version, invalidating existing sessions.
- Login attempts are rate limited per IP + phone window.
- Disabled users are rejected on every authenticated request.

## HTTP hardening

Production browser origins must be explicitly listed in `CORS_ORIGINS`. The API sends no-store and baseline security headers, hides the Express signature, and returns a request ID for diagnostics.

## Spreadsheet dependency risk

The npm `xlsx` package is currently used only for generating XLSX exports. Known SheetJS advisories affect workbook parsing/read paths. Engage does not call `XLSX.read`, `XLSX.readFile`, or `sheet_to_json` on user-supplied files. A regression test fails if those parsing APIs are introduced.

If spreadsheet import is added later, replace the package or move to a patched parser before accepting untrusted workbook content.

## Secret handling

Never commit `.env` files, database passwords, JWT secrets, cron secrets, or VAPID private keys. Rotate any credential that is pasted into a public issue, commit, log, or chat transcript.

## Reporting

For a suspected security issue, avoid posting credentials or exploit details in public repository issues. Rotate affected secrets first, then investigate using deployment logs and request IDs.
