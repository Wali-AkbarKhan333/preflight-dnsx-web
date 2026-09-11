# Changelog

## 2.0.0

- Added SQLite-backed users, sessions, and persistent scan history.
- Added first-run administrator setup and optional environment bootstrap.
- Added admin/user roles and per-user job isolation.
- Added admin user creation, enable/disable, role changes, password reset, and user history viewing.
- Added user password change flow.
- Added scrypt password hashing and server-side session tokens.
- Added session cookies, login throttling, security headers, and same-origin checks for state-changing requests.
- Separated scan history retention from result-file retention.
- Updated Docker persistence to mount the entire data directory.
- Updated minimum Node.js version to 22.5+ for built-in SQLite support.
- Added authentication/database tests and a 100-entry test dataset.
