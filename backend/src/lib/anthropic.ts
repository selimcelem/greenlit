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
   - When the new role is in a GENUINELY DIFFERENT field from the candidate's background, unrelated-field experience (e.g. BIM/construction years applied against a cloud engineering job) counts ONLY for SOFT skills: teamwork, stakeholder management, delivering under deadlines, reading technical specs, coordinating across disciplines.
   - Never inflate technical match scores with "but they have N years of engineering experience in another field" when the fields are unrelated. That pattern is exactly what this rule exists to prevent.
   - This rule does NOT apply when the new role is in the SAME domain as the candidate's background — e.g. a BIM engineer applying to a BIM Manager / BIM Coordinator role. In that case the domain experience DOES count as direct experience (see Rule 7 on skill equivalency).

2. EXPERIENCE MISMATCH SEVERITY (aggressive)
   - Job requires N+ years of direct experience, candidate has 0: the "experience" breakdown match MUST be false, and this should pull the overall score sharply down. Call the gap out in shortReasons.
   - Job requires 1–2 years direct, candidate has 0 but has relevant certs / projects / coursework: yellow at best, never green.
   - Job is explicitly labeled junior / entry-level / "no experience required": the years requirement is soft — weight skills, certs, and motivation instead.
   - A title that says "junior" but a description demanding 3+ years of specific stack experience is MISLEADING. Flag it in shortReasons and treat the posting as senior-with-a-junior-label.

3. CULTURAL FIT vs TECHNICAL FIT
   - The candidate's career-switcher context and any free-form notes they provided influence LOCATION and SENIORITY fit, and the overall message in shortReasons — but NOT the EXPERIENCE breakdown.
   - SKILLS scores how well the candidate's tech skills, certs, projects, and domain knowledge cover the job's listed requirements. This is NOT a literal string-match — apply the equivalency reasoning in Rule 7 (cloud providers, language families, domain proximity).
   - EXPERIENCE is strictly years of direct, target-field experience against what the job asks for (subject to the same-domain carve-out in Rule 1).
   - LOCATION fit must take the "Work arrangement" field into account explicitly, not just the city/country. Fully remote: location is near-irrelevant as long as the timezone/country hints don't conflict with the candidate's stated location. Hybrid: treat as on-site for location matching — the candidate needs to physically reach the office some days. On-site / "Op locatie": hard location match required against the candidate's location preference.

4. SCORING BANDS
   - 70–100 green (apply): strong match across skills AND experience, OR a genuinely junior/entry role where motivation + transferable soft skills realistically compensate.
   - 40–69 yellow (longshot): missing some direct experience or listed skills, but the role or company hints it might still be worth a shot.
   - 0–39 red (skip): job demands direct years or certifications the candidate does not have. Applying would waste the candidate's time.

5. BE HONEST, NOT NICE
   - Do not soft-pedal experience gaps to sound encouraging. The candidate's time is the scarce resource.
   - If the description lists multiple hard requirements the candidate does not meet, name the specific ones in shortReasons — not a vague "some requirements may not be met".

6. LIMITED OR MISSING DESCRIPTION
   - If the job description is empty, very short, or clearly not the full posting, do NOT score 0 or refuse with "incomplete posting". Make a best-effort assessment from whatever IS available — title, company, location, work arrangement.
   - Infer typical seniority and skill expectations from the title (e.g. "Senior Cloud Engineer" implies multiple years of cloud experience even with no description). Use location + work arrangement for the location breakdown.
   - Include a phrase like "Limited description — assessment based on title only" as one of the shortReasons so the candidate knows confidence is lower. Notes in the breakdown should also reflect the reduced confidence rather than asserting unknown facts.
   - Lower confidence is fine; refusing to score is not.

7. SKILL EQUIVALENCY (applies to the SKILLS breakdown)
   Skills are not a literal keyword match. Reason about transfer across the dimensions below and assign credit accordingly. The skills note must specifically name what transfers and what gaps remain.

   a) Cloud provider transferability
      - The major clouds (AWS, Azure, GCP) share most of their fundamentals: IAM, VPC/networking, serverless (Lambda/Functions/Cloud Functions), object storage, managed databases, IaC (Terraform/CloudFormation/Bicep/Pulumi), CI/CD pipelines, observability, security/compliance patterns. These transfer directly.
      - A candidate strong in AWS applying to an Azure role (or vice versa, or to GCP) should land around 60–70% on SKILLS, not 0%, with a note that calls out the provider gap (service names, portal/CLI quirks, certifications) as the remaining work. Same-provider depth still scores higher.
      - Provider-specific tooling that does NOT transfer (Azure AD/Entra specifics, AWS Organizations/Control Tower specifics, GCP Anthos specifics) should be deducted from the score, not used to zero it.

   b) Programming language proximity
      - Score language match by family and paradigm similarity, not by literal name match. Reference points:
        * C# ↔ Java: ~70% (both statically typed OOP, similar enterprise ecosystems, JVM/CLR patterns map cleanly)
        * Python ↔ JavaScript/TypeScript: ~50% (both dynamic, scripting-friendly, but different runtimes/idioms)
        * C++ ↔ Java/C#: ~30% (shared OOP roots but very different memory model, tooling, idioms)
        * TypeScript ↔ JavaScript: ~90% (essentially the same with a type layer)
        * Go ↔ Rust: ~40% (both modern systems languages but very different ergonomics)
      - 0% on language match should only happen when the candidate has no exposure to anything in the same family or paradigm as the job's primary language.

   c) Domain knowledge transferability
      - When the job is in a domain the candidate already knows deeply, that domain knowledge counts as a real skill — even when the specific tools differ. A BIM engineer applying to a BIM Manager / BIM Coordinator role knows clash detection, federated models, LOD specs, IFC, coordination workflows, stakeholder dynamics. That all transfers.
      - Tool-level transfer inside a domain: Revit experience is directly relevant to roles asking for ILS, Navisworks, Tekla, ArchiCAD, or other BIM/CAD tooling — the conceptual model overlaps even when the buttons don't. Construction/architecture domain knowledge counts for any construction-tech, AEC software, or building-engineering role.
      - Reflect this in the SKILLS percent and note specifically what domain knowledge transfers, plus which specific tool the candidate would still need to pick up.

   d) Floor rule — 0% only when there is genuinely zero overlap
      - Score 0% on SKILLS only when there is NO overlap on any dimension above (no cloud, no language family, no domain). If ANY transferable skill, knowledge, or experience exists, the score must reflect it, and the note must specifically name what transfers and what gaps remain.
      - This rule sets a floor for the SKILLS percent only. It does NOT override Rule 1 — direct years of experience in the target field cannot be conjured from skill equivalency.

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

  const description = (jobData.description || '').substring(0, 4000).trim();
  // Flag short/empty descriptions explicitly so the model takes the
  // "best-effort from title alone" branch in the system prompt rather than
  // hallucinating an "incomplete posting" verdict.
  const descriptionSection = description.length < 200
    ? `Description: (LIMITED — only ${description.length} characters available, full posting not extractable)
${description || '(empty)'}`
    : `Description:
${description}`;

  const userBlock = `JOB POSTING:
Title: ${jobData.title || 'Unknown'}
Company: ${jobData.company || 'Unknown'}
Location: ${jobData.location || 'Unknown'}
Work arrangement: ${jobData.workArrangement || 'Not specified'}
${descriptionSection}`;

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
