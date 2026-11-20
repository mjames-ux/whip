/**
 * Whip — Step 2: 6:10 AM Daily Parliamentary Briefing Generator
 *
 * Fetches yesterday's House of Commons Hansard contributions and Division votes
 * for all active MPs, generates structured JSON briefings using Gemini, and upserts
 * them into Supabase (`daily_briefings`, `system_status`).
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

const HANSARD_SEARCH_API = 'https://hansard-api.parliament.uk/search.json';
const COMMONS_VOTES_API = 'https://commonsvotes-api.parliament.uk/data/divisions.json/search';
const COMMONS_DIVISION_DETAIL_API = 'https://commonsvotes-api.parliament.uk/data/division';

function cleanEnvValue(val, keyName) {
    if (!val) return '';
    return String(val)
        .replace(new RegExp(`^${keyName}\\s*=\\s*`, 'i'), '')
        .replace(/^['"`\s]+|['"`\s]+$/g, '')
        .trim();
}

const DEFAULT_SUPABASE_URL = 'https://njxnofubcrlshnosaglv.supabase.co';
const envUrl = cleanEnvValue(process.env.SUPABASE_URL, 'SUPABASE_URL');
const supabaseUrl = /^https?:\/\//i.test(envUrl) ? envUrl : DEFAULT_SUPABASE_URL;
const supabaseKey = cleanEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY');
const geminiApiKey = cleanEnvValue(process.env.GEMINI_API_KEY, 'GEMINI_API_KEY');

if (!supabaseKey) {
    console.error('Missing SUPABASE_SERVICE_ROLE_KEY in GitHub Repository Secrets.');
    process.exit(1);
}

if (!geminiApiKey) {
    console.error('Missing GEMINI_API_KEY in GitHub Repository Secrets.');
    process.exit(1);
}

console.log(`Connecting to Supabase at: ${supabaseUrl}`);
const supabase = createClient(supabaseUrl, supabaseKey);
const ai = new GoogleGenAI({ apiKey: geminiApiKey });

function getTargetDateString() {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
}

function formatReadableDate(dateStr) {
    const d = new Date(`${dateStr}T12:00:00Z`);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

async function fetchHansardContributionsByDate(dateStr) {
    const contributionsByMp = new Map();
    let skip = 0;
    const take = 100;

    while (true) {
        const url = new URL(HANSARD_SEARCH_API);
        url.searchParams.set('startDate', dateStr);
        url.searchParams.set('endDate', dateStr);
        url.searchParams.set('house', 'Commons');
        url.searchParams.set('skip', String(skip));
        url.searchParams.set('take', String(take));

        const res = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
        if (!res.ok) {
            console.warn(`Hansard API returned ${res.status} for ${dateStr}`);
            break;
        }

        const data = await res.json();
        const items = data?.Contributions || data?.Results || [];
        if (!Array.isArray(items) || items.length === 0) break;

        for (const item of items) {
            const memberId = item.MemberId || item.AttributedToId;
            if (!memberId) continue;

            if (!contributionsByMp.has(memberId)) {
                contributionsByMp.set(memberId, []);
            }
            contributionsByMp.get(memberId).push({
                debate: item.DebateSection || item.Title || 'House of Commons Business',
                text: (item.ContributionText || item.Value || '').replace(/<[^>]*>/g, '').trim(),
                column: item.ColumnNumber || null
            });
        }

        if (items.length < take) break;
        skip += take;
    }

    return contributionsByMp;
}

async function fetchDivisionVotesByDate(dateStr) {
    const votesByMp = new Map();

    const searchUrl = new URL(COMMONS_VOTES_API);
    searchUrl.searchParams.set('queryParameters.startDate', dateStr);
    searchUrl.searchParams.set('queryParameters.endDate', dateStr);

    const listRes = await fetch(searchUrl.toString(), { headers: { 'Accept': 'application/json' } });
    if (!listRes.ok) {
        console.warn(`Commons Votes API returned ${listRes.status} for ${dateStr}`);
        return { divisionsCount: 0, votesByMp };
    }

    const divisions = await listRes.json();
    if (!Array.isArray(divisions) || divisions.length === 0) {
        return { divisionsCount: 0, votesByMp };
    }

    for (const div of divisions) {
        const divId = div.DivisionId;
        if (!divId) continue;

        const detailRes = await fetch(`${COMMONS_DIVISION_DETAIL_API}/${divId}.json`, {
            headers: { 'Accept': 'application/json' }
        });
        if (!detailRes.ok) continue;

        const detail = await detailRes.json();
        const title = detail.Title || div.Title || `Division #${divId}`;
        const ayeCount = detail.AyeCount ?? (Array.isArray(detail.Ayes) ? detail.Ayes.length : 0);
        const noCount = detail.NoCount ?? (Array.isArray(detail.Noes) ? detail.Noes.length : 0);
        const houseResult = ayeCount > noCount
            ? `Passed (${ayeCount} Ayes to ${noCount} Noes)`
            : `Rejected (${ayeCount} Ayes to ${noCount} Noes)`;

        const recordVote = (memberList, mpVote) => {
            if (!Array.isArray(memberList)) return;
            for (const m of memberList) {
                if (!m.MemberId) continue;
                if (!votesByMp.has(m.MemberId)) votesByMp.set(m.MemberId, []);
                votesByMp.get(m.MemberId).push({
                    title,
                    subtitle: `Division #${divId}`,
                    mpVote,
                    houseResult
                });
            }
        };

        recordVote(detail.Ayes, 'Aye');
        recordVote(detail.AyeTellers, 'Aye');
        recordVote(detail.Noes, 'No');
        recordVote(detail.NoTellers, 'No');
        recordVote(detail.NoVoteRecorded, 'Abstained');
    }

    return { divisionsCount: divisions.length, votesByMp };
}

async function summarizeMpDay(mp, dateStr, speeches, votes) {
    const constituencyLabel = mp.constituencies?.name || mp.role_title || 'their constituency';
    const speechSummary = speeches.length > 0
        ? speeches.slice(0, 8).map((s, idx) => `${idx + 1}. [${s.debate}]: ${s.text.slice(0, 600)}`).join('\n')
        : 'No spoken Hansard contributions recorded.';

    const voteSummary = votes.length > 0
        ? votes.map(v => `- ${v.title}: Voted ${v.mpVote} (${v.houseResult})`).join('\n')
        : 'No Commons division votes recorded.';

    const firstCol = speeches.find(s => s.column)?.column;
    const defaultHansardRef = firstCol
        ? `HC Deb ${formatReadableDate(dateStr)} col ${firstCol}`
        : `HC Deb ${formatReadableDate(dateStr)}`;

    const prompt = `You are a strictly neutral, non-partisan parliamentary reporter writing a daily mobile briefing for a UK constituent.
Summarize what ${mp.full_name} (${mp.party}, ${constituencyLabel}) did in the House of Commons on ${dateStr}.

Return ONLY valid JSON (no markdown fences) matching this exact structure:
{
  "activity_tag": "Short 2-4 word badge e.g. 'Chamber Debate & Votes' or 'Division Votes'",
  "summary_para_1": "2-3 crisp sentences summarizing specifically what the MP said or how they voted yesterday.",
  "summary_para_2": "2-3 neutral sentences explaining the background policy issue or bill to a general reader.",
  "verbatim_excerpt": "One short, accurate direct quote from their speeches below, or null if they did not speak.",
  "glossary": [
    { "term": "Parliamentary or policy term from the text", "plain": "One-sentence plain English definition" }
  ]
}

Rules:
- Never invent facts, bills, or quotes not present in the source data below.
- Keep tone completely impartial and matter-of-fact in British English.
- Include 1 to 3 helpful glossary terms if technical parliamentary terms appear, otherwise [].

Spoken Contributions:
${speechSummary}

Division Votes:
${voteSummary}`;

    const modelsToTry = ['gemini-2.5-flash', 'gemini-3.8-flash'];
    for (const modelName of modelsToTry) {
        try {
            const response = await ai.models.generateContent({
                model: modelName,
                contents: prompt,
                config: { responseMimeType: 'application/json' }
            });
            if (response?.text) {
                const parsed = JSON.parse(response.text.trim());
                return {
                    activity_tag: parsed.activity_tag || (speeches.length > 0 ? 'Chamber Debate' : 'Division Votes'),
                    hansard_ref: defaultHansardRef,
                    summary_para_1: parsed.summary_para_1 || `${mp.short_name} took part in House of Commons business on ${formatReadableDate(dateStr)}.`,
                    summary_para_2: parsed.summary_para_2 || 'Full parliamentary transcripts and division lists are published in the official Hansard record.',
                    verbatim_excerpt: parsed.verbatim_excerpt || null,
                    glossary: Array.isArray(parsed.glossary) ? parsed.glossary : []
                };
            }
        } catch (err) {
            if (modelName === modelsToTry[modelsToTry.length - 1]) {
                throw err;
            }
        }
    }

    return {
        activity_tag: 'Commons Business',
        hansard_ref: defaultHansardRef,
        summary_para_1: `${mp.short_name} had recorded parliamentary activity on ${formatReadableDate(dateStr)}.`,
        summary_para_2: 'Full details of speeches and votes are available in the official House of Commons Hansard.',
        verbatim_excerpt: null,
        glossary: []
    };
}

export async function generateBriefings() {
    const dateStr = getTargetDateString();
    console.log(`[${new Date().toISOString()}] Generating Whip briefings for ${dateStr}...`);

    try {
        // 1. Check if Parliament is dissolved
        const { data: statusRow } = await supabase
            .from('system_status')
            .select('is_parliament_dissolved')
            .eq('id', 1)
            .single();

        if (statusRow?.is_parliament_dissolved) {
            console.log('Dissolution Mode is active — skipping daily briefing generation.');
            return;
        }

        // 2. Load all active MPs from Supabase
        const { data: mps, error: mpFetchError } = await supabase
            .from('mps')
            .select('parliament_member_id, full_name, short_name, party, role_title, constituencies(name)')
            .eq('is_current_member', true);

        if (mpFetchError) {
            throw new Error(`Failed loading active MPs: ${mpFetchError.message}`);
        }

        if (!mps || mps.length === 0) {
            console.warn('No active MPs found in Supabase. Run sync:roster first.');
            return;
        }

        // 3. Fetch yesterday's Hansard speeches and Commons division votes
        const [contributionsByMp, { divisionsCount, votesByMp }] = await Promise.all([
            fetchHansardContributionsByDate(dateStr),
            fetchDivisionVotesByDate(dateStr)
        ]);

        const isSittingDay = contributionsByMp.size > 0 || divisionsCount > 0;
        console.log(`Date ${dateStr}: Sitting day = ${isSittingDay} (${contributionsByMp.size} MPs spoke, ${divisionsCount} divisions).`);

        // 4. Build briefings matching exact `daily_briefings` columns
        const briefingRecords = [];

        for (const mp of mps) {
            const speeches = contributionsByMp.get(mp.parliament_member_id) || [];
            const votes = votesByMp.get(mp.parliament_member_id) || [];
            const hasActivity = speeches.length > 0 || votes.length > 0;

            let generated;
            if (!isSittingDay) {
                generated = {
                    activity_tag: 'Non-Sitting Day',
                    hansard_ref: null,
                    summary_para_1: `The House of Commons did not sit on ${formatReadableDate(dateStr)} (weekend, recess, or non-sitting day), so no Chamber debates or division votes took place.`,
                    summary_para_2: `Outside of Chamber sitting days, ${mp.short_name} focuses on constituency casework, local visits, select committee preparation, and written ministerial correspondence.`,
                    verbatim_excerpt: null,
                    glossary: []
                };
            } else if (!hasActivity) {
                generated = {
                    activity_tag: 'Constituency & Committee Work',
                    hansard_ref: `HC Deb ${formatReadableDate(dateStr)}`,
                    summary_para_1: `${mp.short_name} did not make any spoken interventions in the House of Commons Chamber and recorded no division votes on ${formatReadableDate(dateStr)}.`,
                    summary_para_2: `MPs frequently spend sitting days in select committee hearings, bill committees, ministerial meetings, or constituency engagements away from the main Chamber floor.`,
                    verbatim_excerpt: null,
                    glossary: []
                };
            } else {
                generated = await summarizeMpDay(mp, dateStr, speeches, votes);
                await new Promise(resolve => setTimeout(resolve, 400));
            }

            briefingRecords.push({
                sitting_date: dateStr,
                parliament_member_id: mp.parliament_member_id,
                activity_tag: generated.activity_tag,
                hansard_ref: generated.hansard_ref,
                summary_para_1: generated.summary_para_1,
                summary_para_2: generated.summary_para_2,
                verbatim_excerpt: generated.verbatim_excerpt,
                glossary: generated.glossary,
                votes: votes
            });
        }

        // 5. Upsert all briefings into Supabase in batches of 100
        const BATCH_SIZE = 100;
        for (let i = 0; i < briefingRecords.length; i += BATCH_SIZE) {
            const batch = briefingRecords.slice(i, i + BATCH_SIZE);
            const { error: upsertError } = await supabase
                .from('daily_briefings')
                .upsert(batch, { onConflict: 'sitting_date,parliament_member_id' });

            if (upsertError) {
                throw new Error(`Failed upserting briefings batch ${i}: ${upsertError.message}`);
            }
        }

        // 6. Update last_briefing_sync in system_status
        await supabase
            .from('system_status')
            .upsert({
                id: 1,
                last_briefing_sync: new Date().toISOString()
            });

        console.log(`[${new Date().toISOString()}] Successfully generated and saved ${briefingRecords.length} briefings for ${dateStr}!`);
    } catch (err) {
        console.error('Fatal error during briefing generation:', err);
        process.exit(1);
    }
}

generateBriefings();
