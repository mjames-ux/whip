/**
 * Whip — Step 2: Comprehensive Daily Parliamentary Briefing Generator
 *
 * Aggregates yesterday's:
 *   1. House of Commons Chamber, Westminster Hall & Public Bill Committee speeches (Hansard API)
 *   2. Select Committee meetings & MP attendance (Committees API)
 *   3. House of Commons division votes (Commons Votes API)
 *
 * Generates neutral plain-English JSON briefings using Gemini (Paid Tier concurrency)
 * and saves in rolling batches of 25 into Supabase (`daily_briefings`, `system_status`).
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

const HANSARD_SEARCH_API = 'https://hansard-api.parliament.uk/search.json';
const COMMITTEES_EVENTS_API = 'https://committees-api.parliament.uk/api/Events';
const COMMONS_VOTES_API = 'https://commonsvotes-api.parliament.uk/data/divisions.json/search';
const COMMONS_DIVISION_DETAIL_API = 'https://commonsvotes-api.parliament.uk/data/division';

const CONCURRENCY = 8; // Tuned for Gemini Paid Tier 1
const SAVE_BATCH_SIZE = 25;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

if (!supabaseKey || !geminiApiKey) {
    console.error('Missing SUPABASE_SERVICE_ROLE_KEY or GEMINI_API_KEY.');
    process.exit(1);
}

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

function classifyHansardVenue(item) {
    const section = `${item.HansardSection || ''} ${item.DebateSection || ''} ${item.Title || ''}`.toLowerCase();
    if (section.includes('westminster hall')) return 'Westminster Hall';
    if (section.includes('bill committee') || section.includes('public bill')) return 'Bill Committee';
    return 'Commons Chamber';
}

/**
 * 1. Fetches all spoken contributions across Commons Chamber, Westminster Hall,
 *    and Public Bill Committees for the target sitting date.
 */
async function fetchHansardContributionsByDate(dateStr) {
    const contributionsByMp = new Map();
    let skip = 0;
    const take = 100;
    const MAX_PAGES = 50;

    for (let page = 0; page < MAX_PAGES; page++) {
        const url = new URL(HANSARD_SEARCH_API);
        url.searchParams.set('queryParameters.startDate', dateStr);
        url.searchParams.set('queryParameters.endDate', dateStr);
        url.searchParams.set('queryParameters.house', 'Commons');
        url.searchParams.set('queryParameters.skip', String(skip));
        url.searchParams.set('queryParameters.take', String(take));

        const res = await fetchWithTimeout(url.toString());
        if (!res.ok) break;

        const data = await res.json();
        const items = data?.Contributions || data?.Results || [];
        const totalResults = data?.TotalContributions ?? data?.TotalResults ?? null;

        if (!Array.isArray(items) || items.length === 0) break;

        for (const item of items) {
            const itemDate = (item.SittingDate || '').slice(0, 10);
            if (itemDate && itemDate !== dateStr) continue;

            const memberId = item.MemberId || item.AttributedToId;
            if (!memberId) continue;

            if (!contributionsByMp.has(memberId)) {
                contributionsByMp.set(memberId, []);
            }
            contributionsByMp.get(memberId).push({
                venue: classifyHansardVenue(item),
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
 * 2. Fetches Select Committee meetings and MP attendance for the target date
 *    from UK Parliament's Committees API (`committees-api.parliament.uk`).
 */
async function fetchCommitteeAttendanceByDate(dateStr) {
    const committeesByMp = new Map();
    let eventsCount = 0;

    try {
        const url = new URL(COMMITTEES_EVENTS_API);
        url.searchParams.set('StartDateFrom', `${dateStr}T00:00:00Z`);
        url.searchParams.set('StartDateTo', `${dateStr}T23:59:59Z`);
        url.searchParams.set('House', 'Commons');
        url.searchParams.set('Take', '100');

        const res = await fetchWithTimeout(url.toString());
        if (!res.ok) return { eventsCount: 0, committeesByMp };

        const data = await res.json();
        const events = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);

        for (const ev of events) {
            const evStart = (ev.startDate || ev.StartDate || '').slice(0, 10);
            if (evStart && evStart !== dateStr) continue;
            if (ev.isCancelled || ev.IsCancelled) continue;

            const eventId = ev.id || ev.Id;
            if (!eventId) continue;
            eventsCount++;

            const committeeNames = Array.isArray(ev.committees)
                ? ev.committees.map(c => c.name || c.Name).filter(Boolean).join(' & ')
                : (ev.committeeName || 'Parliamentary Select Committee');

            const eventTitle = ev.name || ev.Name || ev.eventType?.name || 'Committee Meeting';
            const activities = Array.isArray(ev.activities)
                ? ev.activities.map(a => a.name || a.Name || a.inquiryTitle).filter(Boolean).join('; ')
                : '';

            const attRes = await fetchWithTimeout(`${COMMITTEES_EVENTS_API}/${eventId}/Attendance`);
            if (!attRes.ok) continue;

            const attData = await attRes.json();
            const attendees = Array.isArray(attData?.items) ? attData.items : (Array.isArray(attData) ? attData : []);

            for (const att of attendees) {
                const memberId = att.memberId || att.MemberId || att.member?.id || att.Member?.Id;
                if (!memberId) continue;

                if (!committeesByMp.has(memberId)) {
                    committeesByMp.set(memberId, []);
                }
                committeesByMp.get(memberId).push({
                    committee: committeeNames,
                    title: eventTitle,
                    topic: activities || eventTitle
                });
            }
        }
    } catch (err) {
        console.warn(`Committees API warning for ${dateStr}: ${err.message}`);
    }

    return { eventsCount, committeesByMp };
}

/**
 * 3. Fetches House of Commons division votes for the target date.
 */
async function fetchDivisionVotesByDate(dateStr) {
    const votesByMp = new Map();

    const searchUrl = new URL(COMMONS_VOTES_API);
    searchUrl.searchParams.set('queryParameters.startDate', dateStr);
    searchUrl.searchParams.set('queryParameters.endDate', dateStr);

    const listRes = await fetchWithTimeout(searchUrl.toString());
    if (!listRes.ok) return { divisionsCount: 0, votesByMp };

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

async function summarizeMpActivity(mp, dateStr, speeches, committees, votes) {
    const constituencyLabel = mp.constituencies?.name || mp.role_title || 'their constituency';
    const venues = [...new Set(speeches.map(s => s.venue))];

    const speechSummary = speeches.length > 0
        ? speeches
            .slice(0, 8)
            .map((s, idx) => `${idx + 1}. [${s.venue} — ${s.debate}]: ${s.text.slice(0, 600)}`)
            .join('\n')
        : 'No spoken Hansard remarks recorded.';

    const committeeSummary = committees.length > 0
        ? committees
            .map((c, idx) => `${idx + 1}. ${c.committee}: ${c.title}${c.topic && c.topic !== c.title ? ` (${c.topic})` : ''}`)
            .join('\n')
        : 'No Select Committee attendance recorded.';

    const voteSummary = votes.length > 0
        ? votes.map(v => `- ${v.title}: Voted ${v.mpVote} (${v.houseResult})`).join('\n')
        : 'No Commons division votes recorded.';

    const firstCol = speeches.find(s => s.column)?.column;
    const defaultHansardRef = speeches.length > 0
        ? (firstCol ? `HC Deb ${formatReadableDate(dateStr)} col ${firstCol}` : `HC Deb ${formatReadableDate(dateStr)}`)
        : `Committees ${formatReadableDate(dateStr)}`;

    const prompt = `You are a strictly neutral, non-partisan parliamentary reporter writing a daily mobile briefing for a UK constituent.
Summarize what ${mp.full_name} (${mp.party}, ${constituencyLabel}) did in Parliament on ${dateStr} across the House of Commons Chamber, Westminster Hall, Public Bill Committees, and Select Committees.

Return ONLY valid JSON (no markdown fences) matching this exact structure:
{
  "activity_tag": "Short 2-4 word badge e.g. 'Chamber Debate & Votes', 'Westminster Hall Debate', 'Bill Committee Scrutiny', or 'Select Committee'",
  "summary_para_1": "2-3 crisp sentences summarizing specifically what the MP said, scrutinized, or which committee session they attended yesterday.",
  "summary_para_2": "2-3 neutral sentences explaining the background policy issue, bill, or committee inquiry to a general reader.",
  "verbatim_excerpt": "One short, accurate direct quote from their spoken contributions below, or null if only committee attendance/votes are listed.",
  "glossary": [
    { "term": "Parliamentary or policy term from the text", "plain": "One-sentence plain English definition" }
  ]
}

Rules:
- Never invent facts, bills, witnesses, or quotes not present in the source data below.
- Clearly distinguish whether remarks took place in the main Commons Chamber, Westminster Hall, a Public Bill Committee, or a Select Committee.
- Keep tone completely impartial and matter-of-fact in British English.
- Include 1 to 3 helpful glossary terms if parliamentary terms (such as Westminster Hall, Public Bill Committee, Select Committee, or Statutory Instrument) appear, otherwise [].

Spoken Contributions (Chamber, Westminster Hall & Bill Committees):
${speechSummary}

Select Committee Meetings Attended:
${committeeSummary}

Division Votes:
${voteSummary}`;

    const modelsToTry = ['gemini-2.5-flash', 'gemini-3.8-flash'];

    for (let attempt = 1; attempt <= 3; attempt++) {
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
                        activity_tag: parsed.activity_tag || (venues[0] ? `${venues[0]} Business` : 'Select Committee'),
                        hansard_ref: defaultHansardRef,
                        summary_para_1: parsed.summary_para_1 || `${mp.short_name} participated in parliamentary business on ${formatReadableDate(dateStr)}.`,
                        summary_para_2: parsed.summary_para_2 || 'Full parliamentary transcripts, committee records, and division lists are published on parliament.uk.',
                        verbatim_excerpt: parsed.verbatim_excerpt || null,
                        glossary: Array.isArray(parsed.glossary) ? parsed.glossary : []
                    };
                }
            } catch (err) {
                const isTransient = String(err.message).includes('429') || String(err.message).includes('503');
                if (isTransient && attempt < 3) {
                    await sleep(4000 * attempt);
                } else if (attempt === 3 && modelName === modelsToTry[modelsToTry.length - 1]) {
                    console.warn(`Gemini fallback for ${mp.short_name}: ${err.message}`);
                }
            }
        }
    }

    if (speeches.length > 0) {
        return {
            activity_tag: venues[0] === 'Westminster Hall'
                ? 'Westminster Hall Debate'
                : (venues[0] === 'Bill Committee' ? 'Bill Committee Scrutiny' : 'Chamber Debate'),
            hansard_ref: defaultHansardRef,
            summary_para_1: `${mp.short_name} contributed to ${speeches[0].debate} (${speeches[0].venue}) on ${formatReadableDate(dateStr)}.`,
            summary_para_2: 'Full details of their spoken remarks and division votes are recorded in the official House of Commons Hansard.',
            verbatim_excerpt: speeches[0].text ? speeches[0].text.slice(0, 220) : null,
            glossary: []
        };
    }

    const firstComm = committees[0];
    return {
        activity_tag: 'Select Committee',
        hansard_ref: defaultHansardRef,
        summary_para_1: `${mp.short_name} attended a meeting of the ${firstComm.committee} (${firstComm.title}) on ${formatReadableDate(dateStr)}.`,
        summary_para_2: 'Select Committees examine government spending, policies, and administration in detail, taking oral and written evidence from ministers and outside experts.',
        verbatim_excerpt: null,
        glossary: [
            { term: 'Select Committee', plain: 'A cross-party group of MPs that scrutinizes the work, spending, and policies of a specific government department.' }
        ]
    };
}

function buildVoteOnlyBriefing(mp, dateStr, votes) {
    const readableDate = formatReadableDate(dateStr);
    const activeVotes = votes.filter(v => v.mpVote === 'Aye' || v.mpVote === 'No');

    if (activeVotes.length === 0) {
        return {
            activity_tag: 'No Vote Recorded',
            hansard_ref: `HC Deb ${readableDate}`,
            summary_para_1: `${mp.short_name} had no recorded spoken remarks or committee attendance and had no vote recorded across ${votes.length} Commons ${votes.length === 1 ? 'division' : 'divisions'} on ${readableDate}.`,
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
        summary_para_1: `${mp.short_name} did not speak in the Chamber or Westminster Hall on ${readableDate}, but voted in ${activeVotes.length} Commons ${activeVotes.length === 1 ? 'division' : 'divisions'}: ${voteLines}.`,
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
        const { data: statusRow } = await supabase
            .from('system_status')
            .select('is_parliament_dissolved')
            .eq('id', 1)
            .single();

        if (statusRow?.is_parliament_dissolved) {
            console.log('Dissolution Mode is active — skipping daily briefing generation.');
            return;
        }

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

        if (mpFetchError) throw new Error(`Failed loading active MPs: ${mpFetchError.message}`);
        if (!mps || mps.length === 0) return;

        const completedIds = new Set((existingRows || []).map(r => r.parliament_member_id));
        const pendingMps = mps.filter(mp => !completedIds.has(mp.parliament_member_id));

        console.log(`Total active MPs: ${mps.length}. Already saved for ${dateStr}: ${completedIds.size}. Remaining: ${pendingMps.length}.`);
        if (pendingMps.length === 0) return;

        console.log('Fetching Hansard (Chamber, Westminster Hall, Bill Committees), Select Committees, and Division Votes...');
        const [
            contributionsByMp,
            { eventsCount, committeesByMp },
            { divisionsCount, votesByMp }
        ] = await Promise.all([
            fetchHansardContributionsByDate(dateStr),
            fetchCommitteeAttendanceByDate(dateStr),
            fetchDivisionVotesByDate(dateStr)
        ]);

        const isSittingDay = contributionsByMp.size > 0 || eventsCount > 0 || divisionsCount > 0;
        console.log(
            `Date ${dateStr}: Active day = ${isSittingDay} ` +
            `(${contributionsByMp.size} MPs spoke, ${eventsCount} committee meetings / ${committeesByMp.size} MPs attended, ${divisionsCount} divisions).`
        );

        let cursor = 0;
        let savedCount = 0;
        const buffer = [];

        async function worker() {
            while (true) {
                const idx = cursor++;
                if (idx >= pendingMps.length) break;

                const mp = pendingMps[idx];
                const speeches = contributionsByMp.get(mp.parliament_member_id) || [];
                const committees = committeesByMp.get(mp.parliament_member_id) || [];
                const votes = votesByMp.get(mp.parliament_member_id) || [];

                let generated;
                if (!isSittingDay) {
                    generated = {
                        activity_tag: 'Non-Sitting Day',
                        hansard_ref: null,
                        summary_para_1: `The House of Commons did not sit on ${formatReadableDate(dateStr)} (weekend, recess, or non-sitting day), so no Chamber debates, committee hearings, or division votes took place.`,
                        summary_para_2: `Outside of parliamentary sitting days, ${mp.short_name} focuses on constituency casework, local visits, and written ministerial correspondence.`,
                        verbatim_excerpt: null,
                        glossary: []
                    };
                } else if (speeches.length > 0 || committees.length > 0) {
                    generated = await summarizeMpActivity(mp, dateStr, speeches, committees, votes);
                } else if (votes.length > 0) {
                    generated = buildVoteOnlyBriefing(mp, dateStr, votes);
                } else {
                    generated = {
                        activity_tag: 'Constituency & Parliamentary Work',
                        hansard_ref: `HC Deb ${formatReadableDate(dateStr)}`,
                        summary_para_1: `${mp.short_name} had no recorded spoken contributions in the Chamber, Westminster Hall, or Bill Committees, and no recorded Select Committee attendance or division votes on ${formatReadableDate(dateStr)}.`,
                        summary_para_2: `MPs frequently spend sitting days on constituency casework, ministerial meetings, All-Party Parliamentary Groups, or drafting written parliamentary questions.`,
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

        await supabase
            .from('system_status')
            .upsert({ id: 1, last_briefing_sync: new Date().toISOString() });

        const totalSec = Math.round((Date.now() - startTime) / 1000);
        console.log(`[${new Date().toISOString()}] Finished! Saved ${savedCount} briefings for ${dateStr} in ${totalSec}s.`);
    } catch (err) {
        console.error('Fatal error during briefing generation:', err);
        process.exit(1);
    }
}

generateBriefings();
