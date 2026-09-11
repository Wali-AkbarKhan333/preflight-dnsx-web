const $ = (id) => document.getElementById(id);
const state = { currentJobId: null, pollTimer: null, me: null };

const fmt = (n) => new Intl.NumberFormat().format(Number(n || 0));
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDate = (value) => value ? new Date(value).toLocaleString() : '—';
const fmtDuration = (seconds) => {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 60) return `${Math.round(n)}s`;
  const mins = Math.floor(n / 60);
  const secs = Math.round(n % 60);
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
};

function badge(value) {
  const good = ['DNS_ACTIVE', 'MAIL_ENABLED', 'completed', 'active'].includes(value);
  const bad = ['DNS_FAILED', 'NULL_MX', 'failed', 'disabled'].includes(value);
  return `<span class="badge ${good ? 'good' : bad ? 'bad' : ''}">${escapeHtml(value)}</span>`;
}

async function api(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    location.replace('/login');
    throw new Error('Authentication required.');
  }
  const type = res.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error || body || `Request failed (${res.status})`);
  return body;
}

async function loadMe() {
  const data = await api('/api/me');
  state.me = data.user;
  $('currentUser').textContent = data.user.username;
  $('currentRole').textContent = data.user.role;
  if (data.user.role === 'admin') {
    $('adminPanel').hidden = false;
    loadUsers();
  }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  location.replace('/login');
}

async function loadHealth() {
  const pill = $('engineStatus');
  try {
    const data = await api('/api/health');
    if (data.dnsxInstalled) {
      pill.className = 'status-pill ok';
      pill.textContent = `dnsx ready · ${data.dnsx?.version || 'detected'}`;
      $('threads').max = data.limits?.maxThreads || 500;
      $('rateLimit').max = data.limits?.maxRateLimit || 10000;
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
    $('startBtn').textContent = 'Start fast MX scan';
  }
}

function renderJob(job) {
  state.currentJobId = job.id;
  $('jobSection').hidden = false;
  $('jobTitle').textContent = `${job.sourceName || 'Scan'} · ${job.id.slice(0, 8)}`;
  $('jobOwner').textContent = state.me?.role === 'admin' && job.ownerUsername ? `Owner: ${job.ownerUsername}` : '';
  $('jobStage').textContent = job.stage || job.status;
  $('jobProgress').textContent = `${job.progress || 0}%`;
  $('progressBar').style.width = `${Math.max(0, Math.min(100, job.progress || 0))}%`;

  $('jobError').hidden = !job.error;
  $('jobError').textContent = job.error || '';
  const cancelable = ['queued','running'].includes(job.status);
  $('cancelJobBtn').hidden = !cancelable;
  $('cancelJobBtn').textContent = job.status === 'queued' ? 'Cancel queued job' : (job.stage === 'Canceling…' ? 'Canceling…' : 'Cancel scan');
  $('cancelJobBtn').disabled = job.stage === 'Canceling…';
  $('deleteJobBtn').hidden = cancelable;
  $('expiredFiles').hidden = !job.filesDeleted;

  if (job.summary) {
    $('summaryGrid').hidden = false;
    $('mTotal').textContent = fmt(job.summary.totalDomains);
    $('mMail').textContent = fmt(job.summary.mailEnabled);
    $('mNoMx').textContent = fmt(job.summary.noMx);
    $('mNullMx').textContent = fmt(job.summary.nullMx);
    $('mFailed').textContent = fmt(job.summary.dnsFailed);
    $('mUnknown').textContent = fmt(job.summary.unknown);

    const stageTotal = Number(job.summary.stageTotal || job.summary.totalDomains || 0);
    const stageProcessed = Number(job.summary.stageProcessed || 0);
    $('liveProcessed').textContent = `${fmt(stageProcessed)} / ${fmt(stageTotal)}`;
    $('liveRate').textContent = `${fmt(Math.round(job.summary.rateDomainsPerSec || 0))} domains/s`;
    $('liveElapsed').textContent = fmtDuration(job.summary.elapsedSeconds);
    $('liveEta').textContent = job.status === 'completed' ? 'Done' : fmtDuration(job.summary.etaSeconds);
    $('liveStats').hidden = false;
  } else {
    $('summaryGrid').hidden = true;
    $('liveStats').hidden = true;
  }

  if (job.downloads?.length && !job.filesDeleted) {
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
      if (state.me?.role === 'admin') loadUsers();
    }
  } catch (error) {
    $('jobError').textContent = error.message;
    $('jobError').hidden = false;
  }
}

function recentJobMarkup(job, showOwner = false) {
  const owner = showOwner && job.ownerUsername ? ` · ${escapeHtml(job.ownerUsername)}` : '';
  const expired = job.filesDeleted ? ' · files expired' : '';
  const canCancel = ['queued','running'].includes(job.status);
  const statusClass = job.status === 'completed' ? 'good' : ['failed','canceled'].includes(job.status) ? 'bad' : '';
  return `<div class="recent-item">
    <div class="recent-name"><strong>${escapeHtml(job.sourceName || 'Scan')}</strong><span>${fmtDate(job.createdAt)}${owner}${expired} · ${fmt(job.parseStats?.uniqueDomains)} unique domains${job.status === 'queued' ? ` · ${escapeHtml(job.stage || 'Queued')}` : ''}</span></div>
    <span class="badge ${statusClass}">${escapeHtml(job.status)}</span>
    <div class="recent-actions">${canCancel ? `<button class="danger-text" data-cancel-job="${job.id}">Cancel</button>` : ''}<button data-job="${job.id}">Open</button></div>
  </div>`;
}

async function loadJobs() {
  try {
    const { jobs } = await api('/api/jobs');
    if (!jobs.length) {
      $('recentJobs').innerHTML = '<div class="empty">No jobs yet.</div>';
      return;
    }
    $('recentJobs').innerHTML = jobs.map((job) => recentJobMarkup(job)).join('');
    bindJobButtons($('recentJobs'));
  } catch {
    $('recentJobs').innerHTML = '<div class="empty">Could not load job history.</div>';
  }
}

function bindJobButtons(container) {
  container.querySelectorAll('[data-job]').forEach((btn) => btn.addEventListener('click', () => openJob(btn.dataset.job)));
  container.querySelectorAll('[data-cancel-job]').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await cancelJob(btn.dataset.cancelJob);
    } catch (error) {
      alert(error.message);
      btn.disabled = false;
    }
  }));
}

async function cancelJob(id) {
  if (!id || !confirm('Cancel this scan? Partial results will not be exported.')) return;
  const { job } = await api(`/api/jobs/${id}/cancel`, { method: 'POST' });
  if (state.currentJobId === id) renderJob(job);
  await loadJobs();
  if (state.currentJobId === id) pollJob();
}

async function cancelCurrentJob() {
  if (!state.currentJobId) return;
  try {
    await cancelJob(state.currentJobId);
  } catch (error) {
    alert(error.message);
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
  if (!state.currentJobId || !confirm('Delete this job history and its result files?')) return;
  try {
    await api(`/api/jobs/${state.currentJobId}`, { method: 'DELETE' });
    state.currentJobId = null;
    $('jobSection').hidden = true;
    loadJobs();
    if (state.me?.role === 'admin') loadUsers();
  } catch (error) {
    alert(error.message);
  }
}

async function changePassword(event) {
  event.preventDefault();
  const message = $('passwordMessage');
  message.hidden = true;
  try {
    const data = await api('/api/me/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: $('currentPassword').value,
        newPassword: $('newPassword').value,
        confirmPassword: $('confirmPassword').value
      })
    });
    if (data.loggedOut) {
      alert('Password changed. Sign in again.');
      location.replace('/login');
    }
  } catch (error) {
    message.className = 'form-message bad-text';
    message.textContent = error.message;
    message.hidden = false;
  }
}

async function loadUsers() {
  if (state.me?.role !== 'admin') return;
  try {
    const { users } = await api('/api/admin/users');
    $('usersBody').innerHTML = users.map((u) => `<tr>
      <td><strong>${escapeHtml(u.username)}</strong><div class="subtle small">${escapeHtml(u.id.slice(0, 8))}</div></td>
      <td>${badge(u.role)}</td>
      <td>${badge(u.isActive ? 'active' : 'disabled')}</td>
      <td>${fmt(u.jobCount)}</td>
      <td class="subtle">${escapeHtml(fmtDate(u.lastLoginAt))}</td>
      <td><div class="action-row">
        <button class="mini-btn" data-history-user="${u.id}" data-history-name="${escapeHtml(u.username)}">History</button>
        <button class="mini-btn" data-reset-user="${u.id}">Reset password</button>
        <button class="mini-btn" data-role-user="${u.id}" data-next-role="${u.role === 'admin' ? 'user' : 'admin'}">Make ${u.role === 'admin' ? 'user' : 'admin'}</button>
        <button class="mini-btn ${u.isActive ? 'danger-text' : ''}" data-active-user="${u.id}" data-next-active="${u.isActive ? 'false' : 'true'}">${u.isActive ? 'Disable' : 'Enable'}</button>
      </div></td>
    </tr>`).join('');

    document.querySelectorAll('[data-history-user]').forEach((btn) => btn.addEventListener('click', () => loadAdminHistory(btn.dataset.historyUser, btn.dataset.historyName)));
    document.querySelectorAll('[data-reset-user]').forEach((btn) => btn.addEventListener('click', () => resetUserPassword(btn.dataset.resetUser)));
    document.querySelectorAll('[data-role-user]').forEach((btn) => btn.addEventListener('click', () => patchUser(btn.dataset.roleUser, { role: btn.dataset.nextRole })));
    document.querySelectorAll('[data-active-user]').forEach((btn) => btn.addEventListener('click', () => patchUser(btn.dataset.activeUser, { isActive: btn.dataset.nextActive === 'true' })));
  } catch (error) {
    $('adminMessage').className = 'form-message bad-text';
    $('adminMessage').textContent = error.message;
    $('adminMessage').hidden = false;
  }
}

async function createUser(event) {
  event.preventDefault();
  const message = $('adminMessage');
  message.hidden = true;
  try {
    await api('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('newUsername').value,
        password: $('newUserPassword').value,
        role: $('newUserRole').value
      })
    });
    $('createUserForm').reset();
    message.className = 'form-message good-text';
    message.textContent = 'User created.';
    message.hidden = false;
    loadUsers();
  } catch (error) {
    message.className = 'form-message bad-text';
    message.textContent = error.message;
    message.hidden = false;
  }
}

async function patchUser(id, patch) {
  try {
    await api(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    loadUsers();
  } catch (error) {
    alert(error.message);
  }
}

async function resetUserPassword(id) {
  const password = prompt('Enter a new password (minimum 10 characters). The user will be logged out of existing sessions.');
  if (!password) return;
  try {
    await api(`/api/admin/users/${id}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    alert('Password reset.');
  } catch (error) {
    alert(error.message);
  }
}

async function loadAdminHistory(userId, username) {
  try {
    const { jobs } = await api(`/api/admin/jobs?userId=${encodeURIComponent(userId)}`);
    $('adminHistoryTitle').textContent = `${username} · scan history`;
    $('adminJobs').innerHTML = jobs.length ? jobs.map((job) => recentJobMarkup(job, true)).join('') : '<div class="empty">No jobs for this user.</div>';
    bindJobButtons($('adminJobs'));
    $('adminHistory').hidden = false;
    $('adminHistory').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    alert(error.message);
  }
}

$('scanForm').addEventListener('submit', submitScan);
$('refreshJobs').addEventListener('click', loadJobs);
$('cancelJobBtn').addEventListener('click', cancelCurrentJob);
$('deleteJobBtn').addEventListener('click', deleteCurrentJob);
$('logoutBtn').addEventListener('click', logout);
$('passwordForm').addEventListener('submit', changePassword);
$('createUserForm').addEventListener('submit', createUser);
$('refreshUsers').addEventListener('click', loadUsers);
$('closeAdminHistory').addEventListener('click', () => { $('adminHistory').hidden = true; });

async function init() {
  initTabs();
  initDropzone();
  await loadMe();
  loadHealth();
  loadJobs();
}

init().catch((error) => {
  console.error(error);
  location.replace('/login');
});
