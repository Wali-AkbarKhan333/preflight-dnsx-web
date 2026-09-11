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
    if (status.setupRequired) location.replace('/setup');
    else if (status.authenticated) location.replace('/');
  } catch {}
})();

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('loginError');
  error.hidden = true;
  $('loginBtn').disabled = true;
  $('loginBtn').textContent = 'Signing in…';
  try {
    await api('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('username').value, password: $('password').value })
    });
    location.replace('/');
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
  } finally {
    $('loginBtn').disabled = false;
    $('loginBtn').textContent = 'Sign in';
  }
});
