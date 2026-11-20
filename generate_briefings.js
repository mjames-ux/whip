/**
 * Whip — Step 2: 6:30 AM Daily Hansard, Commons Votes & Gemini Briefing Generator
 *
 * Fetches yesterday's spoken contributions (Hansard API) and division votes
 * (Commons Votes API), generates two accessible plain-English paragraphs per
 * speaking MP via Gemini 2.5 Flash (Free Tier rate-limited), and saves all 650
 * daily briefings to Postgres.
 *
 * Requirements:
 *   npm install @supabase/supabase-js @google/genai dotenv
 *
 * Usage:
 *   node generate_briefings.js              # Processes yesterday's date
 *   node generate_briefings.js 2026-11-19   # Processes a specific YYYY-MM-DD date
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type } from '@google/genai';

const HANSARD_SEARCH_API = 'https://hansard-api.parliament.uk/search/contributions/Spoken.json';
const COMMONS_VOTES_SEARCH_API = 'https://commonsvotes-api.parliament.uk/data/divisions.json/search';
const COMMONS_VOTE_DETAIL_API = 'https://commonsvotes-api.parliament.uk/data/division';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!supabaseUrl || !supabaseKey || !geminiApiKey) {
    console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or GEMINI_API_KEY in environment.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const ai = new GoogleGenAI({ apiKey: geminiApiKey });

/**
 * Helper: Pause execution for a given number of milliseconds (for Free-Tier pacing).
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Helper: Returns yesterday's date in YYYY-MM-DD format (UTC/UK), or uses CLI arg.
 */
function getTargetDateString() {
    if (process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2])) {
        return process.argv[2];
    }
    const now = new Date();
    now.setDate(now.getDate() - 1);
    return now.toISOString().split('T')[0];
}

/**
 * Helper: Strips HTML tags and normalizes whitespace from Hansard transcript snippets.
 */
function cleanHansardHtml(rawHtml = '') {
    return rawHtml
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 1. Fetch all House of Commons spoken contributions for a given date,
 *    grouped by each MP's official `MemberId`.
 */
async function fetchHansardByMember(dateStr) {
    const contributionsByMember = new Map();
    let skip = 0;
    const take = 100;
    let totalResults = null;

    while (totalResults === null || skip < totalResults) {
        const url = new URL(HANSARD_SEARCH_API);
        url.searchParams.set('House', 'Commons');
        url.searchParams.set('StartDate', dateStr);
        url.searchParams.set('EndDate', dateStr);
        url.searchParams.set('Skip', String(skip));
        url.searchParams.set('Take', String(take));

        const response = await fetch(url.toString(), {
            headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
            throw new Error(`Hansard API error (${response.status}): ${response.statusText}`);
        }

        const payload = await response.json();
        totalResults = payload.TotalResultCount ?? 0;
        const results = payload.Results ?? [];

        if (results.length === 0) break;

        for (const item of results) {
            const memberId = item.MemberId;
            if (!memberId) continue; // Skip Speaker/procedural entries without an MP ID

            const text = cleanHansardHtml(item.ContributionTextFull || item.ContributionText || '');
            if (!text) continue;

            if (!contributionsByMember.has(memberId)) {
                contributionsByMember.set(memberId, {
                    speeches: [],
                    debates: new Set(),
                    hansardRefs: new Set()
                });
            }

            const record = contributionsByMember.get(memberId);
            if (item.DebateSection) record.debates.add(item.DebateSection);
            if (item.HansardSection) record.hansardRefs.add(item.HansardSection);
            record.speeches.push({
                debate: item.DebateSection || 'Commons Chamber',
                time: item.Timecode || '',
                text
            });
        }

        skip += results.length;
    }

    return contributionsByMember;
}

/**
 * 2. Fetch all House of Commons divisions (votes) on `dateStr` and map
 *    each MP's vote (`Aye`, `No`, or `Abstained`).
 */
async function fetchVotesForDate(dateStr) {
    const listUrl = new URL(COMMONS_VOTES_SEARCH_API);
    listUrl.searchParams.set('queryParameters.startDate', dateStr);
    listUrl.searchParams.set('queryParameters.endDate', dateStr);

    const listRes = await fetch(listUrl.toString(), {
        headers: { 'Accept': 'application/json' }
    });

    if (!listRes.ok) {
        throw new Error(`Commons Votes API error (${listRes.status}): ${listRes.statusText}`);
    }

    const divisionsSummary = await listRes.json();
    if (!Array.isArray(divisionsSummary) || divisionsSummary.length === 0) {
        return [];
    }

    // Fetch full Aye / No member lists for each division held yesterday
    const detailedDivisions = [];
    for (const div of divisionsSummary) {
        const detailRes = await fetch(`${COMMONS_VOTE_DETAIL_API}/${div.DivisionId}.json`, {
            headers: { 'Accept': 'application/json' }
        });
        if (!detailRes.ok) continue;

        const detail = await detailRes.json();
        const ayeIds = new Set((detail.Ayes || []).map(m => m.MemberId));
        const noIds = new Set((detail.Noes || []).map(m => m.MemberId));
        // Include tellers in Aye/No counts
        (detail.AyeTellers || []).forEach(m => ayeIds.add(m.MemberId));
        (detail.NoTellers || []).forEach(m => noIds.add(m.MemberId));

        const ayeCount = detail.AyeCount ?? ayeIds.size;
        const noCount = detail.NoCount ?? noIds.size;
        const outcome = ayeCount > noCount
            ? `Passed ${ayeCount}–${noCount}`
            : `Defeated ${ayeCount}–${noCount}`;

        detailedDivisions.push({
            divisionId: detail.DivisionId,
            title: detail.Title || 'House of Commons Division',
            outcome,
            ayeIds,
            noIds
        });
    }

    return detailedDivisions;
}

/**
 * Helper: Builds the voting record array for a single MP across all divisions held yesterday.
 */
function buildMemberVoteRecord(memberId, divisions) {
    return divisions.map(div => {
        let mpVote = 'Abstained';
        if (div.ayeIds.has(memberId)) mpVote = 'Aye';
        else if (div.noIds.has(memberId)) mpVote = 'No';

        return {
            title: div.title,
            subtitle: 'House of Commons recorded division',
            mpVote,
            houseResult: div.outcome
        };
    });
}

/**
 * 3. Generate the two plain-English paragraphs, activity tag, verbatim excerpt,
 *    and jargon glossary using Gemini 2.5 Flash with Structured JSON Outputs
 *    and automatic retry handling for Free-Tier 429 rate limits.
 */
async function generateAiSummary(mp, speechBundle, dateStr, attempt = 1) {
    const debatesList = Array.from(speechBundle.debates).join('; ');
    // Cap transcript length at ~14,000 chars so long speeches stay fast and inexpensive
    const combinedTranscript = speechBundle.speeches
        .map(s => `[Debate: ${s.debate}]\n${s.text}`)
        .join('\n\n')
        .slice(0, 14000);

    const prompt = `
You are an impartial, non-partisan civic editor writing for "Whip", an app that explains to ordinary UK constituents what their MP did yesterday in Parliament.

MP: ${mp.full_name} (${mp.party}, MP for ${mp.constituencies?.name || 'their constituency'})
Date: ${dateStr}
Debates participated in: ${debatesList}

Raw Hansard Transcript from yesterday:
"""
${combinedTranscript}
"""

Write a clear, accessible briefing following these strict rules:
1. "activity_tag": Short 2–4 word label of what they did (e.g. "Debate Speech & Questions", "Prime Minister's Questions", "Chamber Intervention").
2. "summary_para_1": ONE clear paragraph (3–4 sentences, ~65–85 words) summarising what the MP actually said, asked, or argued in Parliament yesterday. Use everyday British English, active verbs, and zero parliamentary jargon.
3. "summary_para_2": ONE neutral background paragraph (2–3 sentences, ~50–70 words) explaining the underlying policy issue or bill to a curious citizen who doesn't follow Westminster politics closely. Remain strictly impartial.
4. "verbatim_excerpt": Pick the single clearest, most representative direct quote (1–2 sentences) from their transcript above.
5. "glossary": Extract 1 to 2 parliamentary or policy terms mentioned in the transcript and translate each into a single plain-English sentence.
`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                temperature: 0.2,
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        activity_tag: { type: Type.STRING },
                        summary_para_1: { type: Type.STRING },
                        summary_para_2: { type: Type.STRING },
                        verbatim_excerpt: { type: Type.STRING },
                        glossary: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    term: { type: Type.STRING },
                                    plain: { type: Type.STRING }
                                },
                                required: ['term', 'plain']
                            }
                        }
                    },
                    required: ['activity_tag', 'summary_para_1', 'summary_para_2', 'verbatim_excerpt', 'glossary']
                }
            }
        });

        return JSON.parse(response.text);
    } catch (err) {
        const isRateLimit = err?.status === 429 || String(err?.message).includes('429') || String(err?.message).includes('RESOURCE_EXHAUSTED');
        if (isRateLimit && attempt <= 3) {
            const backoffMs = attempt * 15000; // Wait 15s, 30s, then 45s on 429
            console.warn(`Rate limit hit for ${mp.short_name}. Retrying in ${backoffMs / 1000}s (attempt ${attempt}/3)...`);
            await sleep(backoffMs);
            return generateAiSummary(mp, speechBundle, dateStr, attempt + 1);
        }
        throw err;
    }
}

/**
 * Main pipeline execution
 */
export async function generateDailyBriefings() {
    const targetDate = getTargetDateString();
    console.log(`[${new Date().toISOString()}] Generating Whip briefings for sitting date: ${targetDate}`);

    try {
        // 1. Load all active MPs from Postgres
        const { data: activeMps, error: mpError } = await supabase
            .from('mps')
            .select('parliament_member_id, full_name, short_name, party, constituencies(name)')
            .eq('is_current_member', true);

        if (mpError) throw new Error(`Failed to fetch active MPs: ${mpError.message}`);
        if (!activeMps || activeMps.length === 0) {
            console.log('No active MPs in database (Parliament may be dissolved). Exiting.');
            return;
        }

        // 2. Fetch yesterday's Hansard speeches & Commons Votes
        const [hansardMap, divisions] = await Promise.all([
            fetchHansardByMember(targetDate),
            fetchVotesForDate(targetDate)
        ]);

        const isSittingDay = hansardMap.size > 0 || divisions.length > 0;
        console.log(`Found ${hansardMap.size} MPs who spoke and ${divisions.length} divisions on ${targetDate}.`);

        const briefingsToUpsert = [];

        // 3. Process MPs sequentially with a 6.5s gap (~9 requests/min) to stay safely
        //    within Gemini Free Tier limits (10–15 RPM). Switch to 6:10 AM cron so all
        //    ~250 active speakers finish well before 7:00 AM.
        const FREE_TIER_DELAY_MS = 6500;

        for (let i = 0; i < activeMps.length; i++) {
            const mp = activeMps[i];
            const memberId = mp.parliament_member_id;
            const speechBundle = hansardMap.get(memberId);
            const votes = buildMemberVoteRecord(memberId, divisions);
            let usedAiCall = false;

            // Case A: The MP spoke in the Commons yesterday -> Generate AI 2-paragraph summary
            if (speechBundle && speechBundle.speeches.length > 0) {
                usedAiCall = true;
                const refList = Array.from(speechBundle.hansardRefs);
                const debatesList = Array.from(speechBundle.debates);

                try {
                    const aiResult = await generateAiSummary(mp, speechBundle, targetDate);

                    briefingsToUpsert.push({
                        sitting_date: targetDate,
                        parliament_member_id: memberId,
                        activity_tag: aiResult.activity_tag,
                        hansard_ref: refList[0] || `HC Deb ${targetDate}`,
                        summary_para_1: aiResult.summary_para_1,
                        summary_para_2: aiResult.summary_para_2,
                        verbatim_excerpt: aiResult.verbatim_excerpt,
                        glossary: aiResult.glossary,
                        votes
                    });
                } catch (err) {
                    console.error(`AI summary failed for ${mp.full_name} (${memberId}), using fallback:`, err.message);

                    // Safety Net: Ensure 100% of MPs still receive a valid briefing even if AI fails
                    const primaryDebate = debatesList[0] || 'House of Commons proceedings';
                    const speechCount = speechBundle.speeches.length;
                    const firstSpeech = speechBundle.speeches[0]?.text || '';
                    const excerpt = firstSpeech.length > 260
                        ? `${firstSpeech.slice(0, 257)}...`
                        : firstSpeech;

                    briefingsToUpsert.push({
                        sitting_date: targetDate,
                        parliament_member_id: memberId,
                        activity_tag: 'Chamber Contribution',
                        hansard_ref: refList[0] || `HC Deb ${targetDate}`,
                        summary_para_1: `${mp.short_name} contributed ${speechCount} ${speechCount === 1 ? 'time' : 'times'} in the House of Commons yesterday, speaking during ${primaryDebate}. You can read their exact words in the official Hansard transcript link below.`,
                        summary_para_2: `Every spoken contribution in the House of Commons chamber is recorded verbatim by Hansard reporters so constituents can follow how their representative raises local and national issues in Parliament.`,
                        verbatim_excerpt: excerpt || 'See full verbatim record on hansard.parliament.uk.',
                        glossary: [
                            {
                                term: 'Hansard',
                                plain: 'The official, substantially verbatim report of everything said in debates in the UK Parliament.'
                            }
                        ],
                        votes
                    });
                }
            } else if (isSittingDay) {
                // Case B: Sitting day, MP did not speak in the chamber (no AI call needed)
                const voteCount = votes.filter(v => v.mpVote !== 'Abstained').length;
                const voteSentence = voteCount > 0
                    ? `They took part in ${voteCount} ${voteCount === 1 ? 'division' : 'divisions'} in the voting lobbies.`
                    : 'No chamber votes were recorded under their name on this date.';

                briefingsToUpsert.push({
                    sitting_date: targetDate,
                    parliament_member_id: memberId,
                    activity_tag: voteCount > 0 ? 'Chamber Votes' : 'Parliamentary Duties',
                    hansard_ref: `HC Deb ${targetDate}`,
                    summary_para_1: `${mp.short_name} did not make a spoken contribution in the main House of Commons chamber yesterday. ${voteSentence}`,
                    summary_para_2: `MPs spend much of their week working outside the main chamber—scrutinising legislation in bill committees, attending cross-party briefings, responding to constituent casework, or fulfilling ministerial responsibilities.`,
                    verbatim_excerpt: 'No spoken contribution recorded in Hansard for this sitting date.',
                    glossary: [
                        {
                            term: 'Division (Vote)',
                            plain: 'When MPs physically walk through the Aye or No voting lobbies to decide whether a bill or motion passes.'
                        }
                    ],
                    votes
                });
            } else {
                // Case C: Non-sitting day (Fridays, weekends, or parliamentary recess — 0 AI calls)
                briefingsToUpsert.push({
                    sitting_date: targetDate,
                    parliament_member_id: memberId,
                    activity_tag: 'Constituency & Recess',
                    hansard_ref: 'No Commons Sitting',
                    summary_para_1: `The House of Commons did not sit for main chamber debates or votes on ${targetDate}. On non-sitting days, MPs typically work in their local constituencies holding resident advice surgeries, visiting local schools and businesses, or catching up on casework.`,
                    summary_para_2: `An MP’s role splits between lawmaking in Westminster and representing residents at home. Even when no speeches appear in Hansard, MPs and their constituency teams handle hundreds of local requests on housing, healthcare, and public services.`,
                    verbatim_excerpt: 'No chamber transcript recorded. Constituency duties are logged separately from official Hansard debates.',
                    glossary: [
                        {
                            term: 'Constituency surgery',
                            plain: 'A confidential drop-in or appointment session where local residents can ask their MP for help with personal or local issues.'
                        }
                    ],
                    votes: []
                });
            }

            if ((i + 1) % 25 === 0 || i === activeMps.length - 1) {
                console.log(`Processed ${i + 1} / ${activeMps.length} MPs...`);
            }

            // Pause only after an actual Gemini API call
            if (usedAiCall && i < activeMps.length - 1) {
                await sleep(FREE_TIER_DELAY_MS);
            }
        }

        // 4. Upsert all 650 daily briefings into Postgres
        const { error: upsertError } = await supabase
            .from('daily_briefings')
            .upsert(briefingsToUpsert, { onConflict: 'sitting_date,parliament_member_id' });

        if (upsertError) {
            throw new Error(`Failed to save daily briefings: ${upsertError.message}`);
        }

        // 5. Update last_briefing_sync timestamp
        await supabase
            .from('system_status')
            .update({ last_briefing_sync: new Date().toISOString() })
            .eq('id', 1);

        console.log(`Done! Saved ${briefingsToUpsert.length} briefings for ${targetDate}.`);
    } catch (error) {
        console.error('Briefing generation failed:', error);
        process.exitCode = 1;
    }
}

generateDailyBriefings();
