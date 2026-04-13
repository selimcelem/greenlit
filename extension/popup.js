// popup.js — sign-in / profile editor for Greenlit.

// `cfg` is declared in config.js and shared via the popup document's script scope.

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

// ─── Confirm-pane helper ────────────────────────────────────────────────────
// Opens the confirmation pane pre-loaded with the given email. If `password`
// is provided it's stashed so the user can be auto-signed-in after confirm;
// otherwise they're routed back to the signin pane after confirming.

function showConfirmPane(email, password) {
  $('confirm-email-label').textContent = email;
  confirmPane.dataset.email = email;
  if (password) confirmPane.dataset.password = password;
  else delete confirmPane.dataset.password;

  $('confirm-code').value = '';
  $('confirm-err').classList.add('hidden');
  $('confirm-ok').classList.add('hidden');

  signinPane.classList.add('hidden');
  signupPane.classList.add('hidden');
  confirmPane.classList.remove('hidden');
}

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
    if (err.code === 'UserNotConfirmedException') {
      showConfirmPane(email, password);
      return;
    }
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
    showConfirmPane(email, password);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

// "Already have a code?" — jump to confirm pane without re-signing-up.
// Uses whatever the user has typed on the signup form; if the email is
// blank, nudge them to fill it in first.
$('have-code-link').addEventListener('click', () => {
  const email = $('signup-email').value.trim();
  const password = $('signup-password').value;
  const errEl = $('signup-err');
  errEl.classList.add('hidden');

  if (!email) {
    errEl.textContent = 'Enter the email you signed up with, then click again.';
    errEl.classList.remove('hidden');
    return;
  }

  showConfirmPane(email, password || null);
});

$('confirm-btn').addEventListener('click', async () => {
  const code = $('confirm-code').value.trim();
  const errEl = $('confirm-err');
  const okEl = $('confirm-ok');
  errEl.classList.add('hidden');
  okEl.classList.add('hidden');

  if (!code) {
    errEl.textContent = 'Enter the code from your email.';
    errEl.classList.remove('hidden');
    return;
  }

  const email = confirmPane.dataset.email;
  const password = confirmPane.dataset.password;

  try {
    await self.GreenlitAuth.confirmSignUp(email, code);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
    return;
  }

  if (password) {
    try {
      await self.GreenlitAuth.signIn(email, password);
      await route();
      return;
    } catch (err) {
      // Confirmation succeeded but auto-signin failed — fall through to the
      // signin pane so the user can retry manually.
    }
  }

  // No password stashed (or auto-signin failed): route back to signin.
  confirmPane.classList.add('hidden');
  signinPane.classList.remove('hidden');
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === 'signin'));
  $('signin-email').value = email;
  const signinErr = $('signin-err');
  signinErr.textContent = '';
  signinErr.classList.add('hidden');
});

// Resend the confirmation code to whichever email is currently stashed on
// the confirm pane. Uses the `ok` row for feedback so errors from Cognito
// (e.g. "LimitExceededException") surface in the red row.
$('resend-btn').addEventListener('click', async () => {
  const email = confirmPane.dataset.email;
  const errEl = $('confirm-err');
  const okEl = $('confirm-ok');
  errEl.classList.add('hidden');
  okEl.classList.add('hidden');

  if (!email) {
    errEl.textContent = 'No email on file. Go back and enter it on the sign-up tab.';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    await self.GreenlitAuth.resendConfirmationCode(email);
    okEl.textContent = `✓ New code sent to ${email}`;
    okEl.classList.remove('hidden');
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
//
// The popup no longer parses PDFs in the browser — it ships the bytes to
// the `upload` Lambda, which runs pdf-parse server-side, writes the original
// to S3, and persists the extracted text to DynamoDB. The text comes back
// in the response so we can drop it straight into the textarea.

const MAX_PDF_BYTES = 7 * 1024 * 1024; // matches the Lambda's ceiling

$('upload-area').addEventListener('click', () => $('pdf-input').click());

$('pdf-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const uploadText = $('upload-text');
  const uploadArea = $('upload-area');

  uploadText.innerHTML = '⏳ Uploading and parsing PDF…';
  uploadArea.classList.remove('has-file');

  if (file.size > MAX_PDF_BYTES) {
    uploadText.innerHTML = `<strong style="color:#e74c3c">⚠ PDF is larger than ${Math.floor(MAX_PDF_BYTES / 1024 / 1024)} MB.</strong>`;
    return;
  }

  try {
    const buffer = await file.arrayBuffer();
    const contentBase64 = arrayBufferToBase64(buffer);

    const { resumeText, chars } = await callBackend('/resume/upload', {
      method: 'POST',
      body:   JSON.stringify({ filename: file.name, contentBase64 }),
    });

    $('resume-text').value = resumeText;
    uploadArea.classList.add('has-file');
    uploadText.innerHTML = `<span class="success">✓ ${file.name} — ${chars} chars extracted</span>`;
  } catch (err) {
    uploadText.innerHTML = `<strong style="color:#e74c3c">⚠ ${err.message}</strong><br><span style="color:#666">Paste your resume text instead.</span>`;
  }
});

// ArrayBuffer → base64 without blowing the call stack on larger buffers.
// `String.fromCharCode(...bytes)` hits the argument-count limit around 100 KB,
// so we chunk the conversion.
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ─── Boot ───────────────────────────────────────────────────────────────────

route();
