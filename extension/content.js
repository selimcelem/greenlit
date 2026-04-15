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

async function injectDetailBadge() {
  // Figure out what job the page is *currently* showing before we decide
  // whether to keep or replace any existing panel. LinkedIn's SPA swaps the
  // detail panel in place when the user clicks a different card, so a guard
  // that just checks "does a panel exist?" would keep showing the stale
  // result forever.
  const jobData = extractDetailJobData();
  // Title is the only hard requirement — without it we can't even key the
  // panel. Empty/short descriptions are fine; the backend prompt has a
  // "limited description" branch that scores best-effort from the title.
  if (!jobData.title) return;

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

  // Check the local result cache before deciding what to render. A hit means
  // we've already analyzed this job within the TTL window — render the
  // verdict directly with no /analyze call and no quota hit. The user can
  // still force a fresh run via the Re-analyze button on the rendered panel.
  const cached = await readCachedResult(currentJobId);

  // The cache read is async, so the user may have clicked into a different
  // job (or this very job's panel may have been injected by an earlier tick)
  // while we were waiting. Re-check before mutating the DOM.
  const jobIdNow = getDetailJobId() || `${location.pathname}:${jobData.title}`;
  if (jobIdNow !== currentJobId) return;
  if (document.querySelector('.jl-detail-panel')) return;

  let panel;
  if (cached) {
    panel = createDetailPanel(cached, 'done');
    wireReanalyzeButton(panel, currentJobId, jobData);
  } else {
    // No cache — inject an idle panel with an "Analyze" button. We do NOT
    // fire the model call here; only the user clicking the button starts an
    // analysis. This prevents token burn from accidentally opened jobs or
    // passive browsing.
    panel = createIdlePanel(currentJobId, jobData);
  }
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
    description:     extractDescription().substring(0, 4000)
  };
}

// LinkedIn list view has TWO contexts: a left-side list of job cards (each
// containing a short snippet) and a right-side detail pane with the full
// description. Loose selectors like div[class*="job-description"] will match
// the snippet in a left card and return ~16 chars of garbage. So we first
// resolve the right-side pane, then query inside it only.
function getRightPane() {
  const candidates = [
    '.jobs-search__job-details',
    '.jobs-search__job-details--container',
    '.jobs-details',
    '.scaffold-layout__detail',
    '.job-view-layout',
    '.job-details-jobs-unified-top-card__container',
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) return { el, sel };
  }
  return { el: null, sel: null };
}

function extractDescription() {
  const { el: pane, sel: paneSel } = getRightPane();
  if (!pane) {
    console.log('[Greenlit] description: no right pane found (0 chars)');
    return '';
  }

  const selectors = [
    '.jobs-description__content',
    '.jobs-description-content__text',
    'article.jobs-description',
    '.jobs-description-content',
    'div[class*="jobs-description"]',
    'div[class*="description-content"]',
    'div[class*="description__text"]',
    'div[class*="job-description"]',
  ];

  for (const sel of selectors) {
    const el = pane.querySelector(sel);
    const text = el?.textContent?.trim();
    if (text && text.length >= 100) {
      console.log(`[Greenlit] description: matched "${sel}" inside "${paneSel}" (${text.length} chars)`);
      return text;
    }
    if (text) {
      console.log(`[Greenlit] description: skipped "${sel}" — only ${text.length} chars (likely wrong context)`);
    }
  }

  // Fallback: scan divs inside the right pane for any block long enough to
  // plausibly be the description body. Scoped to the pane, so we won't pick
  // up left-list snippets.
  const divs = pane.querySelectorAll('div');
  for (const div of divs) {
    const text = div.textContent?.trim() || '';
    if (text.length > 400) {
      console.log(`[Greenlit] description: matched pane-fallback heuristic inside "${paneSel}" (${text.length} chars)`);
      return text;
    }
  }

  console.log(`[Greenlit] description: no selector matched inside "${paneSel}" (0 chars)`);
  return '';
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
    console.log(`[Greenlit] location: matched "${el.className}" → "${text}" (${text.length} chars)`);
    return text;
  }
  console.log('[Greenlit] location: no candidate matched (0 chars)');
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
    writeCachedResult(jobId, result);
    const newPanel = createDetailPanel(result, 'done');
    newPanel.dataset.jlJobId = jobId;
    wireReanalyzeButton(newPanel, jobId, jobData);
    panel.replaceWith(newPanel);
  } catch (err) {
    // Quota-exceeded gets its own panel — a generic error message wouldn't
    // tell the user *why* their click didn't work, and the Re-analyze button
    // on the standard error panel would just burn another 429.
    if (err && err.code === 'quota_exceeded' && err.quota) {
      const quotaPanel = createQuotaPanel(err.quota);
      quotaPanel.dataset.jlJobId = jobId;
      panel.replaceWith(quotaPanel);
      return;
    }
    const errPanel = createDetailPanel(err.message, 'error');
    errPanel.dataset.jlJobId = jobId;
    wireReanalyzeButton(errPanel, jobId, jobData);
    panel.replaceWith(errPanel);
  }
}

// Renders the "you've hit your limit" panel. Distinct from the generic error
// panel because (a) the message needs to name the tier and the reset date,
// (b) it must NOT show a Re-analyze button — clicking it would just hit the
// quota check again and burn another 429, and (c) it surfaces the three
// paid tiers inline so the user can upgrade from exactly where they got
// blocked, rather than digging through the popup.
function createQuotaPanel(quota) {
  const panel = document.createElement('div');
  panel.className = 'jl-detail-panel jl-quota-panel';
  const tierName = formatTierName(quota.tier);
  const resetLine = quota.resetDate
    ? `Resets ${formatResetDate(quota.resetDate)}.`
    : 'Trial does not reset — upgrade for monthly quota.';
  panel.innerHTML = `
    <div class="jl-quota-body">
      <div class="jl-quota-title">⚠ ${tierName} quota reached</div>
      <div class="jl-quota-sub">You've used ${quota.used} of ${quota.limit} analyses. ${resetLine}</div>
    </div>
    <div class="jl-tier-picker">
      ${renderTierOption('starter', 'Starter', 3,  100,  'Good for light use')}
      ${renderTierOption('pro',     'Pro',     6,  300,  'Most job hunters')}
      ${renderTierOption('max',     'Max',     12, 1000, 'Power users')}
    </div>
    <div class="jl-quota-legal">
      EUR, billed monthly. VAT added at checkout. Cancel anytime.
    </div>`;
  panel.querySelectorAll('.jl-tier-btn').forEach((btn) => {
    btn.addEventListener('click', () => startCheckout(btn));
  });
  return panel;
}

function renderTierOption(tier, label, priceEur, analyses, blurb) {
  return `
    <button class="jl-tier-btn" type="button" data-tier="${tier}">
      <div class="jl-tier-name">${label}</div>
      <div class="jl-tier-price">€${priceEur}<span>/mo</span></div>
      <div class="jl-tier-meta">${analyses} analyses</div>
      <div class="jl-tier-blurb">${blurb}</div>
    </button>`;
}

function startCheckout(btn) {
  const tier = btn.dataset.tier;
  if (!tier) return;
  // Disable the whole tier picker while the checkout session is being
  // created — two rapid clicks would otherwise open two Checkout tabs.
  const picker = btn.closest('.jl-quota-panel')?.querySelector('.jl-tier-picker');
  if (picker) {
    picker.querySelectorAll('.jl-tier-btn').forEach((b) => b.setAttribute('disabled', 'true'));
  }
  btn.textContent = 'Opening…';
  chrome.runtime.sendMessage({ type: 'OPEN_CHECKOUT', tier }, (response) => {
    if (!response?.success) {
      btn.textContent = `Failed: ${response?.error || 'unknown error'}`;
      // Re-enable buttons so the user can retry another tier.
      if (picker) {
        picker.querySelectorAll('.jl-tier-btn').forEach((b) => b.removeAttribute('disabled'));
      }
    }
    // On success the new tab opens; we leave the panel in its "Opening…"
    // state. The user is expected to close the tab and reopen the popup
    // per the success page copy, which triggers a fresh /profile fetch.
  });
}

function formatTierName(tier) {
  if (!tier) return 'Trial';
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

function formatResetDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  } catch {
    return iso;
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
      if (response?.success) return resolve(response.result);

      // Quota-exceeded responses carry the structured fields the quota panel
      // needs. Attach them to the rejected Error so the caller can branch on
      // err.code without re-parsing strings.
      const err = new Error(response?.error || 'Analysis failed');
      if (response?.error === 'quota_exceeded') {
        err.code  = 'quota_exceeded';
        err.quota = response.quota;
      }
      reject(err);
    });
  });
}

// ─── Local result cache ──────────────────────────────────────────────────────
// chrome.storage.local persists across browser sessions. We key by jobId so a
// user returning to a previously-analyzed job sees the verdict instantly with
// no /analyze call (and no quota hit). Entries expire after 7 days; expired
// reads are deleted lazily, which is enough cleanup for this volume.

const CACHE_PREFIX = 'gl_cache_';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function cacheKey(jobId) {
  return `${CACHE_PREFIX}${jobId}`;
}

function readCachedResult(jobId) {
  const key = cacheKey(jobId);
  return new Promise(resolve => {
    chrome.storage.local.get(key, (items) => {
      if (chrome.runtime.lastError) return resolve(null);
      const entry = items?.[key];
      if (!entry || !entry.result || !entry.ts) return resolve(null);
      if (Date.now() - entry.ts > CACHE_TTL_MS) {
        chrome.storage.local.remove(key);
        return resolve(null);
      }
      resolve(entry.result);
    });
  });
}

function writeCachedResult(jobId, result) {
  if (!jobId || !result) return;
  chrome.storage.local.set({ [cacheKey(jobId)]: { result, ts: Date.now() } });
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
