# MX Preflight — dnsx Web UI

A small web application that wraps [ProjectDiscovery dnsx](https://github.com/projectdiscovery/dnsx) for bulk DNS/MX preflight checks.

It is aimed at the **first, cheap filtering stage** of an email-data / cold-outbound hygiene workflow. It does **not** verify whether an individual mailbox exists and it does not send email.

## What it does

- Accepts TXT or CSV uploads, plus pasted input.
- Accepts domains, URLs, and email addresses; email addresses are reduced to their domains for DNS scanning.
- Deduplicates domains before scanning, so a domain is checked once even if many leads use it.
- Runs dnsx for A, AAAA, NS and MX records.
- Runs a separate NXDOMAIN pass.
- Classifies unique domains as:
  - `MAIL_ENABLED` — one or more normal MX servers were found.
  - `NULL_MX` — the domain explicitly indicates it does not accept mail.
  - `NO_MX` — DNS is active but no MX was found. This is **review**, not automatic invalidation, because SMTP allows A/AAAA fallback in some cases.
  - `DNS_FAILED` — NXDOMAIN was positively identified.
  - `UNKNOWN` — no confident classification (timeout/other resolution issue).
- Detects common MX providers such as Google Workspace and Microsoft 365.
- Produces downloadable CSV files:
  - `full-results.csv` — every accepted source input mapped back to its domain result.
  - `domain-results.csv` — one row per unique domain.
  - `mail-enabled.csv` — inputs whose domains have normal MX records.
  - `excluded.csv` — null-MX and DNS-failed inputs.
  - `review.csv` — no-MX and unknown inputs.
- Stores job files locally and supports automatic cleanup after a configurable retention period.
- Optional HTTP Basic Authentication for public deployments.

## Important interpretation

This application answers questions such as:

- Does this domain resolve?
- Does it publish MX records?
- Does it explicitly publish null MX?
- Which mail servers/provider handle the domain?

It **does not** answer:

> Does `john@company.com` definitely exist?

Mailbox-level verification requires a separate verification layer and is intentionally outside this project.

## Windows — quickest start

Requirements: Windows 10/11, PowerShell, Node.js 20+.

From the extracted project folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup-windows.ps1
.\scripts\run-local.ps1
```

The setup script downloads `dnsx` v1.3.1 from the official ProjectDiscovery GitHub release into `tools\dnsx.exe`, creates `.env` from `.env.example`. The web app itself has no npm dependencies.

Open:

```text
http://localhost:3000
```

If you already have your own `dnsx.exe`, you can instead copy it to:

```text
tools\dnsx.exe
```

or set `DNSX_PATH` in `.env` to the full executable path.

## Linux / Oracle Cloud VM

Requirements: Node.js 20+, curl and unzip.

```bash
chmod +x scripts/*.sh
./scripts/setup-linux.sh
./scripts/run-linux.sh
```

Then browse to:

```text
http://SERVER_IP:3000
```

Before exposing the service to the Internet, edit `.env` and set a real password:

```env
APP_USERNAME=admin
APP_PASSWORD=use-a-long-random-password
```

Then restart the app.

### Run continuously with systemd

After setup:

```bash
sudo ./scripts/install-systemd.sh
```

Useful commands:

```bash
sudo systemctl status mx-preflight
sudo systemctl restart mx-preflight
journalctl -u mx-preflight -f
```

For a production-facing deployment, put Nginx/Caddy/Cloudflare in front of port 3000 and use HTTPS. Do not expose an unprotected instance containing client lead data.

## Docker

Docker downloads the official dnsx release during image build:

```bash
cp .env.example .env
# Edit .env, especially APP_PASSWORD, before public deployment.
docker compose up -d --build
```

Open `http://localhost:3000`.

## Configuration

See `.env.example`.

Key values:

```env
PORT=3000
DNSX_PATH=
APP_USERNAME=admin
APP_PASSWORD=
MAX_UPLOAD_MB=25
JOB_RETENTION_HOURS=24
DEFAULT_THREADS=100
DEFAULT_RATE_LIMIT=1000
MAX_THREADS=300
MAX_RATE_LIMIT=5000
```

The backend uses `child_process.spawn` with an argument array and does not accept arbitrary command-line flags from the browser.

## Data handling

Each scan is stored under:

```text
data/jobs/<job-id>/
```

The browser can delete completed jobs. Old completed/failed jobs are also cleaned up on app startup based on `JOB_RETENTION_HOURS`.

No lead data is sent to this application's developer. DNS requests are, by definition, sent to DNS resolvers while dnsx performs its work.

## Result recommendations

| Status | Meaning | Default recommendation |
|---|---|---|
| MAIL_ENABLED | Normal MX server(s) found | Continue to mailbox-level verification |
| NULL_MX | Domain explicitly does not accept mail | Exclude |
| DNS_FAILED | NXDOMAIN identified | Exclude |
| NO_MX | DNS exists but no MX published | Review; do not automatically call invalid |
| UNKNOWN | No confident answer | Retry / review |

## Tests

```bash
npm test
```

The application uses only Node.js built-in modules, so there is no `npm install` step for the web application itself.

## Deployment note

Vercel is not the right host for the scanning backend because this app needs to execute a native `dnsx` binary and run jobs that may exceed a normal serverless request lifecycle. A small Linux VM is the intended deployment target. The frontend and backend are deliberately packaged together for the first version.

## Third-party software

`dnsx` is developed by ProjectDiscovery and is a separate open-source project. The dnsx binary is **not bundled in this ZIP**; the supplied setup/Docker scripts download the official release. Review ProjectDiscovery's license and documentation for dnsx before redistribution or commercial use.
