/**
 * Whip — Step 2: Daily Parliamentary Briefing Generator (`generate_briefings.js`)
 *
 * Fetches House of Commons Hansard speeches (via Spoken Contributions API with
 * automatic fallback to Overview/Debates sections), Select/Bill Committee appearances,
 * and Commons Division votes for a target sitting date, generates plain-English neutral
 * summaries via Gemini, enriches voting-only context with UK Parliament Bills API
 * details, and upserts into `daily_briefings`.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const HANSARD_SEARCH_API = 'https://hansard-api.parliament.uk/search/contributions/Spoken.json';
const HANSARD_SECTIONS_API = 'https://hansard-api.parliament.uk/overview/sectionsforday.json';
const HANSARD_DEBATE_API = 'https://hansard-api.parliament.uk/debates/debate';
const COMMONS_VOTES_API = 'https://commonsvotes-api.parliament.uk/data/divisions.json/search';
const COMMONS_DIVISION_DETAIL_API = 'https://commonsvotes-api.parliament.uk/data/division';
const COMMITTEES_EVENTS_API = 'https://committees-api.parliament.uk/api/Broadcast/Meetings';
const BILLS_SEARCH_API = 'https://bills-api.parliament.uk/api/v1/Bills';

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

function getTargetDateString() {
    // 1. CLI argument: node generate_briefings.js --date=2026-11-16
    const arg = process.argv.find(a => a.startsWith('--date='));
    if (arg) {
        const val = arg.split('=')[1]?.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
    }

    // 2. Environment variable (e.g. GitHub Actions workflow_dispatch input)
    const envDate = cleanEnvValue(process.env.TARGET_DATE, 'TARGET_DATE');
    if (/^\d{4}-\d{2}-\d{2}$/.test(envDate)) {
        return envDate;
    }

    // 3. Default: yesterday's UTC date for the 7:00 AM daily run
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
}

function formatReadableDate(isoDate) {
    const d = new Date(`${isoDate}T12:00:00Z`);
    return d.toLocaleDateString('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC'
    });
}

function stripHtml(html) {
    return String(html || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

async function fetchJsonWithTimeout(url, timeoutMs = 15000) {
    const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return res.json();
}

function extractSpeechRecordsFromItems(items, byMember, fallbackDebateTitle = 'Commons Debate') {
    for (const item of items) {
        const memberId = Number(
            item.MemberId ??
            item.memberId ??
            item.AttributedToMemberId ??
            item.attributedToMemberId
        );
        if (!memberId) continue;

        const text = stripHtml(
            item.Value ??
            item.value ??
            item.ContributionText ??
            item.contributionText ??
            item.Text ??
            item.text ??
            ''
        );
        if (!text) continue;

        const debateTitle =
            item.DebateSection ??
            item.debateSection ??
            item.Section ??
            item.section ??
            fallbackDebateTitle;

        if (!byMember.has(memberId)) {
            byMember.set(memberId, []);
        }
        byMember.get(memberId).push({
            debateTitle,
            time: item.Timecode ?? item.timecode ?? '',
            hansardId: item.HansardSection ?? item.hansardSection ?? '',
            text
        });
    }
}

/**
 * Fallback: walk Hansard sections-for-day -> individual debate trees if Spoken search returns 0 items.
 */
async function fetchHansardViaDebateTrees(dateStr, byMember) {
    const sectionTrees = [];
    for (const section of ['Commons', 'WestminsterHall']) {
        try {
            const url = new URL(HANSARD_SECTIONS_API);
            url.searchParams.set('date', dateStr);
            url.searchParams.set('house', section);
            const data = await fetchJsonWithTimeout(url.toString(), 15000);
            if (Array.isArray(data)) {
                sectionTrees.push(...data);
            }
        } catch (err) {
            console.warn(`Hansard sections warning (${section}): ${err.message}`);
        }
    }

    const debateIds = new Set();
    function collectDebateIds(nodes) {
        for (const node of nodes || []) {
            const id = node.ExternalId || node.externalId || node.DebateSectionExtId || node.Id || node.id;
            const children = node.ChildSections || node.childSections || node.SubSections || [];
            if (id && children.length === 0) {
                debateIds.add(String(id));
            }
            if (children.length > 0) {
                collectDebateIds(children);
            }
        }
    }
    collectDebateIds(sectionTrees);

    console.log(`Fallback debate tree scan: found ${debateIds.size} debate sections for ${dateStr}.`);

    for (const extId of debateIds) {
        try {
            const debate = await fetchJsonWithTimeout(`${HANSARD_DEBATE_API}/${encodeURIComponent(extId)}.json`, 15000);
            const title = debate?.Overview?.Title || debate?.Title || 'Commons Debate';
            const items = debate?.Items || debate?.items || [];
            extractSpeechRecordsFromItems(items, byMember, title);
        } catch {}
    }
}

/**
 * 1. Fetch all Commons spoken Hansard contributions for the target date.
 */
async function fetchHansardContributions(dateStr) {
    const byMember = new Map();
    let skip = 0;
    const take = 100;

    while (true) {
        const url = new URL(HANSARD_SEARCH_API);
        url.searchParams.set('queryParameters.house', 'Commons');
        url.searchParams.set('queryParameters.startDate', dateStr);
        url.searchParams.set('queryParameters.endDate', dateStr);
        url.searchParams.set('queryParameters.skip', String(skip));
        url.searchParams.set('queryParameters.take', String(take));

        let data;
        try {
            data = await fetchJsonWithTimeout(url.toString(), 20000);
        } catch (err) {
            console.warn(`Hansard search warning at skip=${skip}: ${err.message}`);
            break;
        }

        const results = data?.Results || data?.results || [];
        if (results.length === 0) break;

        extractSpeechRecordsFromItems(results, byMember);

        skip += results.length;
        const total = data?.TotalResultCount ?? data?.totalResultCount ?? 0;
        if (skip >= total) break;
    }

    if (byMember.size === 0) {
        await fetchHansardViaDebateTrees(dateStr, byMember);
    }

    return byMember;
}

/**
 * 2. Fetch Commons Division votes for the target date and map each MP's vote.
 */
async function fetchDivisionVotes(dateStr) {
    const votesByMember = new Map();
    let divisions = [];

    try {
        const url = new URL(COMMONS_VOTES_API);
        url.searchParams.set('startDate', dateStr);
        url.searchParams.set('endDate', dateStr);
        url.searchParams.set('take', '50');
        divisions = await fetchJsonWithTimeout(url.toString(), 15000);
    } catch (err) {
        console.warn(`Commons Votes search warning: ${err.message}`);
        return { divisions: [], votesByMember };
    }

    if (!Array.isArray(divisions) || divisions.length === 0) {
        return { divisions: [], votesByMember };
    }

    const detailedDivisions = [];
    for (const div of divisions) {
        try {
            const detail = await fetchJsonWithTimeout(`${COMMONS_DIVISION_DETAIL_API}/${div.DivisionId}.json`, 15000);
            detailedDivisions.push(detail);
        } catch (err) {
            console.warn(`Division ${div.DivisionId} detail warning: ${err.message}`);
        }
    }

    for (const detail of detailedDivisions) {
        const ayes = new Set([
            ...(detail.Ayes || []).map(m => Number(m.MemberId)),
            ...(detail.AyeTellers || []).map(m => Number(m.MemberId))
        ]);
        const noes = new Set([
            ...(detail.Noes || []).map(m => Number(m.MemberId)),
            ...(detail.NoTellers || []).map(m => Number(m.MemberId))
        ]);

        const ayeCount = detail.AyeCount ?? ayes.size;
        const noCount = detail.NoCount ?? noes.size;
        const houseResult = ayeCount > noCount
            ? `Passed (${ayeCount} Ayes to ${noCount} Noes)`
            : `Rejected (${ayeCount} Ayes to ${noCount} Noes)`;

        const baseRecord = {
            divisionId: detail.DivisionId,
            title: detail.Title || 'House of Commons Division',
            houseResult
        };

        const allVoterIds = new Set([...ayes, ...noes]);
        for (const memberId of allVoterIds) {
            if (!votesByMember.has(memberId)) {
                votesByMember.set(memberId, []);
            }
            votesByMember.get(memberId).push({
                ...baseRecord,
                mpVote: ayes.has(memberId) ? 'Aye' : 'No'
            });
        }
    }

    return { divisions: detailedDivisions, votesByMember };
}

/**
 * 3. Fetch Select Committee meetings held on the target date and map attending MPs.
 */
async function fetchCommitteeAppearances(dateStr) {
    const byMember = new Map();
    try {
        const url = new URL(COMMITTEES_EVENTS_API);
        url.searchParams.set('StartDate', `${dateStr}T00:00:00Z`);
        url.searchParams.set('EndDate', `${dateStr}T23:59:59Z`);
        url.searchParams.set('House', 'Commons');
        const data = await fetchJsonWithTimeout(url.toString(), 15000);
        const items = Array.isArray(data) ? data : (data?.items || []);

        for (const meeting of items) {
            const committeeName = meeting.committees?.[0]?.name || meeting.title || 'Select Committee';
            const topic = meeting.description || meeting.title || 'Committee evidence session';
            const attendees = meeting.attendees || meeting.members || [];

            for (const person of attendees) {
                const memberId = Number(person.memberId || person.id);
                if (!memberId) continue;
                if (!byMember.has(memberId)) byMember.set(memberId, []);
                byMember.get(memberId).push({
                    committeeName,
                    topic: stripHtml(topic)
                });
            }
        }
    } catch (err) {
        console.warn(`Committees fetch warning: ${err.message}`);
    }
    return byMember;
}

/**
 * 4. Summarize an MP's spoken/committee activity with Gemini.
 */
async function summarizeWithGemini(mp, dateStr, speeches, committees, votes) {
    const speechDigest = speeches
        .slice(0, 8)
        .map(s => `- Debate: "${s.debateTitle}" | Excerpt: ${s.text.slice(0, 900)}`)
        .join('\n');

    const committeeDigest = committees
        .map(c => `- Committee: ${c.committeeName} (${c.topic.slice(0, 250)})`)
        .join('\n');

    const voteDigest = votes
        .map(v => `- ${v.title}: Voted ${v.mpVote} (${v.houseResult})`)
        .join('\n');

    const prompt = `You are a strictly neutral, non-partisan UK parliamentary reporter writing for Whip (whipdaily.uk).
Summarize what ${mp.full_name} (${mp.party}, MP for ${mp.constituencies?.name || 'UK'}) did in Parliament on ${formatReadableDate(dateStr)} in plain, accessible British English.

Rules:
- Be strictly factual, calm, and neutral. Never take a political stance or editorialize.
- Return valid JSON only with keys: "activity_tag", "summary_para_1", "summary_para_2", "verbatim_excerpt", "glossary".
- "activity_tag": short label (e.g., "Prime Minister's Questions", "Chamber Debate & Votes", "Oral Questions", "Select Committee", "Division Votes").
- "summary_para_1": 2–3 clear sentences describing specifically what ${mp.short_name} asked, argued, or scrutinized.
- "summary_para_2": 2–3 sentences explaining the wider policy or legislative context in plain English for an everyday voter.
- "verbatim_excerpt": a single direct, representative sentence quoted verbatim from the spoken contribution (or null if none).
- "glossary": array of 0–2 objects {"term": "...", "plain": "..."} explaining any parliamentary jargon mentioned.

Evidence from ${dateStr}:
${speechDigest ? `Spoken Contributions:\n${speechDigest}\n` : ''}
${committeeDigest ? `Committee Work:\n${committeeDigest}\n` : ''}
${voteDigest ? `Division Votes:\n${voteDigest}\n` : ''}`;

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.2,
                responseMimeType: 'application/json'
            }
        }),
        signal: AbortSignal.timeout(25000)
    });

    if (!res.ok) {
        throw new Error(`Gemini HTTP ${res.status}`);
    }

    const payload = await res.json();
    const rawText = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(rawText);

    return {
        activity_tag: parsed.activity_tag || 'Parliamentary Business',
        summary_para_1: parsed.summary_para_1 || `${mp.short_name} participated in House of Commons proceedings on ${formatReadableDate(dateStr)}.`,
        summary_para_2: parsed.summary_para_2 || `MPs scrutinize legislation, question ministers, and represent constituency issues across Chamber and committee sessions.`,
        verbatim_excerpt: parsed.verbatim_excerpt || (speeches[0]?.text ? speeches[0].text.slice(0, 260) : null),
        glossary: Array.isArray(parsed.glossary) ? parsed.glossary : []
    };
}

const billContextCache = new Map();

function fallbackBillOrMotionContext(title) {
    const cleanTitle = (title || '').trim();
    if (!cleanTitle) return null;
    const lower = cleanTitle.toLowerCase();

    if (lower.includes('visitor levy')) {
        return 'The Visitor Levy (England) Bill proposes powers for mayors and strategic authorities in England to introduce a local overnight accommodation levy to support local transport, infrastructure, and tourism.';
    }
    if (lower.includes('immigration and asylum')) {
        return 'The Immigration and Asylum Bill sets out changes to asylum claims, human rights assessments, modern slavery referrals, and immigration appeals.';
    }
    if (lower.includes('opposition day')) {
        return 'Opposition Day debates give non-government parties the floor to scrutinize ministers and put forward motions on policy issues of their choice.';
    }
    return null;
}

async function getBillContextForDivisions(votes, readableDate) {
    const snippets = [];

    for (const v of (votes || []).slice(0, 3)) {
        const cleanBillName = (v.title || '')
            .replace(/:\s*(Second Reading|Third Reading|Report Stage|Committee|Programme|Money).*$/i, '')
            .trim();
        if (!cleanBillName) continue;

        if (!billContextCache.has(cleanBillName)) {
            let summary = fallbackBillOrMotionContext(cleanBillName);

            if (!summary && /\bbill\b/i.test(cleanBillName)) {
                try {
                    const url = new URL(BILLS_SEARCH_API);
                    url.searchParams.set('SearchTerm', cleanBillName);
                    url.searchParams.set('Take', '1');
                    const data = await fetchJsonWithTimeout(url.toString(), 8000);
                    const item = data?.items?.[0];
                    if (item?.longTitle) {
                        const cleanLongTitle = stripHtml(item.longTitle)
                            .replace(/^A Bill to\s+/i, '')
                            .replace(/;\s*and for connected purposes\.?$/i, '')
                            .replace(/\.$/, '')
                            .trim();
                        if (cleanLongTitle) {
                            summary = `${item.shortTitle || cleanBillName} is legislation to ${cleanLongTitle.charAt(0).toLowerCase()}${cleanLongTitle.slice(1)}.`;
                        }
                    }
                } catch {}
            }

            if (!summary) {
                summary = `${cleanBillName} was put before the House of Commons on ${readableDate} to test MPs' support for the proposed measure or motion.`;
            }

            billContextCache.set(cleanBillName, summary);
        }

        const cached = billContextCache.get(cleanBillName);
        if (cached && !snippets.includes(cached)) {
            snippets.push(cached);
        }
        if (snippets.length >= 2) break;
    }

    return snippets.join(' ');
}

/**
 * Concurrency helper to process 650 MPs rapidly without rate-limit spikes.
 */
async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let idx = 0;

    async function next() {
        while (idx < items.length) {
            const current = idx++;
            results[current] = await worker(items[current], current);
        }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => next());
    await Promise.all(workers);
    return results;
}

export async function generateBriefings() {
    const dateStr = getTargetDateString();
    console.log(`[${new Date().toISOString()}] Generating parliamentary briefings for ${dateStr}...`);

    const { data: statusData } = await supabase
        .from('system_status')
        .select('is_parliament_dissolved')
        .eq('id', 1)
        .maybeSingle();

    if (statusData?.is_parliament_dissolved) {
        console.log('Parliament is currently dissolved — skipping briefing generation.');
        return;
    }

    const { data: mps, error: mpError } = await supabase
        .from('mps')
        .select('parliament_member_id, full_name, short_name, party, constituencies(name)')
        .eq('is_current_member', true)
        .order('parliament_member_id', { ascending: true });

    if (mpError || !mps?.length) {
        throw new Error(`Failed to fetch active MPs: ${mpError?.message || '0 rows'}`);
    }

    const [speechesByMember, { divisions, votesByMember }, committeesByMember] = await Promise.all([
        fetchHansardContributions(dateStr),
        fetchDivisionVotes(dateStr),
        fetchCommitteeAppearances(dateStr)
    ]);

    const isNonSittingDay =
        speechesByMember.size === 0 &&
        divisions.length === 0 &&
        committeesByMember.size === 0;

    console.log(
        `Evidence for ${dateStr}: ${speechesByMember.size} MPs spoke, ` +
        `${divisions.length} divisions, ${committeesByMember.size} committee attendees.`
    );

    const allDivisionSummaries = divisions.map(d => {
        const ayeCount = d.AyeCount ?? (d.Ayes?.length || 0);
        const noCount = d.NoCount ?? (d.Noes?.length || 0);
        return {
            divisionId: d.DivisionId,
            title: d.Title || 'House of Commons Division',
            houseResult: ayeCount > noCount
                ? `Passed (${ayeCount} Ayes to ${noCount} Noes)`
                : `Rejected (${ayeCount} Ayes to ${noCount} Noes)`
        };
    });

    const readableDate = formatReadableDate(dateStr);

    const rowsToUpsert = await mapWithConcurrency(mps, 8, async (mp) => {
        const memberId = mp.parliament_member_id;
        const speeches = speechesByMember.get(memberId) || [];
        const committees = committeesByMember.get(memberId) || [];
        const mpVotes = votesByMember.get(memberId) || [];

        // Build complete division list for this MP (marking Abstained if no Aye/No recorded)
        const votedIds = new Set(mpVotes.map(v => v.divisionId));
        const fullDayVotes = [
            ...mpVotes,
            ...allDivisionSummaries
                .filter(d => !votedIds.has(d.divisionId))
                .map(d => ({ ...d, mpVote: 'Abstained' }))
        ];

        if (isNonSittingDay) {
            return {
                parliament_member_id: memberId,
                sitting_date: dateStr,
                activity_tag: 'Non-Sitting Day',
                hansard_ref: readableDate,
                summary_para_1: `The House of Commons did not sit on ${readableDate}.`,
                summary_para_2: `During weekends, recess, and non-sitting Fridays, MPs work in their constituencies holding advice surgeries, visiting local schools and businesses, and responding to constituent casework.`,
                verbatim_excerpt: null,
                glossary: [],
                votes: []
            };
        }

        // Only call Gemini for MPs who actually spoke or sat in a public committee session
        if (speeches.length > 0 || committees.length > 0) {
            try {
                const ai = await summarizeWithGemini(mp, dateStr, speeches, committees, mpVotes);
                return {
                    parliament_member_id: memberId,
                    sitting_date: dateStr,
                    activity_tag: ai.activity_tag,
                    hansard_ref: speeches[0]?.debateTitle
                        ? `HC Deb ${dateStr} — ${speeches[0].debateTitle}`
                        : `Commons Committees ${dateStr}`,
                    summary_para_1: ai.summary_para_1,
                    summary_para_2: ai.summary_para_2,
                    verbatim_excerpt: ai.verbatim_excerpt,
                    glossary: ai.glossary,
                    votes: fullDayVotes
                };
            } catch (err) {
                console.warn(`Gemini fallback for ${mp.short_name} (${memberId}): ${err.message}`);
            }
        }

        // Zero-token summary with bill/motion context for MPs who voted without speaking
        if (mpVotes.length > 0) {
            const firstVote = mpVotes[0];
            const extraText = mpVotes.length > 1
                ? ` and ${mpVotes.length - 1} other ${mpVotes.length - 1 === 1 ? 'division' : 'divisions'}`
                : '';

            const billContext = await getBillContextForDivisions(mpVotes, readableDate);

            return {
                parliament_member_id: memberId,
                sitting_date: dateStr,
                activity_tag: mpVotes.length === 1 ? '1 Division Vote' : `${mpVotes.length} Division Votes`,
                hansard_ref: `Commons Votes ${dateStr}`,
                summary_para_1: `${mp.short_name} did not speak in the main Commons Chamber on ${readableDate}, but voted ${firstVote.mpVote} on ${firstVote.title}${extraText}.`,
                summary_para_2: billContext,
                verbatim_excerpt: null,
                glossary: [],
                votes: fullDayVotes
            };
        }

        // Deterministic zero-token summary for MPs with no recorded Chamber speech or vote
        return {
            parliament_member_id: memberId,
            sitting_date: dateStr,
            activity_tag: 'Constituency & Parliamentary Work',
            hansard_ref: `HC Deb ${dateStr}`,
            summary_para_1: `${mp.short_name} had no recorded spoken contributions or division votes in the House of Commons on ${readableDate}.`,
            summary_para_2: `MPs divide their week between main Chamber debates, private bill committees, ministerial correspondence, and constituency casework.`,
            verbatim_excerpt: null,
            glossary: [],
            votes: fullDayVotes
        };
    });

    // Upsert in chunks of 200 rows
    for (let i = 0; i < rowsToUpsert.length; i += 200) {
        const chunk = rowsToUpsert.slice(i, i + 200);
        const { error: upsertErr } = await supabase
            .from('daily_briefings')
            .upsert(chunk, { onConflict: 'parliament_member_id,sitting_date' });

        if (upsertErr) {
            throw new Error(`Upsert failed at batch ${i}: ${upsertErr.message}`);
        }
    }

    console.log(`[${new Date().toISOString()}] Successfully upserted ${rowsToUpsert.length} briefings for ${dateStr}.`);
}

generateBriefings();
