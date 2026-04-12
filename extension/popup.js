// popup.js — sign-in / profile editor for Greenlit.

const cfg = () => self.GREENLIT_CONFIG;

// ─── Element shortcuts ──────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const authView    = $('auth-view');
const profileView = $('profile-view');

const signinPane  = $('signin-pane');
const signupPane  = $('signup-pane');
const confirmPane = $('confirm-pane');

const tabs = document.querySelectorAll('.auth-tab');

// ─── View routing ───────────────────────────────────────────────────────────

async function route() {
  const signedIn = await self.GreenlitAuth.isSignedIn();
  if (signedIn) {
    authView.classList.add('hidden');
    profileView.classList.remove('hidden');
    await loadProfile();
  } else {
    profileView.classList.add('hidden');
    authView.classList.remove('hidden');
  }
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.toggle('active', t === tab));
    const which = tab.dataset.tab;
    signinPane.classList.toggle('hidden', which !== 'signin');
    signupPane.classList.toggle('hidden', which !== 'signup');
    confirmPane.classList.add('hidden');
  });
});

// ─── Sign in ────────────────────────────────────────────────────────────────

$('signin-btn').addEventListener('click', async () => {
  const email = $('signin-email').value.trim();
  const password = $('signin-password').value;
  const errEl = $('signin-err');
  errEl.classList.add('hidden');

  if (!email || !password) {
    errEl.textContent = 'Email and password required.';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    await self.GreenlitAuth.signIn(email, password);
    await route();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

// ─── Sign up ────────────────────────────────────────────────────────────────

$('signup-btn').addEventListener('click', async () => {
  const email = $('signup-email').value.trim();
  const password = $('signup-password').value;
  const errEl = $('signup-err');
  const okEl = $('signup-ok');
  errEl.classList.add('hidden');
  okEl.classList.add('hidden');

  if (!email || !password) {
    errEl.textContent = 'Email and password required.';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    await self.GreenlitAuth.signUp(email, password);
    $('confirm-email-label').textContent = email;
    confirmPane.dataset.email = email;
    confirmPane.dataset.password = password;
    signupPane.classList.add('hidden');
    confirmPane.classList.remove('hidden');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

$('confirm-btn').addEventListener('click', async () => {
  const code = $('confirm-code').value.trim();
  const errEl = $('confirm-err');
  errEl.classList.add('hidden');

  if (!code) {
    errEl.textContent = 'Enter the code from your email.';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    const email = confirmPane.dataset.email;
    const password = confirmPane.dataset.password;
    await self.GreenlitAuth.confirmSignUp(email, code);
    await self.GreenlitAuth.signIn(email, password);
    await route();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

// ─── Profile load / save ────────────────────────────────────────────────────

async function callBackend(path, init = {}) {
  const idToken = await self.GreenlitAuth.getValidIdToken();
  if (!idToken) throw new Error('Session expired. Sign in again.');

  const res = await fetch(`${cfg().apiBaseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${idToken}`,
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Backend ${res.status}`);
  return data;
}

async function loadProfile() {
  const statusBar = $('status-bar');
  const statusText = $('status-text');
  try {
    const profile = await callBackend('/profile', { method: 'GET' });
    $('resume-text').value = profile.resumeText || '';
    const p = profile.preferences || {};
    if (p.targetRole) $('target-role').value = p.targetRole;
    if (p.seniority)  $('seniority').value   = p.seniority;
    if (p.location)   $('location').value    = p.location;
    if (p.notes)      $('notes').value       = p.notes;

    if (profile.resumeText) {
      statusBar.className = 'status-bar ready';
      statusText.textContent = '✓ Ready — Greenlit is active on LinkedIn jobs';
    } else {
      statusBar.className = 'status-bar missing';
      statusText.textContent = 'Add your resume to get started';
    }
  } catch (err) {
    statusBar.className = 'status-bar missing';
    statusText.textContent = err.message;
  }
}

$('save-btn').addEventListener('click', async () => {
  const errEl = $('save-err');
  const okEl = $('save-ok');
  errEl.classList.add('hidden');
  okEl.classList.add('hidden');

  const resumeText = $('resume-text').value.trim();
  if (resumeText.length < 50) {
    errEl.textContent = 'Resume must be at least 50 characters.';
    errEl.classList.remove('hidden');
    return;
  }

  const preferences = {
    targetRole: $('target-role').value.trim(),
    seniority:  $('seniority').value,
    location:   $('location').value.trim(),
    notes:      $('notes').value.trim(),
  };

  try {
    await callBackend('/profile', {
      method: 'PUT',
      body:   JSON.stringify({ resumeText, preferences }),
    });
    okEl.textContent = '✓ Saved — refresh LinkedIn to apply';
    okEl.classList.remove('hidden');
    $('status-bar').className = 'status-bar ready';
    $('status-text').textContent = '✓ Ready — Greenlit is active on LinkedIn jobs';
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

// ─── Sign out ───────────────────────────────────────────────────────────────

$('signout-link').addEventListener('click', async () => {
  await self.GreenlitAuth.signOut();
  $('resume-text').value = '';
  $('target-role').value = '';
  $('location').value = '';
  $('notes').value = '';
  await route();
});

// ─── PDF upload ─────────────────────────────────────────────────────────────

$('upload-area').addEventListener('click', () => $('pdf-input').click());

$('pdf-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const uploadText = $('upload-text');
  const uploadArea = $('upload-area');

  uploadText.innerHTML = '⏳ Extracting text from PDF…';
  uploadArea.classList.remove('has-file');

  try {
    const text = await extractTextFromPDF(file);
    if (text.length < 50) throw new Error('Could not extract enough text. Paste manually.');
    $('resume-text').value = text;
    uploadArea.classList.add('has-file');
    uploadText.innerHTML = `<span class="success">✓ ${file.name} — ${text.length} chars extracted</span>`;

    // Best-effort: also archive the original PDF in S3.
    try {
      const { uploadUrl } = await callBackend('/resume/upload', { method: 'POST' });
      await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body:    file,
      });
    } catch (uploadErr) {
      console.warn('[Greenlit] PDF archive upload failed:', uploadErr);
    }
  } catch (err) {
    uploadText.innerHTML = `<strong style="color:#e74c3c">⚠ ${err.message}</strong><br><span style="color:#666">Paste your resume text instead.</span>`;
  }
});

// ─── PDF parser (same algorithm as the MVP) ────────────────────────────────

async function extractTextFromPDF(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const raw = new TextDecoder('latin1').decode(bytes);

  const parts = [];

  const btEtRegex = /BT([\s\S]*?)ET/g;
  let blockMatch;
  while ((blockMatch = btEtRegex.exec(raw)) !== null) {
    const block = blockMatch[1];

    const tjRegex = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj/g;
    let m;
    while ((m = tjRegex.exec(block)) !== null) {
      parts.push(decodePdfString(m[1]));
    }

    const tjArrRegex = /\[([\s\S]*?)\]\s*TJ/g;
    while ((m = tjArrRegex.exec(block)) !== null) {
      const inner = m[1];
      const strRegex = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
      let sm;
      while ((sm = strRegex.exec(inner)) !== null) {
        parts.push(decodePdfString(sm[1]));
      }
    }
  }

  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let sm;
  while ((sm = streamRegex.exec(raw)) !== null) {
    const s = sm[1];
    if (s.startsWith('%PDF') || s.includes('xref')) continue;
    const printable = s.replace(/[^\x20-\x7E\n]/g, '');
    if (printable.length > 50 && printable.length / s.length > 0.6) {
      parts.push(printable);
    }
  }

  return parts
    .join(' ')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\s{3,}/g, '\n')
    .trim();
}

function decodePdfString(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\\\/g, '\\')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')');
}

// ─── Boot ───────────────────────────────────────────────────────────────────

route();
