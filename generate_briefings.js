/**
 * Whip — Step 2: Daily Parliamentary Briefing Generator (`generate_briefings.js`)
 *
 * Fetches House of Commons Hansard speeches, Select/Bill Committee appearances
 * (via Events, Attendance, and Activities endpoints), Written Parliamentary Questions,
 * and Commons Division votes for a target sitting date, generates plain-English
 * neutral summaries via Gemini, enriches voting-only context with UK Parliament
 * Bills API details, and upserts into `daily_briefings`.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const HANSARD_SEARCH_API = 'https://hansard-api.parliament.uk/search/contributions/Spoken.json';
const HANSARD_SECTIONS_API = 'https://hansard-api.parliament.uk/overview/sectionsforday.json';
const HANSARD_DEBATE_API = 'https://hansard-api.parliament.uk/debates/debate';
const COMMONS_VOTES_API = 'https://commonsvotes-api.parliament.uk/data/divisions.json/search';
const COMMONS_DIVISION_DETAIL_API = 'https://commonsvotes-api.parliament.uk/data/division';
const COMMITTEES_EVENTS_API = 'https://committees-api.parliament.uk/api/Events';
const WRITTEN_QUESTIONS_API = 'https://writtenquestions-api.parliament.uk/api/writtenquestions/questions';
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
    const arg = process.argv.find(a => a.startsWith('--date='));
    if (arg) {
        const val = arg.split('=')[1]?.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
    }
    const envDate = cleanEnvValue(process.env.TARGET_DATE, 'TARGET_DATE');
    if (/^\d{4}-\d{2}-\d{2}$/.test(envDate)) return envDate;

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

function extractCleanExcerpt(text, maxChars = 600) {
    const clean = stripHtml(text);
    if (!clean) return null;
    if (clean.length <= maxChars) return clean;

    const window = clean.slice(0, maxChars);
    const lastSentenceEnd = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('? '),
        window.lastIndexOf('! ')
    );
    if (lastSentenceEnd > 120) {
        return window.slice(0, lastSentenceEnd + 1).trim();
    }

    const lastSpace = window.lastIndexOf(' ');
    return `${(lastSpace > 80 ? window.slice(0, lastSpace) : window).trim()}…`;
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
    for (const item of items || []) {
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

async function querySpokenSearchVariant(dateStr, usePrefix, byMember) {
    let skip = 0;
    const take = 100;

    while (true) {
        const url = new URL(HANSARD_SEARCH_API);
        if (usePrefix) {
            url.searchParams.set('queryParameters.house', 'Commons');
            url.searchParams.set('queryParameters.startDate', dateStr);
            url.searchParams.set('queryParameters.endDate', dateStr);
            url.searchParams.set('queryParameters.skip', String(skip));
            url.searchParams.set('queryParameters.take', String(take));
        } else {
            url.searchParams.set('house', 'Commons');
            url.searchParams.set('startDate', dateStr);
            url.searchParams.set('endDate', dateStr);
            url.searchParams.set('skip', String(skip));
            url.searchParams.set('take', String(take));
        }

        const data = await fetchJsonWithTimeout(url.toString(), 20000);
        const results = data?.Results || data?.results || [];
        if (results.length === 0) break;

        extractSpeechRecordsFromItems(results, byMember);

        skip += results.length;
        const total = data?.TotalResultCount ?? data?.totalResultCount ?? 0;
        if (skip >= total) break;
    }
}

async function fetchHansardViaDebateTrees(dateStr, byMember) {
    const sectionTrees = [];
    for (const sec of ['Commons', 'WestminsterHall']) {
        for (const paramName of ['section', 'house']) {
            try {
                const url = new URL(HANSARD_SECTIONS_API);
                url.searchParams.set('date', dateStr);
                url.searchParams.set(paramName, sec);
                const data = await fetchJsonWithTimeout(url.toString(), 15000);
                if (Array.isArray(data) && data.length > 0) {
                    sectionTrees.push(...data);
                    break;
                }
            } catch {}
        }
    }

    const debateIds = new Set();
    function collectDebateIds(nodes) {
        for (const node of nodes || []) {
            const id = node.ExternalId || node.externalId || node.DebateSectionExtId || node.Id || node.id;
            const children = node.ChildSections || node.childSections || node.SubSections || [];
            if (id) {
                debateIds.add(String(id));
            }
            if (children.length > 0) {
                collectDebateIds(children);
            }
        }
    }
    collectDebateIds(sectionTrees);

    for (const extId of debateIds) {
        try {
            const debate = await fetchJsonWithTimeout(`${HANSARD_DEBATE_API}/${encodeURIComponent(extId)}.json`, 15000);
            const title = debate?.Overview?.Title || debate?.Title || 'Commons Debate';
            const items = debate?.Items || debate?.items || [];
            extractSpeechRecordsFromItems(items, byMember, title);
        } catch {}
    }
}

async function fetchHansardContributions(dateStr) {
    const byMember = new Map();

    try {
        await querySpokenSearchVariant(dateStr, true, byMember);
    } catch {}

    if (byMember.size === 0) {
        try {
            await querySpokenSearchVariant(dateStr, false, byMember);
        } catch {}
    }

    if (byMember.size === 0) {
        await fetchHansardViaDebateTrees(dateStr, byMember);
    }

    return byMember;
}

async function fetchWrittenQuestionsForDate(dateStr) {
    const byMember = new Map();
    let skip = 0;
    const take = 100;

    while (true) {
        const url = new URL(WRITTEN_QUESTIONS_API);
        url.searchParams.set('tabledWhenFrom', dateStr);
        url.searchParams.set('tabledWhenTo', dateStr);
        url.searchParams.set('house', 'Commons');
        url.searchParams.set('skip', String(skip));
        url.searchParams.set('take', String(take));

        let data;
        try {
            data = await fetchJsonWithTimeout(url.toString(), 15000);
        } catch (err) {
            console.warn(`Written Questions fetch warning at skip=${skip}: ${err.message}`);
            break;
        }

        const results = data?.results || data?.Results || [];
        if (results.length === 0) break;

        for (const item of results) {
            const val = item?.value || item;
            const memberId = Number(val?.askingMemberId ?? val?.AskingMemberId);
            if (!memberId) continue;

            const questionId = val?.id ?? val?.Id;
            const uin = val?.uin ?? val?.Uin ?? '';
            const department =
                val?.answeringBodyName ??
                val?.AnsweringBodyName ??
                val?.answeringBody?.name ??
                'Government Department';
            const heading = stripHtml(val?.heading ?? val?.Heading ?? 'Written Parliamentary Question');
            const questionText = stripHtml(val?.questionText ?? val?.QuestionText ?? '');
            const answerText = stripHtml(val?.answerText ?? val?.AnswerText ?? '');
            const dateAnswered = val?.dateAnswered
                ? String(val.dateAnswered).slice(0, 10)
                : null;

            if (!byMember.has(memberId)) {
                byMember.set(memberId, []);
            }
            byMember.get(memberId).push({
                id: questionId,
                uin,
                department,
                heading,
                questionText: extractCleanExcerpt(questionText, 500) || questionText,
                answerText: answerText ? (extractCleanExcerpt(answerText, 650) || answerText) : null,
                dateAnswered,
                url: uin
                    ? `https://questions-statements.parliament.uk/written-questions/detail/${dateStr}/${encodeURIComponent(uin)}`
                    : 'https://questions-statements.parliament.uk/'
            });
        }

        skip += results.length;
        const total = data?.totalResults ?? data?.TotalResults ?? 0;
        if (skip >= total) break;
    }

    return byMember;
}

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

function addCommitteeRecord(byMember, memberId, session) {
    if (!memberId) return;
    if (!byMember.has(memberId)) {
        byMember.set(memberId, []);
    }
    const existing = byMember.get(memberId);
    const key = `${session.eventId || ''}|${session.committeeName}|${session.role}`;
    if (!existing.some(s => `${s.eventId || ''}|${s.committeeName}|${s.role}` === key)) {
        existing.push(session);
    }
}

async function fetchCommitteeAppearances(dateStr) {
    const byMember = new Map();

    let events = [];
    try {
        const url = new URL(COMMITTEES_EVENTS_API);
        url.searchParams.set('StartDateFrom', dateStr);
        url.searchParams.set('StartDateTo', dateStr);
        url.searchParams.set('ExcludeCancelledEvents', 'true');
        url.searchParams.set('Take', '100');

        const data = await fetchJsonWithTimeout(url.toString(), 15000);
        events = Array.isArray(data) ? data : (data?.items || data?.Items || []);
    } catch (err) {
        console.warn(`Committees Events list warning: ${err.message}`);
        return byMember;
    }

    await mapWithConcurrency(events, 6, async (ev) => {
        const eventId = ev?.id ?? ev?.Id;
        if (!eventId) return;

        const [detailData, attendanceData, activitiesData] = await Promise.all([
            fetchJsonWithTimeout(`${COMMITTEES_EVENTS_API}/${eventId}`, 12000).catch(() => null),
            fetchJsonWithTimeout(`${COMMITTEES_EVENTS_API}/${eventId}/Attendance`, 12000).catch(() => null),
            fetchJsonWithTimeout(`${COMMITTEES_EVENTS_API}/${eventId}/Activities`, 12000).catch(() => null)
        ]);

        const detail = detailData?.value || detailData || ev;
        const committeeName =
            detail?.committees?.[0]?.name ??
            detail?.committee?.name ??
            ev?.committees?.[0]?.name ??
            detail?.title ??
            'Select Committee';
        const title = stripHtml(detail?.title ?? ev?.title ?? committeeName);
        const topic = stripHtml(detail?.description ?? ev?.description ?? title);
        const sessionUrl = `https://committees.parliament.uk/event/${eventId}/`;

        const extractMemberId = (obj) => Number(
            obj?.memberId ??
            obj?.MemberId ??
            obj?.member?.id ??
            obj?.member?.memberId ??
            obj?.id
        );

        // 1. Committee members attending
        const rawAttendees = [
            ...(Array.isArray(attendanceData) ? attendanceData : (attendanceData?.attendees || attendanceData?.members || attendanceData?.committeeMembers || attendanceData?.items || [])),
            ...(Array.isArray(detail?.attendees) ? detail.attendees : []),
            ...(Array.isArray(detail?.committeeMembers) ? detail.committeeMembers : [])
        ];

        for (const person of rawAttendees) {
            const mId = extractMemberId(person);
            if (!mId) continue;
            addCommitteeRecord(byMember, mId, {
                eventId,
                committeeName,
                title,
                topic: extractCleanExcerpt(topic, 260) || topic,
                role: 'Committee Member',
                url: sessionUrl
            });
        }

        // 2. Oral evidence witnesses
        const rawActivities = [
            ...(Array.isArray(activitiesData) ? activitiesData : (activitiesData?.activities || activitiesData?.items || [])),
            ...(Array.isArray(detail?.activities) ? detail.activities : [])
        ];

        for (const act of rawActivities) {
            const actTitle = stripHtml(act?.title || act?.name || title) || title;
            const witnesses = [
                ...(Array.isArray(act?.witnesses) ? act.witnesses : []),
                ...(Array.isArray(act?.oralEvidenceWitnesses) ? act.oralEvidenceWitnesses : [])
            ];
            for (const w of witnesses) {
                const mId = extractMemberId(w);
                if (!mId) continue;
                addCommitteeRecord(byMember, mId, {
                    eventId,
                    committeeName,
                    title: actTitle,
                    topic: extractCleanExcerpt(topic, 260) || topic,
                    role: 'Oral Evidence Witness',
                    url: sessionUrl
                });
            }
        }
    });

    console.log(`Committees API scanned ${events.length} events on ${dateStr} -> matched ${byMember.size} MPs.`);
    return byMember;
}

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
let workingGeminiModel = null;

async function callGeminiApi(prompt) {
    const candidates = workingGeminiModel ? [workingGeminiModel] : GEMINI_MODELS;
    let lastError = null;

    for (const model of candidates) {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
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

        if (res.ok) {
            workingGeminiModel = model;
            return res.json();
        }

        const errBody = await res.text().catch(() => '');
        lastError = new Error(`Gemini (${model}) HTTP ${res.status}: ${errBody.slice(0, 120)}`);
        if (res.status !== 404) {
            throw lastError;
        }
    }

    throw lastError || new Error('No working Gemini model found');
}

async function summarizeWithGemini(mp, dateStr, speeches, committees, writtenQuestions, votes) {
    const speechDigest = speeches
        .slice(0, 8)
        .map(s => `- Debate: "${s.debateTitle}" | Excerpt: ${s.text.slice(0, 900)}`)
        .join('\n');

    const committeeDigest = committees
        .map(c => `- Committee: ${c.committeeName} (${c.role}) | Session: ${c.title} | Topic: ${c.topic.slice(0, 250)}`)
        .join('\n');

    const wqDigest = writtenQuestions
        .slice(0, 8)
        .map(q => `- To ${q.department} (${q.heading}): "${q.questionText.slice(0, 350)}"`)
        .join('\n');

    const voteDigest = votes
        .map(v => `- ${v.title}: Voted ${v.mpVote} (${v.houseResult})`)
        .join('\n');

    const spokeInChamber = speeches.length > 0;

    const prompt = `You are a strictly neutral, non-partisan UK parliamentary reporter writing for Whip (whipdaily.uk).
Summarize what ${mp.full_name} (${mp.party}, MP for ${mp.constituencies?.name || 'UK'}) did in Parliament on ${formatReadableDate(dateStr)} in plain, accessible British English.

Rules:
- Be strictly factual, calm, and neutral. Never take a political stance or editorialize.
- ${spokeInChamber ? `Describe what ${mp.short_name} said in the Chamber, any committee work, and any written questions or votes.` : `Note clearly that ${mp.short_name} did not speak in the main Commons Chamber that day, and highlight any committee work (noting whether as a committee member or giving oral evidence), Written Parliamentary Questions tabled (naming the departments and specific issues), and any division votes.`}
- Return valid JSON only with keys: "activity_tag", "summary_para_1", "summary_para_2", "verbatim_excerpt", "glossary".
- "activity_tag": short label (e.g., "Prime Minister's Questions", "Chamber Debate & Votes", "Select Committee", "Written Questions & Votes", "Written Questions").
- "summary_para_1": 2–3 clear sentences describing specifically what ${mp.short_name} asked, tabled, scrutinized, or attended.
- "summary_para_2": 2–3 sentences explaining the wider policy, local constituency, or legislative context in plain English for an everyday voter.
- "verbatim_excerpt": a single direct, representative sentence quoted verbatim from their spoken contribution (or null if they had no spoken contribution).
- "glossary": array of 0–2 objects {"term": "...", "plain": "..."} explaining any parliamentary jargon mentioned.

Evidence from ${dateStr}:
${speechDigest ? `Spoken Contributions:\n${speechDigest}\n` : ''}
${committeeDigest ? `Committee Work:\n${committeeDigest}\n` : ''}
${wqDigest ? `Written Parliamentary Questions Tabled:\n${wqDigest}\n` : ''}
${voteDigest ? `Division Votes:\n${voteDigest}\n` : ''}`;

    const payload = await callGeminiApi(prompt);
    const rawText = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(rawText);

    return {
        activity_tag: parsed.activity_tag || (spokeInChamber ? 'Chamber Debate' : (committees.length > 0 ? 'Select Committee' : 'Written Questions')),
        summary_para_1: parsed.summary_para_1 || `${mp.short_name} participated in House of Commons proceedings on ${formatReadableDate(dateStr)}.`,
        summary_para_2: parsed.summary_para_2 || `Written Parliamentary Questions require government departments to place formal, on-the-record answers before Parliament within a set timeframe.`,
        verbatim_excerpt: spokeInChamber
            ? (parsed.verbatim_excerpt || extractCleanExcerpt(speeches[0]?.text, 600))
            : null,
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

    const [speechesByMember, { divisions, votesByMember }, committeesByMember, wqByMember] = await Promise.all([
        fetchHansardContributions(dateStr),
        fetchDivisionVotes(dateStr),
        fetchCommitteeAppearances(dateStr),
        fetchWrittenQuestionsForDate(dateStr)
    ]);

    const isNonSittingDay =
        speechesByMember.size === 0 &&
        divisions.length === 0 &&
        committeesByMember.size === 0 &&
        wqByMember.size === 0;

    console.log(
        `Evidence for ${dateStr}: ${speechesByMember.size} MPs spoke, ` +
        `${divisions.length} divisions, ${committeesByMember.size} committee participants, ` +
        `${wqByMember.size} MPs tabled written questions.`
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
        const writtenQuestions = wqByMember.get(memberId) || [];

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
                summary_para_2: `During weekends, recess, and non-sitting Fridays, MPs typically return to their constituencies rather than debating in the Westminster Chamber.`,
                verbatim_excerpt: null,
                glossary: [],
                committee_sessions: [],
                votes: [],
                written_questions: []
            };
        }

        if (speeches.length > 0 || committees.length > 0 || writtenQuestions.length > 0) {
            try {
                const ai = await summarizeWithGemini(mp, dateStr, speeches, committees, writtenQuestions, mpVotes);
                const hansardRef = speeches[0]?.debateTitle
                    ? `HC Deb ${dateStr} — ${speeches[0].debateTitle}`
                    : (committees.length > 0
                        ? `Commons Committees ${dateStr}`
                        : `Written Questions ${dateStr}`);

                return {
                    parliament_member_id: memberId,
                    sitting_date: dateStr,
                    activity_tag: ai.activity_tag,
                    hansard_ref: hansardRef,
                    summary_para_1: ai.summary_para_1,
                    summary_para_2: ai.summary_para_2,
                    verbatim_excerpt: ai.verbatim_excerpt,
                    glossary: ai.glossary,
                    committee_sessions: committees,
                    votes: fullDayVotes,
                    written_questions: writtenQuestions
                };
            } catch (err) {
                console.warn(`Gemini fallback for ${mp.short_name} (${memberId}): ${err.message}`);

                if (speeches.length > 0 || committees.length > 0) {
                    const uniqueDebates = [...new Set(speeches.map(s => s.debateTitle))].filter(Boolean);
                    const debateList = uniqueDebates.slice(0, 3).join(', ');
                    const voteClause = mpVotes.length > 0
                        ? ` and cast ${mpVotes.length} recorded division ${mpVotes.length === 1 ? 'vote' : 'votes'}`
                        : '';

                    return {
                        parliament_member_id: memberId,
                        sitting_date: dateStr,
                        activity_tag: speeches.length > 0 ? 'Chamber Debate' : 'Select Committee',
                        hansard_ref: speeches[0]?.debateTitle
                            ? `HC Deb ${dateStr} — ${speeches[0].debateTitle}`
                            : `Commons Committees ${dateStr}`,
                        summary_para_1: speeches.length > 0
                            ? `${mp.short_name} spoke in the House of Commons on ${readableDate} during ${debateList}${voteClause}.`
                            : `${mp.short_name} took part in ${committees[0]?.committeeName || 'Select Committee'} proceedings on ${readableDate}${voteClause}.`,
                        summary_para_2: (await getBillContextForDivisions(mpVotes, readableDate)) || `Full verbatim contributions from ${debateList || 'this session'} are recorded in Hansard on parliament.uk.`,
                        verbatim_excerpt: extractCleanExcerpt(speeches[0]?.text, 600),
                        glossary: [],
                        committee_sessions: committees,
                        votes: fullDayVotes,
                        written_questions: writtenQuestions
                    };
                }

                const depts = [...new Set(writtenQuestions.map(q => q.department))];
                const topics = [...new Set(writtenQuestions.map(q => q.heading))].slice(0, 3);
                const voteClause = mpVotes.length > 0
                    ? `, alongside casting ${mpVotes.length} recorded division ${mpVotes.length === 1 ? 'vote' : 'votes'}`
                    : '';

                return {
                    parliament_member_id: memberId,
                    sitting_date: dateStr,
                    activity_tag: writtenQuestions.length === 1 ? '1 Written Question' : `${writtenQuestions.length} Written Questions`,
                    hansard_ref: `Written Questions ${dateStr}`,
                    summary_para_1: `${mp.short_name} did not speak in the main Commons Chamber on ${readableDate}, but tabled ${writtenQuestions.length} written ${writtenQuestions.length === 1 ? 'question' : 'questions'} to ${depts.slice(0, 2).join(' and ')} regarding ${topics.join(', ')}${voteClause}.`,
                    summary_para_2: (await getBillContextForDivisions(mpVotes, readableDate)) || `Written Parliamentary Questions allow backbench MPs to press ministers for detailed data and policy commitments on constituency and national issues.`,
                    verbatim_excerpt: null,
                    glossary: [],
                    committee_sessions: committees,
                    votes: fullDayVotes,
                    written_questions: writtenQuestions
                };
            }
        }

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
                committee_sessions: [],
                votes: fullDayVotes,
                written_questions: []
            };
        }

        return {
            parliament_member_id: memberId,
            sitting_date: dateStr,
            activity_tag: 'Constituency & Parliamentary Work',
            hansard_ref: `HC Deb ${dateStr}`,
            summary_para_1: `${mp.short_name} had no recorded spoken contributions, committee sessions, written questions, or division votes in the House of Commons on ${readableDate}.`,
            summary_para_2: `MPs divide their week between main Chamber debates, private bill committees, ministerial correspondence, and constituency casework.`,
            verbatim_excerpt: null,
            glossary: [],
            committee_sessions: [],
            votes: fullDayVotes,
            written_questions: []
        };
    });

    for (let i = 0; i < rowsToUpsert.length; i += 200) {
        const chunk = rowsToUpsert.slice(i, i + 200);
        const { error: upsertErr } = await supabase
            .from('daily_briefings')
            .upsert(chunk, { onConflict: 'parliament_member_id,sitting_date' });

        if (upsertErr) {
            throw new Error(`Upsert failed at batch ${i}: ${upsertErr.message}`);
        }
    }

    if (workingGeminiModel) {
        console.log(`Gemini model used: ${workingGeminiModel}`);
    }
    console.log(`[${new Date().toISOString()}] Successfully upserted ${rowsToUpsert.length} briefings for ${dateStr}.`);
}

generateBriefings();
