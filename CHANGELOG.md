# Changelog

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
