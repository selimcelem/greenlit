// background.js — service worker. Bridges content scripts to the Greenlit backend.

importScripts('config.js', 'auth.js');

const cfg = () => self.GREENLIT_CONFIG;

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'ANALYZE_JOB') {
    analyzeJob(request.jobId, request.jobData)
      .then((result) => sendResponse({ success: true, result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.type === 'GET_AUTH_STATUS') {
    self.GreenlitAuth.isSignedIn()
      .then((authenticated) => sendResponse({ authenticated }))
      .catch(() => sendResponse({ authenticated: false }));
    return true;
  }
});

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
  if (!res.ok) throw new Error(data?.error || `Backend error ${res.status}`);
  return data;
}

async function analyzeJob(jobId, jobData) {
  return callBackend('/analyze', {
    method: 'POST',
    body:   JSON.stringify({ jobId, jobData }),
  });
}
