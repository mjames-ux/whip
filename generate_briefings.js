/**
 * Whip — Step 2: 6:10 AM Daily Parliamentary Briefing Generator
 *
 * Fetches yesterday's House of Commons Hansard contributions and Division votes
 * for all active MPs, generates plain-English two-paragraph briefings using Gemini,
 * and upserts them into Supabase.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

const HANSARD_SEARCH_API = 'https://hansard-api.parliament.uk/search.json';
const COMMONS_VOTES_API = 'https://commonsvotes-api.parliament.uk/data/divisions.json/search';
const COMMONS_DIVISION_DETAIL_API = 'https://commonsvotes-api.parliament.uk/data/division';

// Clean any accidental quotes, spaces, or "KEY=" prefixes from GitHub Secrets
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

/**
 * Returns yesterday's date in YYYY-MM-DD format (UTC).
 */
function getTargetDateString() {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
}

/**
 * Fetches all Hansard spoken/written contributions for a given date (YYYY-MM-DD)
 * grouped by Member ID.
 */
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
                time: item.Timecode || null
            });
        }

        if (items.length < take) break;
        skip += take;
    }

    return contributionsByMp;
}

/**
 * Fetches all House of Commons division votes for a given date (YYYY-MM-DD)
 * and maps Aye / No / No Vote Recorded per MP ID.
 */
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

        const recordVote = (memberList, stance) => {
            if (!Array.isArray(memberList)) return;
            for (const m of memberList) {
                if (!m.MemberId) continue;
                if (!votesByMp.has(m.MemberId)) votesByMp.set(m.MemberId, []);
                votesByMp.get(m.MemberId).push({ divisionId: divId, title, stance });
            }
        };

        recordVote(detail.Ayes, 'Aye');
        recordVote(detail.AyeTellers, 'Aye (Teller)');
        recordVote(detail.Noes, 'No');
        recordVote(detail.NoTellers, 'No (Teller)');
        recordVote(detail.NoVoteRecorded, 'Did Not Vote');
    }

    return { divisionsCount: divisions.length, votesByMp };
}

/**
 * Calls Gemini to summarize an active MP's speeches and votes into 2 crisp,
 * impartial paragraphs suitable for constituents.
 */
async function summarizeMpDay(mp, dateStr, speeches, votes) {
    const speechSummary = speeches.length > 0
        ? speeches.slice(0, 8).map((s, idx) => `${idx + 1}. [${s.debate}]: ${s.text.slice(0, 600)}`).join('\n')
        : 'No spoken Hansard contributions recorded.';

    const voteSummary = votes.length > 0
        ? votes.map(v => `- ${v.title}: Voted ${v.stance}`).join('\n')
        : 'No Commons division votes recorded.';

    const prompt = `You are a strictly neutral, non-partisan parliamentary reporter writing a daily mobile briefing for a UK constituent.
Summarize what ${mp.name_display} (${mp.party_name}, MP for ${mp.constituency_name}) did in the House of Commons on ${dateStr}.

Rules:
- Write exactly two short, clear paragraphs in plain British English.
- Paragraph 1: Summarize their spoken interventions, debates, or questions (or note briefly if they did not speak in the Chamber).
- Paragraph 2: Summarize how they voted in Commons divisions (or note if no divisions took place / no vote was recorded).
- Never invent facts, bills, or quotes not present in the source data below. Keep tone completely objective and matter-of-fact.

Spoken Contributions:
${speechSummary}

Division Votes:
${voteSummary}`;

    const modelsToTry = ['gemini-2.5-flash', 'gemini-3.8-flash'];
    for (const modelName of modelsToTry) {
        try {
            const response = await ai.models.generateContent({
                model: modelName,
                contents: prompt
            });
            if (response?.text) {
                return response.text.trim();
            }
        } catch (err) {
            if (modelName === modelsToTry[modelsToTry.length - 1]) {
                throw err;
            }
        }
    }

    return `${mp.name_display} had recorded parliamentary activity on ${dateStr}, but a text summary could not be generated.`;
}

/**
 * Main daily briefing generation pipeline.
 */
export async function generateBriefings() {
    const dateStr = getTargetDateString();
    console.log(`[${new Date().toISOString()}] Generating Whip briefings for ${dateStr}...`);

    try {
        // 1. Check if Parliament is dissolved
        const { data: statusRow } = await supabase
            .from('app_status')
            .select('dissolution_mode')
            .eq('id', 1)
            .single();

        if (statusRow?.dissolution_mode) {
            console.log('Dissolution Mode is active — skipping daily briefing generation.');
            return;
        }

        // 2. Load all active MPs from Supabase
        const { data: mps, error: mpFetchError } = await supabase
            .from('mps')
            .select('id, name_display, party_name, constituency_name')
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

        // 4. Build briefings for every MP
        const briefingRecords = [];

        for (const mp of mps) {
            const speeches = contributionsByMp.get(mp.id) || [];
            const votes = votesByMp.get(mp.id) || [];
            const hasActivity = speeches.length > 0 || votes.length > 0;

            let summaryText;
            if (!isSittingDay) {
                summaryText = `The House of Commons did not sit on ${dateStr} (weekend, recess, or non-sitting day), so no Chamber speeches or division votes took place.\n\nConstituency casework, committee preparation, and ministerial correspondence continue outside the Chamber.`;
            } else if (!hasActivity) {
                summaryText = `${mp.name_display} did not make any spoken contributions in the House of Commons Chamber on ${dateStr}.\n\nNo division votes were recorded for ${mp.name_display} on this date, which commonly reflects constituency duties, select committee work, or paired parliamentary business.`;
            } else {
                summaryText = await summarizeMpDay(mp, dateStr, speeches, votes);
                // Small pause to stay comfortably within Gemini free-tier RPM limits
                await new Promise(resolve => setTimeout(resolve, 400));
            }

            briefingRecords.push({
                mp_id: mp.id,
                briefing_date: dateStr,
                is_sitting_day: isSittingDay,
                speech_count: speeches.length,
                vote_count: votes.length,
                summary_text: summaryText,
                votes_json: votes,
                updated_at: new Date().toISOString()
            });
        }

        // 5. Upsert all briefings into Supabase in batches of 100
        const BATCH_SIZE = 100;
        for (let i = 0; i < briefingRecords.length; i += BATCH_SIZE) {
            const batch = briefingRecords.slice(i, i + BATCH_SIZE);
            const { error: upsertError } = await supabase
                .from('daily_briefings')
                .upsert(batch, { onConflict: 'mp_id,briefing_date' });

            if (upsertError) {
                throw new Error(`Failed upserting briefings batch ${i}: ${upsertError.message}`);
            }
        }

        console.log(`[${new Date().toISOString()}] Successfully generated and saved ${briefingRecords.length} briefings for ${dateStr}!`);
    } catch (err) {
        console.error('Fatal error during briefing generation:', err);
        process.exit(1);
    }
}

generateBriefings();
