// content.js — injects Greenlit badges into LinkedIn job pages.
//
// Scope: we only analyze the *open job detail panel*. Feed-card badges were
// removed to avoid firing one model call per visible card on every scroll —
// that burned tokens fast on a busy feed. Click into a job to get a badge.

let JL_OBSERVER = null;

// Retry state for the obfuscated-DOM inject path. The MutationObserver can
// fire on early DOM ticks before LinkedIn streams the description's
// data-testid="lazy-column" into the right pane. Falling through to the
// append fallback in that window lands the panel inside an overflow:hidden
// ancestor where it's clipped and invisible. We defer instead and retry,
// keyed by jobId so a fresh job starts at zero retries.
const INJECT_RETRY_COUNTS = new Map();
const MAX_INJECT_RETRIES = 5;
const INJECT_RETRY_DELAY_MS = 1000;
// On SPA navigation between jobs we tear down the stale panel and start
// over. LinkedIn doesn't render the new job's content synchronously, so
// the immediate next inject would either find no lazy-column or anchor on
// the previous job's DOM that's mid-replacement. A short deferral lets
// the new content settle before we look at it.
const STALE_PANEL_REMOVAL_DELAY_MS = 200;

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
  // Resolve the right pane first. Every selector below MUST be scoped to
  // this element when we have it — querying the whole document picks up
  // h1s, top-cards and company links from the left-side job list, which
  // would inject the badge into the wrong column and feed left-pane text
  // into the values we send to /analyze.
  const { el: pane, sel: paneSel } = getRightPane();

  // Figure out what job the page is *currently* showing before we decide
  // whether to keep or replace any existing panel. LinkedIn's SPA swaps the
  // detail panel in place when the user clicks a different card, so a guard
  // that just checks "does a panel exist?" would keep showing the stale
  // result forever.
  const jobData = extractDetailJobData(pane);
  // Title is the only hard requirement — without it we can't even key the
  // panel. Empty/short descriptions are fine; the backend prompt has a
  // "limited description" branch that scores best-effort from the title.
  if (!jobData.title) {
    console.log('[Greenlit] bail: no title');
    return;
  }

  const currentJobId = getDetailJobId() || `${location.pathname}:${jobData.title}`;

  const existing = document.querySelector('.jl-detail-panel');
  if (existing) {
    if (existing.dataset.jlJobId === currentJobId) {
      // Same job as the rendered panel — leave it in place. This also
      // prevents the MutationObserver from re-analyzing on every DOM tick.
      console.log(`[Greenlit] bail: panel already exists (jobId=${currentJobId})`);
      return;
    }
    // Different job — throw away the stale panel and reschedule. Doing
    // the inject inline races LinkedIn's SPA render: the old job's lazy-
    // column may still be in the DOM (we'd anchor on it) or the new job's
    // content may not be in yet (we'd fall through to append). A short
    // deferral lets the new content settle.
    existing.remove();
    console.log(`[Greenlit] bail: removed stale panel for different jobId, deferring ${STALE_PANEL_REMOVAL_DELAY_MS}ms before re-inject`);
    setTimeout(injectDetailBadge, STALE_PANEL_REMOVAL_DELAY_MS);
    return;
  }

  // Title element lookup is scoped to the right pane when present so we
  // never anchor on an h1 sitting in the left job-list column. Falls back
  // to document scope only on legacy /jobs/view/N pages where getRightPane
  // returned nothing.
  const root = pane || document;
  const titleEl = root.querySelector([
    '.jobs-unified-top-card__job-title',
    '.job-details-jobs-unified-top-card__job-title',
    'h1.t-24',
    '[class*="job-title"] h1',
    '[class*="topcard__title"]',
    'h1',
  ].join(', '));

  // We need either a titleEl (anchor as a sibling after its top-card
  // wrapper) or the right pane (prepend as first child) to inject anywhere
  // sensible. If neither is available, bail.
  if (!titleEl && !pane) {
    console.log('[Greenlit] bail: no titleEl and no pane');
    return;
  }

  // Defer-and-retry guard. Append-mode injection lands the panel inside
  // pane.firstElementChild, which on obfuscated builds is an
  // overflow:hidden container that clips the badge to invisibility. So
  // any time we'd fall through to append (no titleEl wrapper, no lazy-
  // column anchor) we treat the DOM as "not ready yet" and retry rather
  // than insert into the trap. paneSel doesn't matter — the trap exists
  // regardless of how the pane was identified. Append is reserved as the
  // absolute last resort once retries are exhausted.
  if (!titleEl && pane) {
    const expandable = pane.querySelector('[data-testid="expandable-text-box"]');
    const lazyColumn = expandable?.closest('[data-testid="lazy-column"]');
    if (!lazyColumn) {
      const retries = INJECT_RETRY_COUNTS.get(currentJobId) || 0;
      if (retries < MAX_INJECT_RETRIES) {
        INJECT_RETRY_COUNTS.set(currentJobId, retries + 1);
        console.log(
          `[Greenlit] bail: deferred retry ${retries + 1}/${MAX_INJECT_RETRIES} ` +
          `(no lazy-column anchor yet, will retry in ${INJECT_RETRY_DELAY_MS}ms)`,
        );
        setTimeout(injectDetailBadge, INJECT_RETRY_DELAY_MS);
        return;
      }
      console.log(
        `[Greenlit] inject: max retries (${MAX_INJECT_RETRIES}) reached, ` +
        `falling back to append path (panel may be clipped by overflow:hidden)`,
      );
    }
  }

  // Check the local result cache before deciding what to render. A hit means
  // we've already analyzed this job within the TTL window — render the
  // verdict directly with no /analyze call and no quota hit. The user can
  // still force a fresh run via the Re-analyze button on the rendered panel.
  const cached = await readCachedResult(currentJobId);

  // The cache read is async, so the user may have clicked into a different
  // job (or this very job's panel may have been injected by an earlier tick)
  // while we were waiting. Re-check before mutating the DOM.
  const jobIdNow = getDetailJobId() || `${location.pathname}:${jobData.title}`;
  if (jobIdNow !== currentJobId) {
    console.log(`[Greenlit] bail: job changed during cache read (${currentJobId} → ${jobIdNow})`);
    return;
  }
  if (document.querySelector('.jl-detail-panel')) {
    console.log('[Greenlit] bail: panel already exists (raced with another tick during cache read)');
    return;
  }

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

  // Resolve the inject anchor. Three paths, in order of preference:
  //  - Legacy LinkedIn (titleEl with a class-named top-card wrapper inside
  //    the pane): sibling-after the wrapper, the way the badge has always
  //    sat on stable builds.
  //  - Obfuscated LinkedIn with a description lazy-column: sibling-BEFORE
  //    the lazy-column. This places the panel in the normal document flow
  //    above the description, outside any overflow:hidden ancestor that
  //    would otherwise clip an appended panel.
  //  - Final fallback: append into pane.firstElementChild. Used only when
  //    the lazy-column anchor isn't available.
  let insertTarget;
  let injectMode;  // 'afterend' | 'beforebegin' | 'append'
  if (titleEl) {
    const wrapper =
      titleEl.closest('[class*="top-card"], [class*="unified-top-card"]') ||
      titleEl.parentElement;
    if (wrapper && wrapper !== pane && (!pane || pane.contains(wrapper))) {
      insertTarget = wrapper;
      injectMode = 'afterend';
    }
  }
  if (!insertTarget && pane) {
    const expandable = pane.querySelector('[data-testid="expandable-text-box"]');
    const lazyColumn = expandable?.closest('[data-testid="lazy-column"]');
    if (lazyColumn && lazyColumn !== pane && pane.contains(lazyColumn)) {
      insertTarget = lazyColumn;
      injectMode = 'beforebegin';
    } else {
      insertTarget = pane.firstElementChild || pane;
      injectMode = 'append';
    }
  }
  if (!insertTarget) {
    console.log('[Greenlit] bail: no insertTarget (no titleEl-wrapper inside pane and no pane.firstElementChild)');
    return;
  }

  // Diagnostic — surfaces what we're anchoring on so wrong-column injects
  // can be caught from the console without re-instrumenting the extension.
  console.log(
    `[Greenlit] inject target: ` +
    `inside-rightPane=${pane ? pane.contains(insertTarget) : 'no-pane'}, ` +
    `mode=${injectMode}, ` +
    `text="${(insertTarget.textContent?.trim() || '').slice(0, 100)}", ` +
    `outerHTML="${(insertTarget.outerHTML || '').slice(0, 200)}"`
  );

  if (injectMode === 'append') {
    insertTarget.appendChild(panel);
  } else {
    insertTarget.insertAdjacentElement(injectMode, panel);
  }

  // Anchor resolved and panel injected — drop the retry counter so the
  // Map doesn't accumulate entries across many visited jobs.
  INJECT_RETRY_COUNTS.delete(currentJobId);
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

function extractDetailJobData(pane) {
  // All field selectors are scoped to the resolved right pane. Without this
  // scoping, broad fallbacks like 'h1' or 'a[href*="/company/"]' match the
  // first such element in the document — which on the two-pane list view is
  // a card in the LEFT job list, not the open detail. We fall back to
  // document scope only on legacy single-pane pages.
  const root = pane || document;

  const selectors = {
    title: [
      '.jobs-unified-top-card__job-title',
      '.job-details-jobs-unified-top-card__job-title',
      'h1.t-24',
      '[class*="job-title"] h1',
      'h1',
    ],
    company: [
      '.jobs-unified-top-card__company-name',
      '.job-details-jobs-unified-top-card__company-name',
      '[class*="company-name"] a',
      '[class*="topcard__org"]',
      'a[href*="/company/"]',
    ],
  };

  const get = (keys) => {
    for (const sel of keys) {
      const el = root.querySelector(sel);
      if (el?.textContent?.trim()) {
        console.log(`[Greenlit] detail field: matched "${sel}"`);
        return el.textContent.trim();
      }
    }
    return '';
  };

  // Title fallback chain. On non-obfuscated builds the class/tag selectors
  // hit cleanly. On obfuscated builds we go straight to document.title —
  // LinkedIn sets it to the job title and it's far more reliable than the
  // right-pane text-block extractor, which on this layout tends to grab
  // the entire job list when pane resolution is coarse. The text-block
  // extractor stays as a final fallback for the unusual case where the
  // page <title> is missing or wrong.
  let title = get(selectors.title);
  if (!title) {
    title = extractTitleFromDocumentTitle();
    if (title) console.log(`[Greenlit] title: matched document.title → "${title}"`);
  }
  if (!title) {
    title = extractTitleFromRightPaneTextBlock(pane);
    if (title) console.log(`[Greenlit] title: matched right-pane text block (last resort) → "${title}"`);
  }

  return {
    title,
    company:         get(selectors.company),
    location:        extractLocation(pane, title),
    workArrangement: extractWorkArrangement(pane),
    description:     extractDescription(pane, title).substring(0, 4000),
  };
}

// On obfuscated LinkedIn builds the right pane's first child div is the
// top-card-equivalent block. Its textContent runs together as
// "<title><company><location>..." with no separators we can rely on, so we
// locate the company name (which we can still find via its /company/ link)
// and slice the text before it.
function extractTitleFromRightPaneTextBlock(pane) {
  if (!pane) return '';
  const firstBlock = pane.querySelector(':scope > div');
  const raw = firstBlock?.textContent?.trim();
  if (!raw) return '';

  const companyEl = pane.querySelector('a[href*="/company/"]');
  const companyName = companyEl?.textContent?.trim();
  if (companyName && raw.includes(companyName)) {
    const before = raw.slice(0, raw.indexOf(companyName)).trim();
    // Strip trailing separator chars left behind after slicing ("Title · ").
    const cleaned = before.replace(/[·•|—–\-]+\s*$/, '').trim();
    if (cleaned) return cleaned;
  }

  // Couldn't locate the company within the block — return the first chunk
  // up to a separator or newline. Better to return *something* plausible
  // than to bail and miss the job entirely.
  const firstChunk = raw.split(/[\n·•|]/)[0].trim();
  return firstChunk;
}

// LinkedIn sets <title> to a job-specific string on job pages, e.g.
//   "(3) Senior Engineer - Acme Corp | LinkedIn"
//   "Senior Engineer | Acme Corp | LinkedIn"
// Strip the unread-count prefix and the " | LinkedIn" suffix, then take
// the segment before the first " - " / " | " (the company name follows).
function extractTitleFromDocumentTitle() {
  let t = document.title || '';
  t = t.replace(/^\(\d+\)\s*/, '');
  t = t.replace(/\s*\|\s*LinkedIn\s*$/i, '').trim();
  if (!t) return '';
  const firstChunk = t.split(/\s+(?:-|–|—|\|)\s+/)[0].trim();
  return firstChunk || t;
}

// LinkedIn list view has TWO contexts: a left-side list of job cards (each
// containing a short snippet) and a right-side detail pane with the full
// description. Loose selectors like div[class*="job-description"] will match
// the snippet in a left card and return ~16 chars of garbage. So we first
// resolve the right-side pane, then query inside it only.
function getRightPane() {
  // Class-based selectors first — precise where they exist, but they all
  // return null on machines/locales where LinkedIn ships obfuscated dynamic
  // class names (e.g. "_049efa0e _5c839522"). The structural strategies
  // below cover those cases.
  const candidates = [
    '.jobs-search__job-details',
    '.scaffold-layout__detail',
    '.jobs-search-two-pane__detail',
    'div[data-test-id="job-detail-outlet"]',
    '.job-details-jobs-unified-top-card__container',
    '.jobs-search__job-details--container',
    '.jobs-details',
    '.job-view-layout',
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) {
      console.log(`[Greenlit] right pane: matched "${sel}"`);
      return { el, sel };
    }
  }

  // Heading-based detection: the "About the job" / "Over de vacature"
  // section heading appears only inside the right pane, regardless of
  // class obfuscation or which child of main happens to hold the detail
  // column. This is the most reliable structural signal we have, so it
  // runs before the nth-child fallbacks (which have been observed to pick
  // up the LEFT pane on some LinkedIn versions).
  const byHeading = findPaneByJobHeading();
  if (byHeading) {
    console.log(`[Greenlit] right pane: matched ${byHeading.sel}`);
    return byHeading;
  }

  // Strategy 1: second direct child of <main>. LinkedIn's two-column list
  // view renders [left list, right detail] as direct children of main.
  const mainSecond = document.querySelector('main > :nth-child(2)');
  if (mainSecond) {
    const sel = 'structural:main>:nth-child(2)';
    console.log(`[Greenlit] right pane: matched ${sel} (<${mainSecond.tagName.toLowerCase()}>)`);
    return { el: mainSecond, sel };
  }

  // Strategy 2: smallest ancestor of the page's h1 that also contains a
  // sibling div with >500 chars of text. Class-name independent — anchors
  // on the semantic h1 (job title) and the description body.
  const h1 = document.querySelector('main h1') || document.querySelector('h1');
  if (h1) {
    let el = h1.parentElement;
    while (el && el !== document.body) {
      const divs = el.querySelectorAll('div');
      for (const div of divs) {
        if (div.contains(h1)) continue;
        const text = div.textContent?.trim() || '';
        if (text.length > 500) {
          const sel = 'structural:h1+div>500';
          console.log(`[Greenlit] right pane: matched ${sel} (description div has ${text.length} chars)`);
          return { el, sel };
        }
      }
      el = el.parentElement;
    }
  }

  // Strategy 3: literal main > div:nth-child(2) — narrower than strategy 1
  // (must be a div), kept as final structural fallback.
  const mainDiv = document.querySelector('main > div:nth-child(2)');
  if (mainDiv) {
    const sel = 'structural:main>div:nth-child(2)';
    console.log(`[Greenlit] right pane: matched ${sel}`);
    return { el: mainDiv, sel };
  }

  // Strategy 4: some LinkedIn versions wrap both panes inside a single div
  // child of <main>, so the right pane is at main > div > :nth-child(2)
  // rather than directly under main.
  const wrappedSecond = document.querySelector('main > div > *:nth-child(2)');
  if (wrappedSecond) {
    const sel = 'structural:main>div>:nth-child(2)';
    console.log(`[Greenlit] right pane: matched ${sel} (<${wrappedSecond.tagName.toLowerCase()}>)`);
    return { el: wrappedSecond, sel };
  }

  // Strategy 5: same as strategy 4 but constrained to div, mirrors the
  // strategy-1/strategy-3 pairing.
  const wrappedSecondDiv = document.querySelector('main > div > div:nth-child(2)');
  if (wrappedSecondDiv) {
    const sel = 'structural:main>div>div:nth-child(2)';
    console.log(`[Greenlit] right pane: matched ${sel}`);
    return { el: wrappedSecondDiv, sel };
  }

  // Strategy 6 / 7: nth-child(1) variants. Some LinkedIn versions reverse
  // the column order — the right detail pane comes first, the list second.
  // Only reached after heading detection and nth-child(2) variants have
  // failed, so this is a best-guess fallback.
  const wrappedFirst = document.querySelector('main > div > *:nth-child(1)');
  if (wrappedFirst) {
    const sel = 'structural:main>div>:nth-child(1)';
    console.log(`[Greenlit] right pane: matched ${sel} (<${wrappedFirst.tagName.toLowerCase()}>)`);
    return { el: wrappedFirst, sel };
  }
  const wrappedFirstDiv = document.querySelector('main > div > div:nth-child(1)');
  if (wrappedFirstDiv) {
    const sel = 'structural:main>div>div:nth-child(1)';
    console.log(`[Greenlit] right pane: matched ${sel}`);
    return { el: wrappedFirstDiv, sel };
  }

  // Last resort: smallest ancestor div of .jobs-unified-top-card with >500
  // chars of text. Only useful on non-obfuscated DOMs where the named
  // containers happen to be missing but .jobs-unified-top-card survived.
  const topCard = document.querySelector('.jobs-unified-top-card');
  if (topCard) {
    let el = topCard.parentElement;
    while (el && el !== document.body) {
      if (el.tagName === 'DIV') {
        const text = el.textContent?.trim() || '';
        if (text.length > 500) {
          const sel = 'heuristic:jobs-unified-top-card+text>500';
          console.log(`[Greenlit] right pane: matched ${sel} (${text.length} chars)`);
          return { el, sel };
        }
      }
      el = el.parentElement;
    }
  }

  return { el: null, sel: null };
}

// LinkedIn renders an "About the job" / "Over de vacature" heading inside
// the right detail pane and nowhere else (the left list never carries one).
// Find that heading, then walk up to whichever direct child of <main> (or
// of main's wrapper div) contains it — that's the pane.
function findPaneByJobHeading() {
  const headingPattern = /^(over de vacature|about the job)$/i;

  const tryWithin = (selector) => {
    const children = document.querySelectorAll(selector);
    for (const child of children) {
      const headings = child.querySelectorAll('h1, h2, h3, h4');
      for (const h of headings) {
        if (headingPattern.test(h.textContent?.trim() || '')) {
          return child;
        }
      }
    }
    return null;
  };

  // Try the unwrapped layout first (main > pane), then the wrapped one
  // (main > div > pane). Whichever child contains the heading is the
  // right pane regardless of its sibling position.
  let pane = tryWithin('main > *');
  if (pane) return { el: pane, sel: 'heading:main>* containing job-section' };

  pane = tryWithin('main > div > *');
  if (pane) return { el: pane, sel: 'heading:main>div>* containing job-section' };

  return null;
}

function extractDescription(pane, title) {
  // Caller passes the already-resolved right pane to avoid a second
  // getRightPane() call per cycle. Without a pane we can't safely query
  // anywhere — the description body is too easy to mistake for a left-pane
  // card snippet — so we bail rather than fall back to document scope.
  if (!pane) {
    pane = getRightPane().el;
  }
  if (!pane) {
    console.log('[Greenlit] description: no right pane found (0 chars)');
    return '';
  }

  // First: data-testid="expandable-text-box". This is LinkedIn's stable
  // testid for the description body on obfuscated builds where every
  // class is hashed. Multiple boxes may exist (the description proper,
  // expandable sub-sections) — concatenate all of them so we capture the
  // full text. We can't programmatically click "... meer" to expand a
  // truncated box, but the visible portion is plenty to score against.
  const expandable = pane.querySelectorAll('[data-testid="expandable-text-box"]');
  if (expandable.length) {
    const joined = Array.from(expandable)
      .map((el) => el.textContent?.trim() || '')
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (joined) {
      console.log(`[Greenlit] description: matched [data-testid="expandable-text-box"] x${expandable.length} (${joined.length} chars)`);
      return joined;
    }
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
      console.log(`[Greenlit] description: matched "${sel}" (${text.length} chars)`);
      return text;
    }
    if (text) {
      console.log(`[Greenlit] description: skipped "${sel}" — only ${text.length} chars (likely wrong context)`);
    }
  }

  // Pane-fallback heuristic. Restricted to direct children and one level
  // deep so we never sweep in the entire column on layouts where pane
  // resolution is coarse (the unscoped scan was returning 12000+ chars).
  // Excludes:
  //   - any candidate that DOM-contains the title element (i.e. the top
  //     card and its ancestors). We can't filter by text-includes(title)
  //     because the description body often quotes the title back at the
  //     user — every candidate would match and we'd return nothing.
  //   - the "Personen die u kunt benaderen" / "About the company" /
  //     "Over het bedrijf" / "People you may know" sub-sections that sit
  //     below the actual description
  const exclusionPattern =
    /personen die u kunt benaderen|over het bedrijf|people you may know|about the company/i;

  // Locate the actual title element via a text-node walk. The deepest
  // element wrapping a text node whose value equals the title is the
  // title cell; any candidate that contains it is the top card or one of
  // its ancestors and should be skipped.
  //
  // Common job-title phrases ("DevOps Engineer", "Product Manager") often
  // recur inside the description body too — without a position guard we'd
  // pick up the first occurrence in the description and end up filtering
  // out the actual description div. Restrict the match to the top third
  // of the pane: that's where LinkedIn renders the top card on every
  // layout we've seen, and it's well above where the description starts.
  let titleEl = null;
  if (title) {
    const paneRect = pane.getBoundingClientRect();
    const topThirdCutoff = paneRect.top + paneRect.height / 3;
    const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue?.trim() !== title) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      const top = parent.getBoundingClientRect().top;
      if (top > topThirdCutoff) {
        console.log(`[Greenlit] description: discarded titleEl below top third of pane (top=${Math.round(top)}, cutoff=${Math.round(topThirdCutoff)})`);
        continue;
      }
      titleEl = parent;
      break;
    }
  }

  const candidates = [
    ...pane.querySelectorAll(':scope > div'),
    ...pane.querySelectorAll(':scope > div > div'),
  ];

  for (const div of candidates) {
    const text = div.textContent?.trim() || '';
    if (text.length <= 400) continue;
    if (titleEl && div.contains(titleEl)) {
      console.log(`[Greenlit] description: skipped fallback candidate (${text.length} chars) — contains title element`);
      continue;
    }
    if (exclusionPattern.test(text)) {
      console.log(`[Greenlit] description: skipped fallback candidate (${text.length} chars) — looks like a sub-section`);
      continue;
    }
    console.log(`[Greenlit] description: matched scoped pane-fallback (${text.length} chars)`);
    return text;
  }

  console.log('[Greenlit] description: no selector matched (0 chars)');
  return '';
}

// LinkedIn's top card shows several metadata items as sibling spans: company,
// location (e.g. "Utrecht, Nederland"), posted time, and a work-arrangement
// badge ("Hybride", "Remote", "Op locatie", "Op afstand", "On-site"). The
// selectors that historically hit "location" also grab the badge, so we have
// to filter: we want whichever metadata span looks like a place name, not a
// work-arrangement word.
const WORK_ARRANGEMENT_TERMS = /\b(hybride|hybrid|remote|op\s?afstand|op\s?locatie|on[\s-]?site|in[\s-]?person)\b/i;

function extractLocation(pane, title) {
  // Scope every lookup to the right pane so we never pick up location text
  // from a left-pane job card. Falls back to document scope only on legacy
  // pages where getRightPane() returned null.
  const root = pane || document;

  const topCard = root.querySelector(
    '[class*="top-card"], [class*="unified-top-card"], [class*="job-details-jobs-unified-top-card"]',
  );

  let candidates = [];
  let source = '';
  if (topCard) {
    candidates = Array.from(topCard.querySelectorAll([
      '.jobs-unified-top-card__bullet',
      '.job-details-jobs-unified-top-card__bullet',
      '.job-details-jobs-unified-top-card__primary-description-container .tvm__text',
      '[class*="topcard__flavor--bullet"]',
      '[class*="primary-description"] span',
    ].join(', ')));
    source = 'top-card';
  }

  // Structural fallback for obfuscated DOMs: spans that share a container
  // with the company link. LinkedIn renders company · location · posted ·
  // applicants as bullet-separated siblings of the company anchor.
  if (candidates.length === 0) {
    const companyLink = root.querySelector('a[href*="/company/"]');
    if (companyLink) {
      const wrap = companyLink.closest('div')?.parentElement || companyLink.parentElement;
      if (wrap) {
        candidates = Array.from(wrap.querySelectorAll('span'));
        source = 'structural:companyLink-siblings';
      }
    }
  }

  for (const el of candidates) {
    const text = el.textContent?.trim();
    if (!text) continue;
    // Skip the work-arrangement badge, applicant counts, "Posted X days ago", etc.
    if (WORK_ARRANGEMENT_TERMS.test(text)) continue;
    if (/\b(applicants?|sollicitanten|posted|geplaatst|ago|geleden|hours?|days?|weeks?|uren|dagen|weken)\b/i.test(text)) continue;
    // Rough place-name heuristic: contains a letter, length reasonable.
    if (!/[a-zA-Z]/.test(text)) continue;
    if (text.length > 80) continue;
    console.log(`[Greenlit] location: matched via ${source} → "${text}" (${text.length} chars)`);
    return text;
  }

  // Lazy-column fallback for obfuscated builds. The location lives in the
  // same data-testid="lazy-column" as the description, sandwiched between
  // the company name and the "X dagen geleden" / "gerepost" timestamp.
  // Class-based and span-sibling lookups can't see it on these layouts
  // because the metadata isn't laid out as discrete spans.
  if (pane) {
    const fromLazyColumn = extractLocationFromLazyColumn(pane, title);
    if (fromLazyColumn) {
      console.log(`[Greenlit] location: matched via lazy-column → "${fromLazyColumn}"`);
      return fromLazyColumn;
    }
  }

  console.log('[Greenlit] location: no candidate matched (0 chars)');
  return '';
}

// Pull a "City, Region, Country"-style location out of the lazy-column
// that wraps the description. We truncate at the first time-posted marker
// (geleden / gerepost / ago / posted) so we don't scan into the
// description body, then take the last comma-separated chunk in the
// remaining text — that's the location, since LinkedIn renders the
// metadata as title → company → location → timestamp.
function extractLocationFromLazyColumn(pane, title) {
  const expandable = pane.querySelector('[data-testid="expandable-text-box"]');
  const lazyColumn = expandable?.closest('[data-testid="lazy-column"]');
  if (!lazyColumn) return '';

  let text = (lazyColumn.textContent || '').slice(0, 300);
  const cutoff = text.match(/\b(geleden|gerepost|geplaatst|ago|posted)\b/i);
  if (cutoff) text = text.slice(0, cutoff.index);

  // Match "X, Y" or "X, Y, Z" sequences. \p{L} covers all Unicode letters
  // so "Noord-Holland", "Île-de-France", "España" etc. all match.
  // The \p{L}\s.\-' run is greedy, so without leading text the candidate
  // can absorb the company name + title (e.g.
  // "AcmePrincipal Cloud Engineer Praag, Praag, Tsjechië"). We keep the
  // LAST candidate that's under 50 chars and doesn't contain the title —
  // a real location is short and never has the job title spliced into it.
  const re = /([\p{L}][\p{L}\s.\-']+(?:,\s*[\p{L}][\p{L}\s.\-']+){1,2})/gu;
  const titleText = title?.trim();
  let lastMatch = '';
  let m;
  while ((m = re.exec(text)) !== null) {
    const candidate = m[1].trim();
    if (candidate.length > 50) continue;
    if (WORK_ARRANGEMENT_TERMS.test(candidate)) continue;
    if (titleText && candidate.includes(titleText)) continue;
    lastMatch = candidate;
  }
  return lastMatch;
}

function extractWorkArrangement(pane) {
  // Scoped to the right pane so we never read a work-arrangement badge
  // from a left-pane card. Falls back to document only on legacy pages.
  const root = pane || document;

  // Explicit selectors first — when LinkedIn ships a dedicated class it's
  // the most reliable source.
  const explicit = root.querySelector([
    '.job-details-jobs-unified-top-card__workplace-type',
    '.jobs-unified-top-card__workplace-type',
    '[class*="workplace-type"]',
  ].join(', '));
  if (explicit?.textContent?.trim()) return explicit.textContent.trim();

  // Fallback: scan the top-card text for a known arrangement term. Covers
  // both English ("Hybrid", "Remote", "On-site") and Dutch ("Hybride",
  // "Op afstand", "Op locatie"), which is what the current user sees.
  // On obfuscated builds where there's no class-named top-card, scan the
  // whole pane — work-arrangement terms are distinctive enough that false
  // positives are unlikely.
  const topCard = root.querySelector(
    '[class*="top-card"], [class*="unified-top-card"], [class*="job-details-jobs-unified-top-card"]',
  ) || pane;
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
