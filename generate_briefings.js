/**
 * Whip — Step 2: Fast, Resumable Daily Parliamentary Briefing Generator
 *
 * Fetches yesterday's House of Commons Hansard contributions and Division votes
 * for all active MPs, generates structured JSON briefings using Gemini for speakers,
 * and saves in rolling batches of 25 into Supabase (`daily_briefings`, `system_status`).
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

const HANSARD_SEARCH_API = 'https://hansard-api.parliament.uk/search.json';
const COMMONS_VOTES_API = 'https://commonsvotes-api.parliament.uk/data/divisions.json/search';
const COMMONS_DIVISION_DETAIL_API = 'https://commonsvotes-api.parliament.uk/data/division';

const CONCURRENCY = 6;
const SAVE_BATCH_SIZE = 25;

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

async function fetchWithTimeout(url, timeoutMs = 15000) {
    return fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
    });
}

/**
 * Fetches all Hansard spoken contributions for a given date (YYYY-MM-DD)
 * using Parliament's `queryParameters.*` convention and a strict pagination guard.
 */
async function fetchHansardContributionsByDate(dateStr) {
    const contributionsByMp = new Map();
    let skip = 0;
    const take = 100;
    const MAX_PAGES = 40; // Safety cap (4,000 speeches max per sitting day)

    for (let page = 0; page < MAX_PAGES; page++) {
        const url = new URL(HANSARD_SEARCH_API);
        url.searchParams.set('queryParameters.startDate', dateStr);
        url.searchParams.set('queryParameters.endDate', dateStr);
        url.searchParams.set('queryParameters.house', 'Commons');
        url.searchParams.set('queryParameters.skip', String(skip));
        url.searchParams.set('queryParameters.take', String(take));

        const res = await fetchWithTimeout(url.toString());
        if (!res.ok) {
            console.warn(`Hansard API returned ${res.status} for ${dateStr}`);
            break;
        }

        const data = await res.json();
        const items = data?.Contributions || data?.Results || [];
        const totalResults = data?.TotalContributions ?? data?.TotalResults ?? null;

        if (page === 0) {
            console.log(`Hansard search for ${dateStr}: totalResults=${totalResults ?? 'unknown'}, firstPage=${items.length}`);
        }

        if (!Array.isArray(items) || items.length === 0) break;

        for (const item of items) {
            // Double-check sitting date matches target date
            const itemDate = (item.SittingDate || '').slice(0, 10);
            if (itemDate && itemDate !== dateStr) continue;

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

        skip += items.length;
        if (items.length < take) break;
        if (totalResults !== null && skip >= totalResults) break;
    }

    return contributionsByMp;
}

/**
 * Fetches all House of Commons division votes for a given date (YYYY-MM-DD).
 */
async function fetchDivisionVotesByDate(dateStr) {
    const votesByMp = new Map();

    const searchUrl = new URL(COMMONS_VOTES_API);
    searchUrl.searchParams.set('queryParameters.startDate', dateStr);
    searchUrl.searchParams.set('queryParameters.endDate', dateStr);

    const listRes = await fetchWithTimeout(searchUrl.toString());
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

        const detailRes = await fetchWithTimeout(`${COMMONS_DIVISION_DETAIL_API}/${divId}.json`);
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

async function summarizeMpSpeeches(mp, dateStr, speeches, votes) {
    const constituencyLabel = mp.constituencies?.name || mp.role_title || 'their constituency';
    const speechSummary = speeches
        .slice(0, 8)
        .map((s, idx) => `${idx + 1}. [${s.debate}]: ${s.text.slice(0, 600)}`)
        .join('\n');

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
  "activity_tag": "Short 2-4 word badge e.g. 'Chamber Debate & Votes' or 'Oral Questions'",
  "summary_para_1": "2-3 crisp sentences summarizing specifically what the MP said or asked in the Chamber yesterday.",
  "summary_para_2": "2-3 neutral sentences explaining the background policy issue or bill to a general reader.",
  "verbatim_excerpt": "One short, accurate direct quote from their speeches below, or null.",
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
                    activity_tag: parsed.activity_tag || 'Chamber Debate',
                    hansard_ref: defaultHansardRef,
                    summary_para_1: parsed.summary_para_1 || `${mp.short_name} spoke in House of Commons business on ${formatReadableDate(dateStr)}.`,
                    summary_para_2: parsed.summary_para_2 || 'Full parliamentary transcripts and division lists are published in the official Hansard record.',
                    verbatim_excerpt: parsed.verbatim_excerpt || null,
                    glossary: Array.isArray(parsed.glossary) ? parsed.glossary : []
                };
            }
        } catch (err) {
            if (modelName === modelsToTry[modelsToTry.length - 1]) {
                console.warn(`Gemini fallback for ${mp.short_name}: ${err.message}`);
            }
        }
    }

    return {
        activity_tag: votes.length > 0 ? 'Chamber Debate & Votes' : 'Chamber Debate',
        hansard_ref: defaultHansardRef,
        summary_para_1: `${mp.short_name} contributed to ${speeches[0]?.debate || 'House of Commons proceedings'} on ${formatReadableDate(dateStr)}.`,
        summary_para_2: 'Full details of their spoken remarks and division votes are recorded in the official House of Commons Hansard.',
        verbatim_excerpt: speeches[0]?.text ? speeches[0].text.slice(0, 220) : null,
        glossary: []
    };
}

function buildVoteOnlyBriefing(mp, dateStr, votes) {
    const readableDate = formatReadableDate(dateStr);
    const activeVotes = votes.filter(v => v.mpVote === 'Aye' || v.mpVote === 'No');

    if (activeVotes.length === 0) {
        return {
            activity_tag: 'No Vote Recorded',
            hansard_ref: `HC Deb ${readableDate}`,
            summary_para_1: `${mp.short_name} did not speak in the Chamber and had no vote recorded across ${votes.length} Commons ${votes.length === 1 ? 'division' : 'divisions'} on ${readableDate}.`,
            summary_para_2: `MPs may have no vote recorded when paired with an opposing MP, working on constituency or ministerial duties away from Westminster, or abstaining.`,
            verbatim_excerpt: null,
            glossary: [
                { term: 'Division', plain: 'A formal vote in the House of Commons where MPs walk through the Aye or No lobbies to be counted.' }
            ]
        };
    }

    const voteLines = activeVotes
        .slice(0, 3)
        .map(v => `${v.mpVote} on "${v.title}" (${v.houseResult})`)
        .join('; ');

    return {
        activity_tag: activeVotes.length === 1 ? 'Commons Division Vote' : `${activeVotes.length} Division Votes`,
        hansard_ref: `HC Deb ${readableDate}`,
        summary_para_1: `${mp.short_name} did not make a spoken contribution in the Chamber on ${readableDate}, but voted in ${activeVotes.length} Commons ${activeVotes.length === 1 ? 'division' : 'divisions'}: ${voteLines}.`,
        summary_para_2: `Full division lists and debate transcripts for ${readableDate} are published in the official House of Commons Hansard.`,
        verbatim_excerpt: null,
        glossary: [
            { term: 'Division', plain: 'A formal vote in the House of Commons where MPs walk through the Aye or No lobbies to be counted.' }
        ]
    };
}

async function saveBatch(records) {
    if (records.length === 0) return;
    const { error } = await supabase
        .from('daily_briefings')
        .upsert(records, { onConflict: 'sitting_date,parliament_member_id' });

    if (error) {
        throw new Error(`Failed upserting briefings batch: ${error.message}`);
    }
}

export async function generateBriefings() {
    const dateStr = getTargetDateString();
    const startTime = Date.now();
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

        // 2. Load all active MPs and any already-completed briefings for today
        const [{ data: mps, error: mpFetchError }, { data: existingRows }] = await Promise.all([
            supabase
                .from('mps')
                .select('parliament_member_id, full_name, short_name, party, role_title, constituencies(name)')
                .eq('is_current_member', true),
            supabase
                .from('daily_briefings')
                .select('parliament_member_id')
                .eq('sitting_date', dateStr)
        ]);

        if (mpFetchError) {
            throw new Error(`Failed loading active MPs: ${mpFetchError.message}`);
        }

        if (!mps || mps.length === 0) {
            console.warn('No active MPs found in Supabase. Run sync:roster first.');
            return;
        }

        const completedIds = new Set((existingRows || []).map(r => r.parliament_member_id));
        const pendingMps = mps.filter(mp => !completedIds.has(mp.parliament_member_id));

        console.log(`Total active MPs: ${mps.length}. Already saved for ${dateStr}: ${completedIds.size}. Remaining: ${pendingMps.length}.`);

        if (pendingMps.length === 0) {
            console.log('All MPs already have briefings for this date!');
            return;
        }

        // 3. Fetch yesterday's Hansard speeches and Commons division votes
        console.log('Fetching Hansard speeches and Commons division votes...');
        const [contributionsByMp, { divisionsCount, votesByMp }] = await Promise.all([
            fetchHansardContributionsByDate(dateStr),
            fetchDivisionVotesByDate(dateStr)
        ]);

        const isSittingDay = contributionsByMp.size > 0 || divisionsCount > 0;
        console.log(`Date ${dateStr}: Sitting day = ${isSittingDay} (${contributionsByMp.size} MPs spoke, ${divisionsCount} divisions).`);

        // 4. Process MPs in parallel worker pools & save in rolling batches of 25
        let cursor = 0;
        let savedCount = 0;
        const buffer = [];

        async function worker() {
            while (true) {
                const idx = cursor++;
                if (idx >= pendingMps.length) break;

                const mp = pendingMps[idx];
                const speeches = contributionsByMp.get(mp.parliament_member_id) || [];
                const votes = votesByMp.get(mp.parliament_member_id) || [];

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
                } else if (speeches.length > 0) {
                    generated = await summarizeMpSpeeches(mp, dateStr, speeches, votes);
                } else if (votes.length > 0) {
                    generated = buildVoteOnlyBriefing(mp, dateStr, votes);
                } else {
                    generated = {
                        activity_tag: 'Constituency & Committee Work',
                        hansard_ref: `HC Deb ${formatReadableDate(dateStr)}`,
                        summary_para_1: `${mp.short_name} did not make any spoken interventions in the House of Commons Chamber and recorded no division votes on ${formatReadableDate(dateStr)}.`,
                        summary_para_2: `MPs frequently spend sitting days in select committee hearings, bill committees, ministerial meetings, or constituency engagements away from the main Chamber floor.`,
                        verbatim_excerpt: null,
                        glossary: []
                    };
                }

                buffer.push({
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

                if (buffer.length >= SAVE_BATCH_SIZE) {
                    const batchToSave = buffer.splice(0, SAVE_BATCH_SIZE);
                    await saveBatch(batchToSave);
                    savedCount += batchToSave.length;
                    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
                    console.log(`Saved ${savedCount}/${pendingMps.length} briefings (${elapsedSec}s elapsed)...`);
                }
            }
        }

        await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

        if (buffer.length > 0) {
            await saveBatch(buffer);
            savedCount += buffer.length;
        }

        // 5. Update last_briefing_sync in system_status
        await supabase
            .from('system_status')
            .upsert({
                id: 1,
                last_briefing_sync: new Date().toISOString()
            });

        const totalSec = Math.round((Date.now() - startTime) / 1000);
        console.log(`[${new Date().toISOString()}] Finished! Saved ${savedCount} briefings for ${dateStr} in ${totalSec}s.`);
    } catch (err) {
        console.error('Fatal error during briefing generation:', err);
        process.exit(1);
    }
}

generateBriefings();
