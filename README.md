# MX Preflight v2.6.2 — Private dnsx Web UI

MX Preflight is a private multi-user web application around ProjectDiscovery `dnsx` for bulk DNS/MX preflight checks before deeper mailbox verification.

It does **not** verify whether a specific mailbox exists and it does not send email.

## v2.6.2 reliability follow-up

This follow-up preserves the v2.6.1 classification and progress fixes while hardening restart and large-file behavior:

- Retry worklists are written atomically, and the next-resolver checkpoint is committed before the worklist is replaced. If a restart finds an older checkpoint with a shorter worklist, that pass is replayed rather than skipped.
- MX parsing accepts both dnsx target values and preference-prefixed DNS presentation values, including null MX (`0 .`).
- Finalization writes the canonical domain archive once, computes counts while streaming it, and derives domain reports from that archive. Checkpoint-time state retains only compact status fields needed for live counters.

## v2.6.1 consistency hotfix

This patch fixes two issues exposed by large real-world scans:

1. The retry stage previously used MX-filtered JSON output to decide whether a domain had no MX record. Current `dnsx` record filtering can omit hosts that have no requested MX value, which made valid `NO_MX` and `NXDOMAIN` cases look like `UNKNOWN`.
2. The retry UI mixed overall-work counters with current-stage counters, producing combinations such as `82%` overall while showing a stage denominator and ETA based on different work totals.

The retry stage now performs an explicit DNS response-code pass for domains that did not produce a conclusive MX result:

```text
MX found        -> MAIL_ENABLED
Null MX         -> NULL_MX
NOERROR         -> NO_MX
NXDOMAIN        -> DNS_FAILED
SERVFAIL        -> UNKNOWN
REFUSED         -> UNKNOWN
No response     -> UNKNOWN
```

The main MX pass uses two attempts by default to reduce the chance that a transiently dropped MX response is later mistaken for `NO_MX`.

During retry, the dashboard now uses one coherent stage denominator. The top percentage is explicitly labeled **Overall**, while **Current stage processed**, **Current rate**, and **Current stage ETA** all refer to the same current resolver pass.

If a v2.6 job is interrupted in the old retry stage and then resumed after upgrading to v2.6.1, its completed main MX scan is preserved. The legacy retry checkpoint is automatically converted to the new response-code pass instead of restarting the whole file.


## v2.6 milestone 3: pause, cancel, partial reports and safer finalization

Long scans can now be deliberately paused without discarding completed work. **Pause** waits for the current checkpoint batch to finish, saves the checkpoint, changes the job to `paused`, and exposes **Resume scan**. Resuming continues from the saved checkpoint.

Cancel now means permanent stop, but checkpointed work is retained. A paused, canceled, interrupted, or failed job with checkpointed progress exposes partial downloads based only on fully completed checkpoint batches. The unfinished batch is never reported as verified.

Available partial downloads are:

- `partial-scan-summary.csv`
- `partial-all-results.csv`
- `partial-domain-results.csv`
- `partial-mx-enabled-emails.csv`
- `partial-mx-enabled-domains.csv`
- `partial-excluded.csv`
- `partial-review.csv`
- `unprocessed-domains.csv`

Partial report files are generated **lazily on first download**, so pausing/canceling a large job does not block the scan queue while CSV files are being created. After a server restart, an interrupted checkpointed job immediately becomes resumable and its partial download links remain available.

The dashboard now shows an **Unprocessed** count for partial jobs, so processed categories are not confused with the original total-domain count.

Final report generation has also been changed from building very large CSV/JSON strings in Node memory to **streaming reports directly to temporary files and atomically renaming them when complete**. This reduces memory spikes and lowers the risk of a 502/crash during the 96–100% finalization stage. Finalization remains resumable and can be paused/canceled between streamed chunks.

## v2.5 milestone 2: checkpoint and resume

Long scans now persist a checkpoint after every completed DNS batch. The raw DNS output and attempt history are also appended to disk as scanning proceeds.

If Node, the VM, systemd, or the server is restarted, an active checkpointed job becomes `interrupted` instead of being discarded. The dashboard shows **Resume scan**, and the job continues from the last completed batch rather than starting from domain 1.

Default checkpoint size:

```env
SCAN_CHUNK_SIZE=5000
```

If the server stops halfway through a batch, only that unfinished batch is repeated. Already checkpointed batches are not queried again.

The checkpoint also records retry-pass position. Therefore a restart during the slower UNKNOWN retry stage continues inside that retry stage instead of repeating the main MX scan.

If all DNS work has already finished and the job is at the final report stage, the checkpoint phase is `finalizing`. Resuming that job performs **zero new DNS lookups** and only rebuilds the canonical results/reports.

Checkpoint state is written atomically to:

```text
data/jobs/<job-id>/checkpoint.json
dns.jsonl
attempts.log
retry-pass-domains.txt   # only while retrying UNKNOWN domains
```

SQLite also stores a small public checkpoint summary so the UI can show whether a job is resumable. Existing v2.4 databases are upgraded automatically; user accounts and old history are preserved.

Jobs created before v2.5 do not have checkpoint files, so an already-interrupted historical v2.4 scan cannot be retroactively resumed. New v2.5 scans are protected.

## v2.4 milestone 1: correctness and consistency

This release focuses on making local/live results and dashboard/report counts more consistent.

### Canonical domain results

Each unique domain receives one canonical final result containing:

- DNS status
- MX/mail status
- MX provider and servers
- DNS response codes seen
- resolvers that produced responses
- verification pass count
- last checked time
- recommended action

Dashboard totals and downloadable reports are generated from the same canonical result set.

### Fixed resolver pool

Local and live deployments now use the same explicit resolver pool by default:

```text
1.1.1.1
8.8.8.8
9.9.9.9
```

Override it with `DNS_RESOLVERS` if required. Keeping the same resolver configuration on Windows and Oracle removes one major source of result variation.

### Uncertain-result retry

Domains without a conclusive MX result after the fast pass are checked more slowly with an explicit DNS response-code probe. Each configured retry resolver is tried separately for only the domains that remain uncertain. This allows the application to distinguish a real `NO_MX` (`NOERROR` with no MX result) from `NXDOMAIN`, `SERVFAIL`, `REFUSED`, or a timeout.

Default retry settings:

```env
MAIN_RETRY_ATTEMPTS=2
UNKNOWN_RETRY_RESOLVERS=1.1.1.1,8.8.8.8,9.9.9.9
UNKNOWN_RETRY_THREADS=50
UNKNOWN_RETRY_RATE_LIMIT=250
UNKNOWN_RETRY_ATTEMPTS=2
UNKNOWN_RETRY_TIMEOUT_SECONDS=4
```

This is intended to prevent NO_MX/NXDOMAIN cases from being lumped into `UNKNOWN` while still leaving genuinely uncertain SERVFAIL/REFUSED/timeout cases for review.

### Explicit domain counts vs email counts

The dashboard now separates:

- Input records
- Input emails
- Unique domains
- MX-enabled domains
- MX-enabled emails
- No-MX domains
- Null-MX domains
- DNS-failed domains
- Unknown domains

For example, three email addresses on one MX-enabled domain count as:

```text
MX-enabled domains: 1
MX-enabled emails:  3
```

This removes the previous ambiguity where the dashboard showed unique-domain counts while an export could contain multiple email rows for the same domain.

### Consistency validation

Before a job is marked complete, the application verifies:

```text
MX-enabled domains
+ No MX
+ Null MX
+ DNS failed
+ Unknown
= Total unique domains
```

It also checks that input email/other-input totals match the accepted input record count. A failed consistency check fails the job rather than publishing contradictory totals.

## Downloads

Completed jobs provide:

- `scan-summary.csv` — exact dashboard metrics and resolver configuration
- `full-results.csv` — every accepted input row mapped to its canonical domain result
- `domain-results.csv` — one row per unique domain
- `mx-enabled-emails.csv` — email input rows whose domain has MX
- `mx-enabled-domains.csv` — unique domains with MX
- `excluded.csv` — null-MX and DNS-failed input rows
- `review.csv` — no-MX and unknown input rows

The job directory also stores canonical JSON results for internal use:

```text
canonical-domain-results.jsonl
domain-results.json
scan-metadata.json
dns.jsonl
```

## Existing features retained

- SQLite-backed users and sessions
- Admin/user roles
- Per-user scan history
- Large CSV-safe parsing
- Live progress, rate, elapsed time and ETA
- Fast MX+RCODE scan
- One active scan at a time by default
- Queue positions
- Pause and resume running jobs
- Cancel jobs while preserving checkpointed partial results
- Partial downloads plus a separate unprocessed-domain file
- Persistent batch checkpoints and restart recovery
- Resume interrupted scans from the last completed checkpoint
- Common MX provider detection
- Result-file retention separate from scan history

## Architecture

```text
Browser
   |
   v
Node.js web/API server
   |---- SQLite: users, sessions, job history
   |---- Filesystem: inputs, raw DNS output, canonical results, CSV reports
   |
   v
dnsx
   |
   +---- fixed resolver pool
   |
   +---- explicit RCODE status pass for uncertain domains
```

## Requirements

- Node.js 22.5+
- dnsx v1.3.1 or compatible
- Windows 10/11 or Linux

The application has no third-party npm runtime dependencies. SQLite uses Node's built-in `node:sqlite` module.

## Windows quick start

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup-windows.ps1
.\scripts\run-local.ps1
```

Open:

```text
http://localhost:3000
```

## Linux / Oracle Cloud VM

```bash
git clone https://github.com/YOUR-USERNAME/preflight-dnsx-web.git
cd preflight-dnsx-web
chmod +x scripts/*.sh
./scripts/setup-linux.sh
```

Run continuously with systemd:

```bash
sudo ./scripts/install-systemd.sh
sudo systemctl status mx-preflight
```

For Internet-facing use, keep Node on localhost/port 3000 behind Nginx or another reverse proxy and use HTTPS.

## Configuration

Copy `.env.example` to `.env` and adjust as needed.

Important scan settings:

```env
DEFAULT_THREADS=200
DEFAULT_RATE_LIMIT=2000
MAX_THREADS=500
MAX_RATE_LIMIT=10000
SCAN_CHUNK_SIZE=5000
MAX_CONCURRENT_SCANS=1

DNS_RESOLVERS=1.1.1.1,8.8.8.8,9.9.9.9
MAIN_RETRY_ATTEMPTS=2
UNKNOWN_RETRY_RESOLVERS=1.1.1.1,8.8.8.8,9.9.9.9
UNKNOWN_RETRY_THREADS=50
UNKNOWN_RETRY_RATE_LIMIT=250
UNKNOWN_RETRY_ATTEMPTS=2
UNKNOWN_RETRY_TIMEOUT_SECONDS=4
```

Use the same `.env` resolver values locally and on Oracle when comparing the same dataset.

## Status meanings

| Status | Meaning | Default recommendation |
|---|---|---|
| `MAIL_ENABLED` | One or more MX servers found | Continue to deeper verification |
| `NULL_MX` | Domain explicitly indicates it does not accept mail | Exclude |
| `DNS_FAILED` | NXDOMAIN | Exclude |
| `NO_MX` | DNS exists but no MX is published | Review |
| `UNKNOWN` | No confident final answer after retries | Retry/review |

## Tests

```bash
npm test
```

v2.6.2 includes tests for pause/resume state transitions, partial-report boundaries, main-pass resume, retry-pass resume, finalization-only resume with zero DNS lookups, legacy v2.6 retry migration, server-restart recovery, automatic v2.4 database migration, canonical count consistency, explicit RCODE status classification, large input parsing, queue behavior, authentication, and job isolation.

## Updating a deployed server

```bash
cd /home/ubuntu/preflight-dnsx-web
git pull --ff-only origin main
npm test
sudo systemctl restart mx-preflight
```

`data/`, `.env`, user accounts, passwords and scan history remain outside normal Git updates.

## Third-party software

`dnsx` is developed by ProjectDiscovery and remains a separate open-source project. The binary is not bundled in this ZIP; setup scripts download the official release.

The original three milestones are complete. v2.6.2 is a post-milestone reliability patch based on real large-file testing.
