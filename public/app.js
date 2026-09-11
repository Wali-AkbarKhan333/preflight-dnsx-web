const $ = (id) => document.getElementById(id);
const state = { currentJobId: null, pollTimer: null };

const fmt = (n) => new Intl.NumberFormat().format(Number(n || 0));
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function badge(value) {
  const good = ['DNS_ACTIVE', 'MAIL_ENABLED'].includes(value);
  const bad = ['DNS_FAILED', 'NULL_MX'].includes(value);
  return `<span class="badge ${good ? 'good' : bad ? 'bad' : ''}">${escapeHtml(value)}</span>`;
}

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const type = res.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error || body || `Request failed (${res.status})`);
  return body;
}

async function loadHealth() {
  const pill = $('engineStatus');
  try {
    const data = await api('/api/health');
    if (data.dnsxInstalled) {
      pill.className = 'status-pill ok';
      pill.textContent = `dnsx ready · ${data.dnsx?.version || 'detected'}`;
      $('threads').max = data.limits?.maxThreads || 300;
      $('rateLimit').max = data.limits?.maxRateLimit || 5000;
    } else {
      pill.className = 'status-pill bad';
      pill.textContent = 'dnsx not installed';
    }
  } catch {
    pill.className = 'status-pill bad';
    pill.textContent = 'Backend unavailable';
  }
}

function initTabs() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $(`${btn.dataset.tab}Pane`).classList.add('active');
    });
  });
}

function initDropzone() {
  const drop = $('dropzone');
  const input = $('fileInput');
  const label = $('fileLabel');
  input.addEventListener('change', () => {
    label.textContent = input.files?.[0] ? `${input.files[0].name} · ${(input.files[0].size / 1024).toFixed(1)} KB` : 'The app extracts domains from domains, URLs, and email addresses.';
  });
  for (const event of ['dragenter','dragover']) drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.add('drag'); });
  for (const event of ['dragleave','drop']) drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.remove('drag'); });
  drop.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    const dt = new DataTransfer();
    dt.items.add(e.dataTransfer.files[0]);
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  });
}

async function submitScan(event) {
  event.preventDefault();
  $('formError').hidden = true;
  const file = $('fileInput').files?.[0];
  const text = $('pasteInput').value.trim();
  if (!file && !text) {
    $('formError').textContent = 'Choose a file or paste domains/email addresses first.';
    $('formError').hidden = false;
    return;
  }

  $('startBtn').disabled = true;
  $('startBtn').textContent = 'Reading input…';
  try {
    const fileText = file ? await file.text() : '';
    $('startBtn').textContent = 'Starting…';
    const payload = {
      filename: file?.name || '',
      fileText,
      pastedText: text,
      threads: Number($('threads').value),
      rateLimit: Number($('rateLimit').value)
    };
    const data = await api('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    state.currentJobId = data.job.id;
    $('jobSection').hidden = false;
    $('jobSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    renderJob(data.job);
    pollJob();
    loadJobs();
  } catch (error) {
    $('formError').textContent = error.message;
    $('formError').hidden = false;
  } finally {
    $('startBtn').disabled = false;
    $('startBtn').textContent = 'Start DNS / MX scan';
  }
}

function renderJob(job) {
  state.currentJobId = job.id;
  $('jobSection').hidden = false;
  $('jobTitle').textContent = `${job.sourceName || 'Scan'} · ${job.id.slice(0, 8)}`;
  $('jobStage').textContent = job.stage || job.status;
  $('jobProgress').textContent = `${job.progress || 0}%`;
  $('progressBar').style.width = `${Math.max(0, Math.min(100, job.progress || 0))}%`;

  $('jobError').hidden = !job.error;
  $('jobError').textContent = job.error || '';
  $('deleteJobBtn').hidden = ['queued','running'].includes(job.status);

  if (job.summary) {
    $('summaryGrid').hidden = false;
    $('mTotal').textContent = fmt(job.summary.totalDomains);
    $('mMail').textContent = fmt(job.summary.mailEnabled);
    $('mNoMx').textContent = fmt(job.summary.noMx);
    $('mNullMx').textContent = fmt(job.summary.nullMx);
    $('mFailed').textContent = fmt(job.summary.dnsFailed);
    $('mUnknown').textContent = fmt(job.summary.unknown);
  } else {
    $('summaryGrid').hidden = true;
  }

  if (job.downloads?.length) {
    const pretty = {
      'full-results.csv': 'Full results',
      'domain-results.csv': 'Unique domains',
      'mail-enabled.csv': 'Mail enabled',
      'excluded.csv': 'Excluded',
      'review.csv': 'Needs review'
    };
    $('downloads').innerHTML = job.downloads.map((name) => `<a href="/api/jobs/${job.id}/download/${name}">↓ ${pretty[name] || name}</a>`).join('');
    $('downloads').hidden = false;
  } else {
    $('downloads').hidden = true;
  }

  if (job.preview?.length) {
    $('previewBody').innerHTML = job.preview.map((row) => `<tr>
      <td>${escapeHtml(row.domain)}</td>
      <td>${badge(row.dnsStatus)}</td>
      <td>${badge(row.mailStatus)}</td>
      <td class="subtle">${escapeHtml(row.provider || '—')}</td>
      <td class="subtle">${escapeHtml((row.mx || []).join('; ') || '—')}</td>
      <td class="subtle">${escapeHtml(row.recommendedAction)}</td>
    </tr>`).join('');
    $('previewWrap').hidden = false;
  } else {
    $('previewWrap').hidden = true;
  }
}

async function pollJob() {
  clearTimeout(state.pollTimer);
  if (!state.currentJobId) return;
  try {
    const data = await api(`/api/jobs/${state.currentJobId}`);
    renderJob(data.job);
    if (['queued','running'].includes(data.job.status)) {
      state.pollTimer = setTimeout(pollJob, 1200);
    } else {
      loadJobs();
    }
  } catch (error) {
    $('jobError').textContent = error.message;
    $('jobError').hidden = false;
  }
}

async function loadJobs() {
  try {
    const { jobs } = await api('/api/jobs');
    if (!jobs.length) {
      $('recentJobs').innerHTML = '<div class="empty">No jobs yet.</div>';
      return;
    }
    $('recentJobs').innerHTML = jobs.map((job) => `<div class="recent-item">
      <div class="recent-name"><strong>${escapeHtml(job.sourceName || 'Scan')}</strong><span>${new Date(job.createdAt).toLocaleString()} · ${fmt(job.parseStats?.uniqueDomains)} unique domains</span></div>
      <span class="badge ${job.status === 'completed' ? 'good' : job.status === 'failed' ? 'bad' : ''}">${escapeHtml(job.status)}</span>
      <button data-job="${job.id}">Open</button>
    </div>`).join('');
    document.querySelectorAll('[data-job]').forEach((btn) => btn.addEventListener('click', () => openJob(btn.dataset.job)));
  } catch {
    $('recentJobs').innerHTML = '<div class="empty">Could not load job history.</div>';
  }
}

async function openJob(id) {
  try {
    const { job } = await api(`/api/jobs/${id}`);
    renderJob(job);
    $('jobSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (['queued','running'].includes(job.status)) pollJob();
  } catch (error) {
    alert(error.message);
  }
}

async function deleteCurrentJob() {
  if (!state.currentJobId || !confirm('Delete this job and its result files?')) return;
  try {
    await api(`/api/jobs/${state.currentJobId}`, { method: 'DELETE' });
    state.currentJobId = null;
    $('jobSection').hidden = true;
    loadJobs();
  } catch (error) {
    alert(error.message);
  }
}

$('scanForm').addEventListener('submit', submitScan);
$('refreshJobs').addEventListener('click', loadJobs);
$('deleteJobBtn').addEventListener('click', deleteCurrentJob);
initTabs();
initDropzone();
loadHealth();
loadJobs();
