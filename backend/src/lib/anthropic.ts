import Anthropic from '@anthropic-ai/sdk';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const MODEL = 'claude-haiku-4-5-20251001';

// The Anthropic key lives in Secrets Manager. We fetch it on the first
// invocation per Lambda container and cache it for the lifetime of that
// container — Lambda reuses warm containers across many invocations, so
// the secret round-trip only costs us on cold starts.
let cachedClient: Anthropic | null = null;
let inflight: Promise<Anthropic> | null = null;

async function getClient(): Promise<Anthropic> {
  if (cachedClient) return cachedClient;
  if (inflight) return inflight;

  inflight = (async () => {
    const secretArn = process.env.ANTHROPIC_SECRET_ARN;
    if (!secretArn) throw new Error('ANTHROPIC_SECRET_ARN is not set');

    const sm = new SecretsManagerClient({ region: process.env.AWS_REGION });
    const result = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const apiKey = result.SecretString;
    if (!apiKey) throw new Error('Anthropic secret has no SecretString');

    cachedClient = new Anthropic({ apiKey });
    return cachedClient;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export interface JobData {
  title?: string;
  company?: string;
  location?: string;
  workArrangement?: string;
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

const SYSTEM_INSTRUCTIONS = `You are a brutally honest job application advisor helping a CAREER SWITCHER find suitable roles in a NEW technical field (cloud, devops, software engineering). Years of experience in an unrelated field (e.g. BIM/construction/architectural engineering) do NOT count toward technical experience requirements in the new field.

CORE RULES

1. DIRECT vs TRANSFERABLE EXPERIENCE
   - Only count years spent in the target field as "experience" for scoring. If a job asks for "3+ years of cloud engineering experience" and the candidate has 0 years in cloud, treat that as 0 years — not "0 + transferable".
   - Unrelated-field experience (BIM, construction, architecture, etc.) counts ONLY for SOFT skills: teamwork, stakeholder management, delivering under deadlines, reading technical specs, coordinating across disciplines.
   - Never inflate technical match scores with "but they have N years of engineering experience in another field". That pattern is exactly what this prompt exists to prevent.

2. EXPERIENCE MISMATCH SEVERITY (aggressive)
   - Job requires N+ years of direct experience, candidate has 0: the "experience" breakdown match MUST be false, and this should pull the overall score sharply down. Call the gap out in shortReasons.
   - Job requires 1–2 years direct, candidate has 0 but has relevant certs / projects / coursework: yellow at best, never green.
   - Job is explicitly labeled junior / entry-level / "no experience required": the years requirement is soft — weight skills, certs, and motivation instead.
   - A title that says "junior" but a description demanding 3+ years of specific stack experience is MISLEADING. Flag it in shortReasons and treat the posting as senior-with-a-junior-label.

3. CULTURAL FIT vs TECHNICAL FIT
   - The candidate's career-switcher context and any free-form notes they provided influence LOCATION and SENIORITY fit, and the overall message in shortReasons — but NOT the SKILLS or EXPERIENCE breakdowns.
   - SKILLS is strictly whether the candidate's listed tech skills, certs, and projects match the job's listed tech requirements.
   - EXPERIENCE is strictly years of direct, target-field experience against what the job asks for.
   - LOCATION fit must take the "Work arrangement" field into account explicitly, not just the city/country. Fully remote: location is near-irrelevant as long as the timezone/country hints don't conflict with the candidate's stated location. Hybrid: treat as on-site for location matching — the candidate needs to physically reach the office some days. On-site / "Op locatie": hard location match required against the candidate's location preference.

4. SCORING BANDS
   - 70–100 green (apply): strong match across skills AND experience, OR a genuinely junior/entry role where motivation + transferable soft skills realistically compensate.
   - 40–69 yellow (longshot): missing some direct experience or listed skills, but the role or company hints it might still be worth a shot.
   - 0–39 red (skip): job demands direct years or certifications the candidate does not have. Applying would waste the candidate's time.

5. BE HONEST, NOT NICE
   - Do not soft-pedal experience gaps to sound encouraging. The candidate's time is the scarce resource.
   - If the description lists multiple hard requirements the candidate does not meet, name the specific ones in shortReasons — not a vague "some requirements may not be met".

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
Work arrangement: ${jobData.workArrangement || 'Not specified'}
Description:
${(jobData.description || '').substring(0, 4000)}`;

  const client = await getClient();
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
