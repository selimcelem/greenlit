// background.js — handles all Claude API calls from content script

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'ANALYZE_JOB') {
    analyzeJob(request.jobData, request.resumeText, request.apiKey, request.preferences)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open for async
  }

  if (request.type === 'GET_SETTINGS') {
    chrome.storage.local.get(['resumeText', 'apiKey', 'preferences'], (data) => {
      sendResponse(data);
    });
    return true;
  }
});

async function analyzeJob(jobData, resumeText, apiKey, preferences) {
  const prompt = `You are a brutally honest job application advisor helping a career switcher find suitable roles.

CANDIDATE RESUME:
${resumeText}

WHAT THE CANDIDATE WANTS:
- Target role: ${preferences.targetRole || 'Junior Cloud / IT Engineer'}
- Seniority wanted: ${preferences.seniority || 'Junior or Entry-level'}
- Location: ${preferences.location || 'Netherlands, Remote or Hybrid'}
- Extra context: ${preferences.notes || 'Career switcher from BIM engineering into cloud. Has AWS SAA-C03 cert in progress.'}

JOB POSTING:
Title: ${jobData.title || 'Unknown'}
Company: ${jobData.company || 'Unknown'}
Location: ${jobData.location || 'Unknown'}
Description:
${(jobData.description || '').substring(0, 4000)}

INSTRUCTIONS:
- Be honest. If the job requires 5+ years of cloud experience and the candidate has none, that's a red.
- Consider transferable skills from BIM/construction engineering where relevant.
- If the title says "junior" but the description demands senior experience, flag it as misleading.
- Score 70-100 = green (apply), 40-69 = yellow (longshot but possible), 0-39 = red (skip).

Respond ONLY with a valid JSON object, no markdown, no explanation, exactly this shape:
{
  "score": <number 0-100>,
  "label": "<Strong Match|Possible Match|Poor Match>",
  "color": "<green|yellow|red>",
  "shortReasons": ["<reason1>", "<reason2>", "<reason3>"],
  "breakdown": {
    "seniority": { "match": <true|false>, "note": "<one sentence>" },
    "skills": { "matchPercent": <0-100>, "note": "<one sentence>" },
    "location": { "match": <true|false>, "note": "<one sentence>" },
    "experience": { "match": <true|false>, "note": "<one sentence>" }
  }
}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API error ${response.status}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '';

  try {
    return JSON.parse(text);
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    throw new Error('Could not parse AI response');
  }
}
