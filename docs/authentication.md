# Authentication and authorization

## Where authority lives

Edge middleware (`src/middleware.ts`) checks only whether a session cookie is
**present** and redirects anonymous visitors to `/signin`. It does not verify
the signature, read the database, or run initialisation — the Edge runtime has
no `node:crypto`, and splitting security decisions across two runtimes invites
the two to disagree.

Everything authoritative happens server-side in the Node runtime:

- every page in the `(app)` route group calls `requireUser(minimumRole)`
- every protected API route calls `apiUser(minimumRole)`

Both verify the cookie's HMAC and expiry **and** re-read the account from the
database. A forged cookie gets past the redirect only to be rejected there, and
a deactivated or demoted account takes effect on the next request rather than
at the end of the cookie's 12 hours.

## Passwords

scrypt, N=2^15, r=8, p=1, with a random 16-byte salt per password. The stored
form is `scrypt$N$r$p$salt$hash`. Comparison is constant-time. A plaintext
password is never stored, logged, or returned.

Sign-in failures are deliberately indistinguishable: an unknown email costs the
same work as a wrong password and returns the same message, so the endpoint
cannot be used to enumerate addresses.

## Sessions

A stateless, HMAC-SHA256-signed payload in an HttpOnly, `SameSite=Lax` cookie
(`Secure` in production) with an explicit 12-hour expiry checked server-side.
Mutating routes additionally reject a mismatched `Origin` header.

The signing key is `AUTH_SECRET` when set. When it is not, the key is derived
from the database connection string with HKDF-SHA256 and a fixed application
salt. That fallback keeps a fresh deployment usable without manual
configuration; it is a deliberate, documented trade-off, not an accident:

- rotating the database password invalidates every session
- anyone holding the connection string could mint a session — though they could
  equally write a password hash directly, so it is not a privilege escalation

**Set `AUTH_SECRET` explicitly in production.**

## Roles

| Role | May |
| --- | --- |
| `viewer` | Read every screen and report. |
| `manager` | Everything a viewer may, plus upload, commit and discard imports. |
| `admin` | Everything a manager may, plus user management and migrations. |

Role restrictions are enforced on the server. The interface hides actions a
role cannot perform, but hiding is a convenience: `POST /api/imports` checks for
`manager` itself, and `/api/admin/*` checks for `admin` itself.

Two guards protect against locking everyone out: an administrator cannot change
their own role or disable their own account, and the last enabled administrator
cannot be demoted or disabled.

## No public signup

There is no registration endpoint. Accounts exist because an administrator
created them, or because of the one-time `BOOTSTRAP_ADMIN_*` sign-in described
in `docs/deployment.md`.
