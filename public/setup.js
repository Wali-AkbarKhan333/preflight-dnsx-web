const $ = (id) => document.getElementById(id);

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

(async () => {
  try {
    const status = await api('/api/auth/status');
    if (!status.setupRequired) location.replace(status.authenticated ? '/' : '/login');
  } catch {}
})();

$('setupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('setupError');
  error.hidden = true;
  if ($('password').value !== $('confirmPassword').value) {
    error.textContent = 'Passwords do not match.';
    error.hidden = false;
    return;
  }
  $('setupBtn').disabled = true;
  $('setupBtn').textContent = 'Creating…';
  try {
    await api('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('username').value,
        password: $('password').value,
        confirmPassword: $('confirmPassword').value
      })
    });
    location.replace('/');
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
  } finally {
    $('setupBtn').disabled = false;
    $('setupBtn').textContent = 'Create administrator';
  }
});
