import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const MODEL = 'claude-haiku-4-5-20251001';

export interface JobData {
  title?: string;
  company?: string;
  location?: string;
  description?: string;
}

export interface Preferences {
  targetRole?: string;
  seniority?: string;
  location?: string;
  notes?: string;
}

export interface AnalysisResult {
  score: number;
  label: string;
  color: 'green' | 'yellow' | 'red';
  shortReasons: string[];
  breakdown: {
    seniority: { match: boolean; note: string };
    skills: { matchPercent: number; note: string };
    location: { match: boolean; note: string };
    experience: { match: boolean; note: string };
  };
}

const SYSTEM_INSTRUCTIONS = `You are a brutally honest job application advisor helping a career switcher find suitable roles.

INSTRUCTIONS:
- Be honest. If the job requires 5+ years of cloud experience and the candidate has none, that's a red.
- Consider transferable skills where relevant.
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

export async function scoreJob(
  jobData: JobData,
  resumeText: string,
  preferences: Preferences,
): Promise<AnalysisResult> {
  // The system block holds the resume + preferences. Prompt-cache it so repeated
  // analyses for the same user only pay tokens for the (small) job posting.
  const resumeBlock = `CANDIDATE RESUME:
${resumeText}

WHAT THE CANDIDATE WANTS:
- Target role: ${preferences.targetRole || 'Not specified'}
- Seniority wanted: ${preferences.seniority || 'Not specified'}
- Location: ${preferences.location || 'Not specified'}
- Extra context: ${preferences.notes || 'None'}`;

  const userBlock = `JOB POSTING:
Title: ${jobData.title || 'Unknown'}
Company: ${jobData.company || 'Unknown'}
Location: ${jobData.location || 'Unknown'}
Description:
${(jobData.description || '').substring(0, 4000)}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: [
      { type: 'text', text: SYSTEM_INSTRUCTIONS },
      { type: 'text', text: resumeBlock, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userBlock }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';

  try {
    return JSON.parse(text) as AnalysisResult;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]) as AnalysisResult;
    throw new Error('Could not parse model response');
  }
}
