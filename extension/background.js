// background.js — service worker. Bridges content scripts to the Greenlit backend.

importScripts('config.js', 'auth.js');

// `cfg` is declared in config.js and shared via the service worker's top-level scope.

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'ANALYZE_JOB') {
    analyzeJob(request.jobId, request.jobData, request.force)
      .then((result) => sendResponse({ success: true, result }))
      .catch((err) => {
        // Quota-exceeded errors carry structured fields (tier, used, limit,
        // resetDate) that the content script needs to render the upgrade
        // panel. Pass them through instead of flattening to a string.
        const payload = { success: false, error: err.message };
        if (err && err.code === 'quota_exceeded') {
          payload.error = 'quota_exceeded';
          payload.quota = err.quota;
        }
        sendResponse(payload);
      });
    return true;
  }

  if (request.type === 'GET_AUTH_STATUS') {
    self.GreenlitAuth.isSignedIn()
      .then((authenticated) => sendResponse({ authenticated }))
      .catch(() => sendResponse({ authenticated: false }));
    return true;
  }

  // Kick off a hosted checkout for a specific tier. We fetch the URL
  // from the backend (which asks the billing provider for a one-time
  // session) and open it in a new tab. The extension's content script
  // can't render a hosted checkout inline and we don't want it to —
  // PCI scope assumes a full-page UX.
  if (request.type === 'OPEN_CHECKOUT') {
    openBillingSession('/billing/checkout-session', { tier: request.tier })
      .then((url) => {
        chrome.tabs.create({ url });
        sendResponse({ success: true });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Open the billing provider's customer portal so the user can update
  // their card, switch plans, or cancel. Same new-tab pattern as checkout.
  if (request.type === 'OPEN_PORTAL') {
    openBillingSession('/billing/portal-session', {})
      .then((url) => {
        chrome.tabs.create({ url });
        sendResponse({ success: true });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function openBillingSession(path, body) {
  const data = await callBackend(path, {
    method: 'POST',
    body:   JSON.stringify(body),
  });
  if (!data?.url) throw new Error('Billing service did not return a URL');
  return data.url;
}

async function callBackend(path, init = {}) {
  const idToken = await self.GreenlitAuth.getValidIdToken();
  if (!idToken) throw new Error('Not signed in. Open the Greenlit popup to sign in.');

  const res = await fetch(`${cfg().apiBaseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${idToken}`,
      ...(init.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));

  // Quota exhaustion is a structured 429. Throw an enriched Error so the
  // service-worker dispatch above can forward `tier`, `used`, `limit`, and
  // `resetDate` to the content script — a plain "Backend error 429" would
  // strand the panel without enough info to render the upgrade prompt.
  if (res.status === 429 && data?.error === 'quota_exceeded') {
    const err = new Error('quota_exceeded');
    err.code  = 'quota_exceeded';
    err.quota = {
      tier:      data.tier,
      used:      data.used,
      limit:     data.limit,
      resetDate: data.resetDate,
    };
    throw err;
  }

  if (!res.ok) throw new Error(data?.error || `Backend error ${res.status}`);
  return data;
}

async function analyzeJob(jobId, jobData, force) {
  return callBackend('/analyze', {
    method: 'POST',
    body:   JSON.stringify({ jobId, jobData, force: !!force }),
  });
}
