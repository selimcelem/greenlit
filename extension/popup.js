// popup.js — sign-in / profile editor for Greenlit.

// `cfg` is declared in config.js and shared via the popup document's script scope.

// ─── Element shortcuts ──────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const authView    = $('auth-view');
const profileView = $('profile-view');

const signinPane  = $('signin-pane');
const signupPane  = $('signup-pane');
const confirmPane = $('confirm-pane');
const forgotPane  = $('forgot-pane');
const resetPane   = $('reset-pane');

const tabs = document.querySelectorAll('.auth-tab');

// ─── Auth-step persistence ──────────────────────────────────────────────────
// The popup unmounts every time it closes, so in-memory pane state is lost.
// To keep mid-flow users on the right screen when they reopen, we persist
// {step, email} under `greenlit_auth_step`. Written on entry to forgot/reset,
// cleared on any path back to sign-in.

const AUTH_STEP_KEY = 'greenlit_auth_step';

async function saveAuthStep(step, email) {
  await chrome.storage.local.set({ [AUTH_STEP_KEY]: { step, email } });
}

async function clearAuthStep() {
  await chrome.storage.local.remove(AUTH_STEP_KEY);
}

async function loadAuthStep() {
  const data = await chrome.storage.local.get(AUTH_STEP_KEY);
  return data[AUTH_STEP_KEY] || null;
}

// ─── View routing ───────────────────────────────────────────────────────────

async function route() {
  const signedIn = await self.GreenlitAuth.isSignedIn();
  if (signedIn) {
    await clearAuthStep();
    authView.classList.add('hidden');
    profileView.classList.remove('hidden');
    await loadProfile();
    return;
  }

  profileView.classList.add('hidden');
  authView.classList.remove('hidden');

  const saved = await loadAuthStep();
  if (saved?.step === 'confirm') {
    // No password on restore — the in-session auto-signin relies on
    // dataset.password, which doesn't survive a popup close. User will
    // land on the signin pane with email prefilled after confirming.
    showConfirmPane(saved.email || '');
  } else if (saved?.step === 'forgot') {
    showForgotPane(saved.email || '');
  } else if (saved?.step === 'reset') {
    showResetPane(saved.email || '');
  }
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.toggle('active', t === tab));
    const which = tab.dataset.tab;
    signinPane.classList.toggle('hidden', which !== 'signin');
    signupPane.classList.toggle('hidden', which !== 'signup');
    confirmPane.classList.add('hidden');
    forgotPane.classList.add('hidden');
    resetPane.classList.add('hidden');
    clearAuthStep();
  });
});

// Route back to the sign-in pane, optionally with a success message prefilled
// (used after a password reset so the user lands with feedback + their email).
// Also clears any stashed auth-step so the popup doesn't bounce the user
// back into forgot/reset on next open.
function backToSignin({ email, successMessage } = {}) {
  clearAuthStep();

  confirmPane.classList.add('hidden');
  forgotPane.classList.add('hidden');
  resetPane.classList.add('hidden');
  signupPane.classList.add('hidden');
  signinPane.classList.remove('hidden');
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === 'signin'));

  const signinErr = $('signin-err');
  const signinOk  = $('signin-ok');
  signinErr.classList.add('hidden');
  signinErr.textContent = '';
  signinOk.classList.add('hidden');
  signinOk.textContent = '';

  if (email) $('signin-email').value = email;
  if (successMessage) {
    signinOk.textContent = successMessage;
    signinOk.classList.remove('hidden');
  }
}

// ─── Forgot / reset pane helpers ────────────────────────────────────────────
// Centralized so both user-initiated clicks and auto-restore-on-open take the
// same path (and persist the same state).

function showForgotPane(email) {
  $('forgot-email').value = email || '';
  $('forgot-err').classList.add('hidden');
  signinPane.classList.add('hidden');
  signupPane.classList.add('hidden');
  confirmPane.classList.add('hidden');
  resetPane.classList.add('hidden');
  forgotPane.classList.remove('hidden');
  saveAuthStep('forgot', email || '');
}

function showResetPane(email) {
  $('reset-email-label').textContent = email || '';
  resetPane.dataset.email = email || '';
  $('reset-code').value = '';
  $('reset-password').value = '';
  $('reset-err').classList.add('hidden');
  signinPane.classList.add('hidden');
  signupPane.classList.add('hidden');
  confirmPane.classList.add('hidden');
  forgotPane.classList.add('hidden');
  resetPane.classList.remove('hidden');
  saveAuthStep('reset', email || '');
}

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
  forgotPane.classList.add('hidden');
  resetPane.classList.add('hidden');
  confirmPane.classList.remove('hidden');

  saveAuthStep('confirm', email || '');
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
  backToSignin({ email });
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

// ─── Forgot password ────────────────────────────────────────────────────────

// "Forgot password?" from the sign-in pane. Prefills whatever email the user
// already typed so they don't have to retype it.
$('forgot-password-link').addEventListener('click', () => {
  showForgotPane($('signin-email').value.trim());
});

$('forgot-cancel-btn').addEventListener('click', () => backToSignin());

$('forgot-btn').addEventListener('click', async () => {
  const email = $('forgot-email').value.trim();
  const errEl = $('forgot-err');
  errEl.classList.add('hidden');

  if (!email) {
    errEl.textContent = 'Enter your email.';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    await self.GreenlitAuth.forgotPassword(email);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
    return;
  }

  showResetPane(email);
});

// "Already have a code?" on the forgot pane — mirrors the signup flow's
// equivalent link. Jumps to the reset pane without requesting a new code,
// which matters when the user already got a code but closed the popup.
$('forgot-have-code-link').addEventListener('click', () => {
  const email = $('forgot-email').value.trim();
  const errEl = $('forgot-err');
  errEl.classList.add('hidden');

  if (!email) {
    errEl.textContent = 'Enter the email you requested the code for, then click again.';
    errEl.classList.remove('hidden');
    return;
  }

  showResetPane(email);
});

$('reset-cancel-btn').addEventListener('click', () => backToSignin());

$('reset-btn').addEventListener('click', async () => {
  const email = resetPane.dataset.email;
  const code = $('reset-code').value.trim();
  const newPassword = $('reset-password').value;
  const errEl = $('reset-err');
  errEl.classList.add('hidden');

  if (!code || !newPassword) {
    errEl.textContent = 'Code and new password required.';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    await self.GreenlitAuth.confirmForgotPassword(email, code, newPassword);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
    return;
  }

  backToSignin({ email, successMessage: '✓ Password reset — sign in with your new password' });
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

    renderUsage(profile.usage);
    renderBilling(profile.billing);

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

// Renders the per-user quota row under the status bar. Trial users see a
// lifetime counter ("X analyses remaining (lifetime)"); paid tiers see a
// monthly counter with the next reset date. The bar gets a warning color
// when remaining drops below 20% of limit, and red when it hits zero.
function renderUsage(usage) {
  const bar     = $('usage-bar');
  const tierEl  = $('usage-tier');
  const countEl = $('usage-counter');
  if (!usage) {
    bar.classList.add('hidden');
    return;
  }

  const remaining = Math.max(0, (usage.limit ?? 0) - (usage.used ?? 0));
  tierEl.textContent = (usage.tier || 'trial').replace(/^./, (c) => c.toUpperCase());

  if (usage.resetDate) {
    countEl.textContent = `${remaining} of ${usage.limit} remaining — resets ${formatResetDate(usage.resetDate)}`;
  } else {
    countEl.textContent = `${remaining} of ${usage.limit} lifetime analyses remaining`;
  }

  bar.classList.remove('hidden', 'usage-low', 'usage-out');
  if (remaining === 0) bar.classList.add('usage-out');
  else if (remaining <= Math.ceil(usage.limit * 0.2)) bar.classList.add('usage-low');
}

function formatResetDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  } catch {
    return iso;
  }
}

// Show the "Manage billing" link only when the user has a Stripe customer
// on file. Trial users (who've never subscribed) don't have one, and the
// Portal session call would fail for them — we surface the upgrade flow
// from the content script's quota panel instead.
function renderBilling(billing) {
  const bar = $('billing-bar');
  if (!billing || !billing.hasCustomer) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
}

$('manage-billing-link').addEventListener('click', () => {
  const link = $('manage-billing-link');
  const original = link.textContent;
  link.textContent = 'Opening…';
  chrome.runtime.sendMessage({ type: 'OPEN_PORTAL' }, (response) => {
    if (!response?.success) {
      link.textContent = `Failed: ${response?.error || 'unknown'}`;
      setTimeout(() => { link.textContent = original; }, 3000);
    } else {
      // Popup closes on outside click when the new tab opens; restore
      // the original text in case it somehow stays visible.
      link.textContent = original;
    }
  });
});

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
