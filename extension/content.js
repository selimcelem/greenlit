// content.js — injects Greenlit badges into LinkedIn job pages.
//
// Scope: we only analyze the *open job detail panel*. Feed-card badges were
// removed to avoid firing one model call per visible card on every scroll —
// that burned tokens fast on a busy feed. Click into a job to get a badge.

let JL_OBSERVER = null;

// ─── Bootstrap ──────────────────────────────────────────────────────────────

async function init() {
  const status = await getAuthStatus();
  if (!status.authenticated) {
    console.log('[Greenlit] Not signed in — open the extension popup to sign in.');
    return;
  }
  observePage();
}

function getAuthStatus() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' }, resolve);
  });
}

// ─── Observer — handles LinkedIn SPA navigation ──────────────────────────────

function observePage() {
  injectDetailBadge();

  // LinkedIn is a SPA, so clicking between job cards swaps the detail panel
  // in-place rather than triggering a full page load. The observer re-runs
  // injectDetailBadge() whenever the DOM settles so the badge reappears on
  // the new job.
  if (JL_OBSERVER) JL_OBSERVER.disconnect();
  JL_OBSERVER = new MutationObserver(debounce(injectDetailBadge, 600));
  JL_OBSERVER.observe(document.body, { childList: true, subtree: true });
}

// ─── Job Detail Page ─────────────────────────────────────────────────────────

function injectDetailBadge() {
  // Figure out what job the page is *currently* showing before we decide
  // whether to keep or replace any existing panel. LinkedIn's SPA swaps the
  // detail panel in place when the user clicks a different card, so a guard
  // that just checks "does a panel exist?" would keep showing the stale
  // result forever.
  const jobData = extractDetailJobData();
  if (!jobData.title || !jobData.description) return;

  const currentJobId = getDetailJobId() || `${location.pathname}:${jobData.title}`;

  const existing = document.querySelector('.jl-detail-panel');
  if (existing) {
    if (existing.dataset.jlJobId === currentJobId) {
      // Same job as the rendered panel — leave it in place. This also
      // prevents the MutationObserver from re-analyzing on every DOM tick.
      return;
    }
    // Different job — throw away the stale panel and fall through to inject
    // a fresh one. Any in-flight analyzeJob() holding a reference to the
    // old panel will no-op on replaceWith(), since the node is now detached.
    existing.remove();
  }

  const titleEl = document.querySelector([
    '.jobs-unified-top-card__job-title',
    '.job-details-jobs-unified-top-card__job-title',
    'h1.t-24',
    '[class*="job-title"] h1',
    '[class*="topcard__title"]'
  ].join(', '));

  if (!titleEl) return;

  // Inject an idle panel with an "Analyze" button. We do NOT fire the model
  // call here — only the user clicking the button starts an analysis. This
  // prevents token burn from accidentally opened jobs or passive browsing.
  const panel = createIdlePanel(currentJobId, jobData);
  panel.dataset.jlJobId = currentJobId;
  const insertTarget = titleEl.closest('[class*="top-card"], [class*="unified-top-card"]') || titleEl.parentElement;
  insertTarget.insertAdjacentElement('afterend', panel);
}

function createIdlePanel(jobId, jobData) {
  const panel = document.createElement('div');
  panel.className = 'jl-detail-panel jl-idle-panel';
  panel.innerHTML = `
    <div class="jl-idle-row">
      <button class="jl-primary-btn jl-analyze-btn" type="button">🟢 Analyze with Greenlit</button>
      <span class="jl-idle-hint">Score this job against your profile</span>
    </div>`;
  panel.querySelector('.jl-analyze-btn').addEventListener('click', () => {
    runAnalysis(jobId, jobData, panel, false);
  });
  return panel;
}

// Replaces `hostPanel` with a loading panel and kicks off an analyze call.
// `force=true` tells the backend to skip its cache read so we get a fresh
// verdict; the result overwrites the cached entry on success.
function runAnalysis(jobId, jobData, hostPanel, force) {
  const loading = createDetailPanel(null, 'loading');
  loading.dataset.jlJobId = jobId;
  hostPanel.replaceWith(loading);
  analyzeJob(jobId, jobData, loading, force);
}

function getDetailJobId() {
  const m = location.pathname.match(/\/jobs\/view\/(\d+)/);
  if (m) return m[1];
  const param = new URLSearchParams(location.search).get('currentJobId');
  return param || null;
}

function extractDetailJobData() {
  const selectors = {
    title: [
      '.jobs-unified-top-card__job-title',
      '.job-details-jobs-unified-top-card__job-title',
      'h1.t-24',
      '[class*="job-title"] h1'
    ],
    company: [
      '.jobs-unified-top-card__company-name',
      '.job-details-jobs-unified-top-card__company-name',
      '[class*="company-name"] a',
      '[class*="topcard__org"]'
    ],
    description: [
      '.jobs-description__content',
      '.jobs-description-content__text',
      '[class*="description-content"]',
      '[class*="job-description"]'
    ]
  };

  const get = (keys) => {
    for (const sel of keys) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) return el.textContent.trim();
    }
    return '';
  };

  return {
    title:           get(selectors.title),
    company:         get(selectors.company),
    location:        extractLocation(),
    workArrangement: extractWorkArrangement(),
    description:     get(selectors.description).substring(0, 4000)
  };
}

// LinkedIn's top card shows several metadata items as sibling spans: company,
// location (e.g. "Utrecht, Nederland"), posted time, and a work-arrangement
// badge ("Hybride", "Remote", "Op locatie", "Op afstand", "On-site"). The
// selectors that historically hit "location" also grab the badge, so we have
// to filter: we want whichever metadata span looks like a place name, not a
// work-arrangement word.
const WORK_ARRANGEMENT_TERMS = /\b(hybride|hybrid|remote|op\s?afstand|op\s?locatie|on[\s-]?site|in[\s-]?person)\b/i;

function extractLocation() {
  const topCard = document.querySelector(
    '[class*="top-card"], [class*="unified-top-card"], [class*="job-details-jobs-unified-top-card"]',
  );
  if (!topCard) return '';

  const candidates = topCard.querySelectorAll([
    '.jobs-unified-top-card__bullet',
    '.job-details-jobs-unified-top-card__bullet',
    '.job-details-jobs-unified-top-card__primary-description-container .tvm__text',
    '[class*="topcard__flavor--bullet"]',
    '[class*="primary-description"] span',
  ].join(', '));

  for (const el of candidates) {
    const text = el.textContent?.trim();
    if (!text) continue;
    // Skip the work-arrangement badge, applicant counts, "Posted X days ago", etc.
    if (WORK_ARRANGEMENT_TERMS.test(text)) continue;
    if (/\b(applicants?|sollicitanten|posted|geplaatst|ago|geleden|hours?|days?|weeks?|uren|dagen|weken)\b/i.test(text)) continue;
    // Rough place-name heuristic: contains a letter, no forward slash, length reasonable.
    if (!/[a-zA-Z]/.test(text)) continue;
    if (text.length > 80) continue;
    return text;
  }
  return '';
}

function extractWorkArrangement() {
  // Explicit selectors first — when LinkedIn ships a dedicated class it's
  // the most reliable source.
  const explicit = document.querySelector([
    '.job-details-jobs-unified-top-card__workplace-type',
    '.jobs-unified-top-card__workplace-type',
    '[class*="workplace-type"]',
  ].join(', '));
  if (explicit?.textContent?.trim()) return explicit.textContent.trim();

  // Fallback: scan the top-card text for a known arrangement term. Covers
  // both English ("Hybrid", "Remote", "On-site") and Dutch ("Hybride",
  // "Op afstand", "Op locatie"), which is what the current user sees.
  const topCard = document.querySelector(
    '[class*="top-card"], [class*="unified-top-card"], [class*="job-details-jobs-unified-top-card"]',
  );
  if (!topCard) return '';
  const match = topCard.textContent?.match(WORK_ARRANGEMENT_TERMS);
  return match ? match[0] : '';
}

function createDetailPanel(result, state) {
  const panel = document.createElement('div');
  panel.className = 'jl-detail-panel';

  if (state === 'loading') {
    panel.innerHTML = `
      <div class="jl-loading">
        <div class="jl-spinner"></div>
        <span>Greenlit analyzing…</span>
      </div>`;
    return panel;
  }

  if (state === 'error') {
    panel.innerHTML = `
      <div class="jl-error">⚠ Greenlit: ${result}</div>
      <div class="jl-footer">
        <button class="jl-secondary-btn jl-reanalyze-btn" type="button">↻ Re-analyze</button>
      </div>`;
    return panel;
  }

  const colorClass = `jl-${result.color}`;
  panel.innerHTML = `
    <div class="jl-detail-header ${colorClass}">
      <div class="jl-score-circle ${colorClass}">${result.score}</div>
      <div class="jl-header-text">
        <strong>${result.label}</strong>
        <span>Greenlit Match Score</span>
      </div>
      <button class="jl-expand-btn" aria-expanded="false">Details ▾</button>
    </div>
    <div class="jl-reasons">
      ${result.shortReasons.map(r => `<div class="jl-reason">• ${r}</div>`).join('')}
    </div>
    <div class="jl-breakdown" style="display:none">
      ${renderBreakdown(result.breakdown)}
    </div>
    <div class="jl-footer">
      <button class="jl-secondary-btn jl-reanalyze-btn" type="button">↻ Re-analyze</button>
    </div>`;

  panel.querySelector('.jl-expand-btn').addEventListener('click', (e) => {
    const breakdown = panel.querySelector('.jl-breakdown');
    const btn = e.currentTarget;
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    breakdown.style.display = expanded ? 'none' : 'block';
    btn.setAttribute('aria-expanded', String(!expanded));
    btn.textContent = expanded ? 'Details ▾' : 'Details ▴';
  });

  return panel;
}

function renderBreakdown(b) {
  if (!b) return '';
  const rows = [
    { label: 'Seniority', data: b.seniority },
    { label: 'Skills', data: b.skills },
    { label: 'Location', data: b.location },
    { label: 'Experience', data: b.experience }
  ];
  return rows.map(({ label, data }) => {
    if (!data) return '';
    const match = data.match !== undefined ? data.match : (data.matchPercent >= 60);
    const icon = match ? '✓' : '✗';
    const cls = match ? 'jl-match' : 'jl-nomatch';
    return `
      <div class="jl-breakdown-row">
        <span class="jl-breakdown-icon ${cls}">${icon}</span>
        <div>
          <strong>${label}</strong>
          ${data.matchPercent !== undefined ? `<em>(${data.matchPercent}%)</em>` : ''}
          <p>${data.note || ''}</p>
        </div>
      </div>`;
  }).join('');
}

// ─── Analysis ────────────────────────────────────────────────────────────────

async function analyzeJob(jobId, jobData, panel, force = false) {
  try {
    const result = await callAnalysis(jobId, jobData, force);
    const newPanel = createDetailPanel(result, 'done');
    newPanel.dataset.jlJobId = jobId;
    wireReanalyzeButton(newPanel, jobId, jobData);
    panel.replaceWith(newPanel);
  } catch (err) {
    const errPanel = createDetailPanel(err.message, 'error');
    errPanel.dataset.jlJobId = jobId;
    wireReanalyzeButton(errPanel, jobId, jobData);
    panel.replaceWith(errPanel);
  }
}

// Attach a click handler that swaps the current panel back to a loading
// state and re-runs analysis with force=true, so the backend skips its
// cache read and writes a fresh result over the stale entry.
function wireReanalyzeButton(panel, jobId, jobData) {
  const btn = panel.querySelector('.jl-reanalyze-btn');
  if (!btn) return;
  btn.addEventListener('click', () => runAnalysis(jobId, jobData, panel, true));
}

function callAnalysis(jobId, jobData, force) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'ANALYZE_JOB',
      jobId,
      jobData,
      force,
    }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (response?.success) resolve(response.result);
      else reject(new Error(response?.error || 'Analysis failed'));
    });
  });
}

// ─── Utils ───────────────────────────────────────────────────────────────────

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ─── Start ───────────────────────────────────────────────────────────────────
init();
