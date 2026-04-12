// content.js — injects Greenlit badges into LinkedIn job pages

const JL_CACHE = new Map(); // jobId -> analysis result
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
  // Run immediately for current state
  scanPage();

  // Watch for DOM changes (LinkedIn is a SPA)
  if (JL_OBSERVER) JL_OBSERVER.disconnect();
  JL_OBSERVER = new MutationObserver(debounce(scanPage, 600));
  JL_OBSERVER.observe(document.body, { childList: true, subtree: true });
}

function scanPage() {
  injectDetailBadge();
  injectFeedBadges();
}

// ─── Job Detail Page ─────────────────────────────────────────────────────────

function injectDetailBadge() {
  // Don't duplicate
  if (document.querySelector('.jl-detail-panel')) return;

  const titleEl = document.querySelector([
    '.jobs-unified-top-card__job-title',
    '.job-details-jobs-unified-top-card__job-title',
    'h1.t-24',
    '[class*="job-title"] h1',
    '[class*="topcard__title"]'
  ].join(', '));

  if (!titleEl) return;

  const jobData = extractDetailJobData();
  if (!jobData.title || !jobData.description) return;

  const jobId = getDetailJobId() || `${location.pathname}:${jobData.title}`;

  // Create placeholder panel immediately
  const panel = createDetailPanel(null, 'loading');
  const insertTarget = titleEl.closest('[class*="top-card"], [class*="unified-top-card"]') || titleEl.parentElement;
  insertTarget.insertAdjacentElement('afterend', panel);

  // Request analysis
  analyzeJob(jobId, jobData, panel);
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
    location: [
      '.jobs-unified-top-card__bullet',
      '.job-details-jobs-unified-top-card__bullet',
      '[class*="workplace-type"]',
      '[class*="topcard__flavor--bullet"]'
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
    title: get(selectors.title),
    company: get(selectors.company),
    location: get(selectors.location),
    description: get(selectors.description).substring(0, 4000)
  };
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
    panel.innerHTML = `<div class="jl-error">⚠ Greenlit: ${result}</div>`;
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

// ─── Job Feed Cards ──────────────────────────────────────────────────────────

function injectFeedBadges() {
  const cards = document.querySelectorAll([
    'li.jobs-search-results__list-item:not([data-jl-processed])',
    'li.scaffold-layout__list-item:not([data-jl-processed])',
    '[data-job-id]:not([data-jl-processed])'
  ].join(', '));

  cards.forEach(card => {
    card.setAttribute('data-jl-processed', 'true');
    const jobId = getJobId(card);
    if (!jobId) return;

    const jobData = extractCardJobData(card);
    if (!jobData.title) return;

    // Add loading badge immediately
    const badge = createFeedBadge(null, 'loading');
    const insertTarget = card.querySelector('[class*="job-card-list__title"], [class*="job-card-container__link"]')?.parentElement || card.firstElementChild;
    if (insertTarget) insertTarget.insertAdjacentElement('afterbegin', badge);

    // Check cache first
    if (JL_CACHE.has(jobId)) {
      updateFeedBadge(badge, JL_CACHE.get(jobId));
      return;
    }

    analyzeJobForCard(jobData, badge, jobId);
  });
}

function getJobId(element) {
  return element.getAttribute('data-job-id') ||
    element.querySelector('[data-job-id]')?.getAttribute('data-job-id') ||
    element.getAttribute('data-occludable-job-id') ||
    Date.now().toString(); // fallback
}

function extractCardJobData(card) {
  return {
    title: card.querySelector('[class*="job-card-list__title"], [class*="job-card-container__link"]')?.textContent?.trim() || '',
    company: card.querySelector('[class*="company-name"], [class*="subtitle"]')?.textContent?.trim() || '',
    location: card.querySelector('[class*="location"], [class*="metadata-item"]')?.textContent?.trim() || '',
    description: '' // cards don't have full description
  };
}

function createFeedBadge(result, state) {
  const badge = document.createElement('div');
  badge.className = 'jl-feed-badge';

  if (state === 'loading') {
    badge.innerHTML = `<div class="jl-feed-spinner"></div>`;
    return badge;
  }

  if (state === 'error') {
    badge.className += ' jl-feed-error';
    badge.textContent = '?';
    return badge;
  }

  badge.className += ` jl-feed-${result.color}`;
  badge.innerHTML = `<span>${result.score}</span>`;
  badge.title = `${result.label}\n${result.shortReasons.join('\n')}`;
  return badge;
}

function updateFeedBadge(badge, result) {
  badge.className = `jl-feed-badge jl-feed-${result.color}`;
  badge.innerHTML = `<span>${result.score}</span>`;
  badge.title = `${result.label}\n${result.shortReasons?.join('\n') || ''}`;
}

// ─── Analysis ────────────────────────────────────────────────────────────────

async function analyzeJob(jobId, jobData, panel) {
  try {
    const result = await callAnalysis(jobId, jobData);
    const newPanel = createDetailPanel(result, 'done');
    panel.replaceWith(newPanel);
  } catch (err) {
    const errPanel = createDetailPanel(err.message, 'error');
    panel.replaceWith(errPanel);
  }
}

async function analyzeJobForCard(jobData, badge, jobId) {
  try {
    const result = await callAnalysis(jobId, jobData);
    JL_CACHE.set(jobId, result);
    updateFeedBadge(badge, result);
  } catch (err) {
    badge.className = 'jl-feed-badge jl-feed-error';
    badge.textContent = '!';
    badge.title = err.message;
  }
}

function callAnalysis(jobId, jobData) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'ANALYZE_JOB',
      jobId,
      jobData,
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
