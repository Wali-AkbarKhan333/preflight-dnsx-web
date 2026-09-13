# Changelog

## 2.6.2 - Reliability follow-up

- Made retry worklists atomic and committed the next-resolver checkpoint before replacing the worklist, so a restart cannot silently skip the remaining domains.
- Detects a stale retry offset/worklist pair and safely replays that resolver pass.
- Accepts both dnsx MX targets and DNS-library presentation values such as `10 mail.example.com.` and `0 .`.
- Streams the canonical domain archive before report generation and builds reports from that archive, avoiding a second in-memory canonical result array.
- Reduced checkpoint-time memory by retaining only status fields needed for live counter updates.
- Added regression coverage for retry transition recovery, preference-form MX values, asynchronous report streams, and canonical archive row counts.

## 2.6.1 - Consistency hotfix

- Fixed the large false-`UNKNOWN` problem caused by relying on MX-filtered JSON output to identify domains with no MX record.
- UNKNOWN candidates now use a dedicated `dnsx -rcode` status pass, so `NOERROR` becomes `NO_MX`, `NXDOMAIN` becomes `DNS_FAILED`, and only SERVFAIL/REFUSED/no-response cases remain `UNKNOWN`.
- Added `MAIN_RETRY_ATTEMPTS=2` to reduce false NO_MX results from transiently missed MX responses.
- Fixed retry-stage counters so the current-stage processed count, rate, and ETA all use the same resolver-pass denominator.
- Labeled the top progress percentage as **Overall** progress and clarified the stage-specific processed/ETA labels.
- Added automatic migration for a v2.6 job interrupted inside the old MX-only retry stage; the main scan is preserved and only the new status pass is restarted.
- Added tests that mimic current dnsx behavior where MX JSON output omits NO_MX/NXDOMAIN hosts.

## 2.6.0 - Milestone 3: pause, partial reports and finalization hardening

- Added Pause for active scans. Pause takes effect after the current checkpoint batch is safely committed.
- Added resume support for `paused` jobs using the existing persistent checkpoint system.
- Cancel now preserves fully checkpointed work instead of discarding all useful output.
- Added partial downloads for paused, canceled, interrupted, and failed jobs that have saved progress.
- Added `unprocessed-domains.csv` so the remaining work can be downloaded separately.
- Partial exports include only fully checkpointed domains; an unfinished batch is never reported as completed.
- Partial report files are generated lazily on first download so stopping a scan does not delay the serial queue.
- Added an Unprocessed dashboard metric for partial jobs.
- Reworked final CSV/JSON generation to stream to disk instead of constructing very large in-memory strings.
- Report writes now use temporary files plus atomic rename, reducing the chance of half-written downloads after a crash.
- Finalization checks pause/cancel state while streaming, so a job can stop safely during the 96–100% report stage.
- Added tests for pause/resume behavior and partial-report checkpoint boundaries.

## 2.5.0 - Milestone 2: checkpoint and resume

- Added persistent `checkpoint.json` state after every completed DNS batch.
- Added append-only raw DNS and attempt logs so completed work can be reconstructed after process/server restarts.
- Added resumable main-pass scanning: completed batches are skipped after restart.
- Added retry-stage checkpoints, including resolver index and position inside the current UNKNOWN retry pass.
- Added finalization checkpoints: if DNS is already 100% complete, resume performs no new DNS queries and continues report generation only.
- Running jobs found after a server restart now become `interrupted` and show **Resume** when a valid checkpoint exists.
- Added `POST /api/jobs/:id/resume` and Resume controls in the current-job view and history.
- Added automatic additive SQLite migration for checkpoint metadata; existing users, sessions, and history remain intact.
- Changed the recommended/default scan batch size to 5,000 domains for more frequent checkpoints.
- Added automated tests for main-pass resume, retry-pass resume, finalization-only resume, queue recovery, and legacy database migration.

## 2.4.0 - Milestone 1: correctness and consistency

- Added an explicit fixed DNS resolver pool used by both local and live deployments.
- Added slower deterministic retries for domains still classified UNKNOWN after the fast pass.
- Added canonical final result metadata per unique domain: status codes, responding resolvers, verification passes and last-check time.
- Dashboard and reports now derive from the same canonical domain result set.
- Split MX-enabled counts into `MX-enabled domains` and `MX-enabled emails`.
- Added explicit input record and input email counts.
- Added `mx-enabled-domains.csv`, `mx-enabled-emails.csv`, and `scan-summary.csv`.
- Added canonical JSONL/JSON and scan metadata files for reproducible report generation.
- Added completion-time consistency validation so contradictory totals cannot be published as a successful job.
- Added automated tests verifying resolver retries and exact agreement between dashboard summary counts and CSV row counts.

## 2.1.1
- Made the progressive scanner test platform-independent so `npm test` works on Windows as well as Linux.
- Production scanner behavior is unchanged from 2.1.0.

## 2.1.0

- Added live, chunk-level progress for large DNS/MX scans.
- Added stage processed count, current domains/second, elapsed time, and estimated remaining time.
- Added progressive result counters while dnsx is still running instead of showing zeros until the end.
- Split large dnsx jobs into configurable batches (`SCAN_CHUNK_SIZE`, default 5,000) so progress can be persisted between batches.
- Fixed `Maximum call stack size exceeded` on large CSV files by removing huge spread-operator calls and parsing input incrementally.
- Reduced temporary allocations while parsing large CSV/TXT inputs.
- Added large-input and progressive-scanner automated tests.
- Removed the three dashboard notes requested in the previous UI cleanup.

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

## 2.2.0 - Fast MX preflight
- Reworked the default scan into a single MX+RCODE pass instead of A/AAAA/MX/NS plus a second NXDOMAIN pass.
- Cuts baseline DNS work from roughly five queries per domain to roughly one query per domain for the cold-outbound preflight use case.
- Uses NOERROR/NXDOMAIN/SERVFAIL/REFUSED response codes to distinguish mail-enabled, no-MX, DNS-failed, and unknown domains without a second full pass.
- Reduced retries to 1 and timeout to 2 seconds for faster bulk processing.
- Increased default concurrency to 200 threads / 2000 requests per second, with higher configurable ceilings.
- Increased default chunk size to 10,000 domains to reduce process-launch overhead while preserving live progress.

## 2.3.0 - Serial scan queue and cancellation

- Added a global scan queue; only one scan runs at a time by default.
- New uploads wait in `queued` state instead of competing with an active scan.
- Added Cancel controls for running and queued jobs.
- Canceling a running job aborts the current dnsx process; canceling a queued job removes it before it starts.
- Queue position is shown in the job stage.
- Running jobs left behind by a server restart are marked canceled/interrupted; queued jobs resume through the queue.
- Added `MAX_CONCURRENT_SCANS=1` configuration, recommended for the free Oracle VM.
