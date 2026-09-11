# MX Preflight v2 — Private dnsx Web UI

MX Preflight is a private multi-user web application around [ProjectDiscovery dnsx](https://github.com/projectdiscovery/dnsx) for bulk DNS/MX preflight checks before deeper email verification.

Version 2 adds **SQLite-backed user accounts, login sessions, per-user scan history, admin user management, password controls, and persistent historical metadata**.

It does **not** verify whether a specific mailbox exists and it does not send email.

## v2 features

### Authentication and privacy

- First-run admin setup.
- Optional admin bootstrap from `.env` before the first public start.
- Username/password login.
- Passwords are hashed with Node.js `scrypt`; plaintext passwords are never stored.
- Random server-side sessions stored in SQLite.
- HttpOnly, SameSite=Strict session cookies.
- Secure cookie support when deployed behind HTTPS.
- Login failure rate limiting.
- User disabling and role management.
- Protection against disabling/demoting the final active administrator.
- Users can change their own passwords.
- Admin password reset invalidates that user's existing sessions.

### Users and scan history

- `admin` and `user` roles.
- Normal users see only their own jobs and result files.
- Administrators can create users, enable/disable users, change roles, reset passwords, and inspect user histories.
- Job metadata and scan summaries are persisted in SQLite at `data/app.db`.
- Result files remain on disk under `data/jobs/<job-id>/`.
- Result files can expire without deleting the historical scan record from SQLite.

### DNS/MX preflight

- TXT/CSV upload or pasted input.
- Domains, URLs, and email addresses are accepted.
- Domains are deduplicated before scanning.
- dnsx checks A, AAAA, NS and MX records.
- Separate NXDOMAIN pass.
- Common mail-provider detection.
- Classification:
  - `MAIL_ENABLED`
  - `NULL_MX`
  - `NO_MX`
  - `DNS_FAILED`
  - `UNKNOWN`
- CSV exports:
  - `full-results.csv`
  - `domain-results.csv`
  - `mail-enabled.csv`
  - `excluded.csv`
  - `review.csv`

## Architecture

```text
Browser
   |
   v
Node.js web/API server
   |---- SQLite: users, sessions, job history
   |---- Filesystem: uploaded inputs and result CSVs
   |
   v
dnsx
   |
   v
DNS / MX results and classifications
```

SQLite does not require a separate database service. For a private deployment with a small number of users it adds negligible compute overhead compared with Node.js and dnsx.

## Requirements

- Node.js **22.5 or newer**
- dnsx v1.3.1 or compatible
- Windows 10/11 or Linux

The web app itself has no third-party npm runtime dependencies. SQLite uses Node's built-in `node:sqlite` module.

## Windows quick start

From the project folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup-windows.ps1
.\scripts\run-local.ps1
```

Open:

```text
http://localhost:3000
```

If no users exist, you are redirected to:

```text
http://localhost:3000/setup
```

Create the first administrator, then sign in.

If you already have `dnsx.exe`, copy it to:

```text
tools\dnsx.exe
```

or set `DNSX_PATH` in `.env`.

## Linux / Oracle Cloud VM

Install Node.js 22+, Git, curl and unzip, then clone the repository.

```bash
git clone https://github.com/YOUR-USERNAME/preflight-dnsx-web.git
cd preflight-dnsx-web
chmod +x scripts/*.sh
./scripts/setup-linux.sh
```

The setup script downloads the correct official dnsx binary for `amd64` or `arm64`.

### Recommended: bootstrap the first admin before public exposure

Edit `.env`:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-this-with-a-long-random-password
```

Then start:

```bash
./scripts/run-linux.sh
```

After the first admin is created, the environment bootstrap values are ignored because the database is no longer empty. You may remove the plaintext bootstrap password from `.env` afterward and restart the service.

### Run continuously with systemd

```bash
sudo ./scripts/install-systemd.sh
```

Useful commands:

```bash
sudo systemctl status mx-preflight
sudo systemctl restart mx-preflight
journalctl -u mx-preflight -f
```

For a public deployment, put Nginx/Caddy/Cloudflare in front of port 3000, enable HTTPS, and close public access to port 3000 after the reverse proxy is working.

## Docker

```bash
cp .env.example .env
# Edit .env before first public start.
docker compose up -d --build
```

Persistent application data is mounted through:

```text
./data:/app/data
```

This preserves both SQLite and result files across container restarts/rebuilds.

## Configuration

See `.env.example`.

```env
PORT=3000
HOST=0.0.0.0
DNSX_PATH=

ADMIN_USERNAME=
ADMIN_PASSWORD=
SESSION_DAYS=14
COOKIE_SECURE=auto

MAX_UPLOAD_MB=25
RESULT_FILE_RETENTION_HOURS=720

DEFAULT_THREADS=100
DEFAULT_RATE_LIMIT=1000
MAX_THREADS=300
MAX_RATE_LIMIT=5000
```

### Result-file retention versus history

`RESULT_FILE_RETENTION_HOURS` controls only the files in `data/jobs/`.

For example, with the default `720` hours (30 days):

- scan summary/history remains in SQLite;
- downloadable CSVs and raw job files are removed after the retention window;
- the dashboard marks the historical job as having expired files.

Deleting a job manually removes both its database history and result files.

## Database and backups

SQLite files:

```text
data/app.db
data/app.db-wal
data/app.db-shm
```

Do not commit them to Git. They are already ignored by `.gitignore`.

For a simple backup, stop the app briefly and copy the `data/` directory. A production backup strategy should preserve both `app.db` and any job files that still need to remain downloadable.

## Security notes

- Use HTTPS for Internet-facing access.
- Do not expose the application without authentication.
- Keep `.env` out of Git.
- Use a long unique admin password.
- Normal users are restricted to their own scan jobs and downloads.
- Administrators can access all users' scan histories by design.
- The browser cannot inject arbitrary dnsx command-line arguments; scan arguments are assembled server-side.
- The app sets restrictive security headers and rejects cross-origin state-changing requests when an Origin header is present.

## What the statuses mean

| Status | Meaning | Default recommendation |
|---|---|---|
| `MAIL_ENABLED` | Normal MX server(s) found | Continue to deeper verification |
| `NULL_MX` | Domain explicitly says it does not accept mail | Exclude |
| `DNS_FAILED` | NXDOMAIN identified | Exclude |
| `NO_MX` | DNS exists but no MX published | Review; do not automatically call invalid |
| `UNKNOWN` | No confident answer | Retry / review |

`NO_MX` is deliberately not treated as invalid because SMTP can fall back to A/AAAA in some cases.

## Tests

```bash
npm test
```

The test suite covers input normalization, DNS/MX classification, password/session handling, admin safety, and per-user job-history isolation.

## Updating a deployed server from GitHub

After pushing new code:

```bash
cd ~/preflight-dnsx-web
git pull
sudo systemctl restart mx-preflight
```

The SQLite database and job files remain under `data/` and are ignored by Git, so normal code updates do not overwrite user accounts or histories.

## Third-party software

`dnsx` is developed by ProjectDiscovery and remains a separate open-source project. The dnsx binary is not bundled in this ZIP; setup/Docker scripts download the official release. Review ProjectDiscovery's license and documentation before redistribution or commercial use.
