/**
 * Whip — Step 2: Daily Parliamentary Briefing Generator (`generate_briefings.js`)
 *
 * Fetches Hansard debates, Select Committee sessions, Written Parliamentary Questions
 * (both tabled by MPs and answered by Ministers), Commons Division votes, and GOV.UK
 * departmental announcements for a target sitting date, generates accessible multi-paragraph
 * plain-English briefings with verified verbatim Hansard quotes via Gemini, and upserts
 * them into Supabase (`daily_briefings`).
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const HANSARD_SEARCH_API = 'https://hansard-api.parliament.uk/search.json';
const COMMONS_VOTES_API = 'https://commonsvotes-api.parliament.uk/data/divisions.json/search';
const COMMONS_DIVISION_DETAIL_API = 'https://commonsvotes-api.parliament.uk/data/division';
const BILLS_SEARCH_API = 'https://bills-api.parliament.uk/api/v1/Bills';
const WRITTEN_QUESTIONS_API = 'https://writtenquestions-api.parliament.uk/api/writtenquestions/questions';
const COMMITTEES_EVENTS_API = 'https://committees-api.parliament.uk/api/Broadcast/Meetings';
const COMMITTEES_FALLBACK_API = 'https://committees-api.parliament.uk/api/Events';
const GOVUK_SEARCH_API = 'https://www.gov.uk/api/search.json';

const GEMINI_CONCURRENCY = 3;
const PRIMARY_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const FALLBACK_GEMINI_MODEL = 'gemini-3.8-flash';

const BRIEFING_RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
        activity_tag: { type: 'STRING' },
        summary_para_1: { type: 'STRING' },
        summary_para_2: { type: 'STRING' },
        glossary: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    term: { type: 'STRING' },
                    plain: { type: 'STRING' }
                },
                required: ['term', 'plain']
            }
        }
    },
    required: ['activity_tag', 'summary_para_1', 'summary_para_2', 'glossary']
};

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
const skipLlm = /^true$/i.test(cleanEnvValue(process.env.SKIP_LLM, 'SKIP_LLM'));
const forceRegen = /^true$/i.test(cleanEnvValue(process.env.FORCE_REGEN, 'FORCE_REGEN'));

if (!supabaseKey) {
    console.error('Missing SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const DEPARTMENT_MAP = [
    { match: /\bprime minister\b/i, slug: 'prime-ministers-office-10-downing-street', name: '10 Downing Street' },
    { match: /\b(exchequer|treasury)\b/i, slug: 'hm-treasury', name: 'HM Treasury' },
    { match: /\bhome department|home secretary|home office|policing|immigration|border security\b/i, slug: 'home-office', name: 'Home Office' },
    { match: /\bforeign, commonwealth|foreign secretary|development\b/i, slug: 'foreign-commonwealth-development-office', name: 'Foreign, Commonwealth & Development Office' },
    { match: /\bdefence\b/i, slug: 'ministry-of-defence', name: 'Ministry of Defence' },
    { match: /\bjustice|lord chancellor|prisons\b/i, slug: 'ministry-of-justice', name: 'Ministry of Justice' },
    { match: /\bhealth and social care|public health\b/i, slug: 'department-of-health-and-social-care', name: 'Department of Health and Social Care' },
    { match: /\beducation|skills|children\b/i, slug: 'department-for-education', name: 'Department for Education' },
    { match: /\benergy security|net zero\b/i, slug: 'department-for-energy-security-and-net-zero', name: 'Department for Energy Security and Net Zero' },
    { match: /\bwork and pensions|employment|social security\b/i, slug: 'department-for-work-and-pensions', name: 'Department for Work and Pensions' },
    { match: /\bbusiness and trade\b/i, slug: 'department-for-business-and-trade', name: 'Department for Business and Trade' },
    { match: /\bscience, innovation and technology\b/i, slug: 'department-for-science-innovation-and-technology', name: 'Department for Science, Innovation and Technology' },
    { match: /\btransport|aviation|rail|maritime|roads\b/i, slug: 'department-for-transport', name: 'Department for Transport' },
    { match: /\benvironment, food and rural affairs\b/i, slug: 'department-for-environment-food-rural-affairs', name: 'Department for Environment, Food & Rural Affairs' },
    { match: /\bhousing, communities and local government\b/i, slug: 'ministry-of-housing-communities-and-local-government', name: 'Ministry of Housing, Communities and Local Government' },
    { match: /\bculture, media and sport\b/i, slug: 'department-for-culture-media-and-sport', name: 'Department for Culture, Media and Sport' },
    { match: /\bscotland\b/i, slug: 'office-of-the-secretary-of-state-for-scotland', name: 'Scotland Office' },
    { match: /\bwales\b/i, slug: 'office-of-the-secretary-of-state-for-wales', name: 'Wales Office' },
    { match: /\bnorthern ireland\b/i, slug: 'northern-ireland-office', name: 'Northern Ireland Office' },
    { match: /\bcabinet office|duchy of lancaster\b/i, slug: 'cabinet-office', name: 'Cabinet Office' },
    { match: /\battorney general|solicitor general|advocate general\b/i, slug: 'attorney-generals-office', name: "Attorney General's Office" },
    { match: /\bleader of the house of commons\b/i, slug: 'office-of-the-leader-of-the-house-of-commons', name: 'Office of the Leader of the House of Commons' }
];

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isSinnFeinMp(mp) {
    return /^sinn\s*f[eé]in$/i.test(String(mp?.party || '').trim());
}

function isSpeakerOrDeputyMp(mp) {
    return /\b(speaker|chairman of ways and means|deputy chairman of ways and means)\b/i.test(String(mp?.role_title || ''));
}

function resolveGovernmentRole(mp) {
    if (!mp?.role_title || !mp.role_title.includes('• MP for ')) {
        return null;
    }
    const postTitle = mp.role_title.split('• MP for ')[0].trim();
    if (!postTitle) return null;

    const isWhip = /\b(whip|lord commissioner of hm treasury|treasurer of hm household|comptroller of hm household|vice-chamberlain of hm household)\b/i.test(postTitle);
    const dept = DEPARTMENT_MAP.find(d => d.match.test(postTitle)) || null;

    return {
        postTitle,
        deptSlug: dept?.slug || null,
        deptName: dept?.name || null,
        isWhip
    };
}

function getTargetDate() {
    const override = cleanEnvValue(process.env.TARGET_DATE, 'TARGET_DATE');
    if (/^\d{4}-\d{2}-\d{2}$/.test(override)) {
        return override;
    }

    const now = new Date();
    const londonToday = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/London',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(now);

    const d = new Date(`${londonToday}T12:00:00Z`);
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

function formatShortRefDate(isoDate) {
    const d = new Date(`${isoDate}T12:00:00Z`);
    return d.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
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
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

function splitCompleteSentences(text) {
    const clean = stripHtml(text);
    if (!clean) return [];

    const protectedText = clean
        .replace(/\b(Mr|Mrs|Ms|Mx|Dr|Prof|Hon|Rt Hon|St|No|Nos|Vol|Col|Cols|Fig|v)\./gi, '$1\u0000');

    const rawParts = protectedText.match(/[^.!?]+[.!?]+(?:["”'’)\]]+)?/g) || [];
    return rawParts
        .map(s => s.replace(/\u0000/g, '.').trim())
        .filter(s => s.length > 0 && /[.!?]["”'’)\]]*$/.test(s));
}

function isProceduralSentence(s) {
    return (
        s.length < 45 ||
        /^(I beg to move|I thank my|Mr Speaker|Madam Deputy Speaker|Mr Deputy Speaker|Order|Will the (right )?hon\.|On a point of order)/i.test(s) ||
        /\b(catch (his|her|your) eye|point of order|give way to (my|the) (right )?hon\.)\b/i.test(s)
    );
}

function extractCompleteVerbatimSentences(text, maxChars = 360, allowProceduralFallback = true) {
    const sentences = splitCompleteSentences(text);
    if (sentences.length === 0) return '';

    const substantiveStartIdx = sentences.findIndex(s => !isProceduralSentence(s));
    if (substantiveStartIdx < 0 && !allowProceduralFallback) {
        return '';
    }
    const startIdx = substantiveStartIdx >= 0 ? substantiveStartIdx : 0;

    let selected = sentences[startIdx];
    if (
        sentences[startIdx + 1] &&
        !isProceduralSentence(sentences[startIdx + 1]) &&
        selected.length < 180 &&
        selected.length + 1 + sentences[startIdx + 1].length <= maxChars
    ) {
        selected = `${selected} ${sentences[startIdx + 1]}`;
    }

    return selected;
}

function extractBestVerbatimQuote(speeches, maxChars = 360) {
    if (!Array.isArray(speeches) || speeches.length === 0) {
        return { quote: '', hrsRef: '' };
    }

    const ranked = [...speeches].sort((a, b) => b.text.length - a.text.length);

    for (const sp of ranked) {
        const substantive = extractCompleteVerbatimSentences(sp.text, maxChars, false);
        if (substantive) {
            return { quote: substantive, hrsRef: sp.hrsRef || '' };
        }
    }

    const fallbackQuote = extractCompleteVerbatimSentences(ranked[0].text, maxChars, true);
    return { quote: fallbackQuote, hrsRef: ranked[0].hrsRef || '' };
}

function normalizeForQuoteMatch(str) {
    return String(str || '')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function ensureVerbatimQuoteIntegrity(narrative, speeches, fallbackQuote) {
    const cleanNarrative = String(narrative || '').trim();
    if (!speeches || speeches.length === 0) return cleanNarrative;

    const fullTranscriptNorm = normalizeForQuoteMatch(speeches.map(s => s.text).join(' '));
    const quoteMatches = [...cleanNarrative.matchAll(/[“"]([^”"]+)[”"]/g)];

    if (quoteMatches.length > 0) {
        const allValid = quoteMatches.every(m => {
            const q = m[1].trim();
            const isCompleteSentence = /[.!?]$/.test(q) && !q.includes('...');
            const isExactSubstring = fullTranscriptNorm.includes(normalizeForQuoteMatch(q));
            return isCompleteSentence && isExactSubstring;
        });

        if (allValid) {
            return cleanNarrative;
        }

        const withoutBadQuotes = cleanNarrative
            .replace(/\s*[“"][^”"]+[”"]\s*/g, ' ')
            .replace(/\s+\./g, '.')
            .replace(/\s{2,}/g, ' ')
            .trim();

        return fallbackQuote
            ? `${withoutBadQuotes}\n\nIn the Chamber, they said: “${fallbackQuote}”`
            : withoutBadQuotes;
    }

    return fallbackQuote
        ? `${cleanNarrative}\n\nDuring the debate, they told the House: “${fallbackQuote}”`
        : cleanNarrative;
}

function attachMinisterialMeta(glossary, govRole, deptDigestCache) {
    if (!govRole) return glossary;
    const meta = {
        _type: 'ministerial_meta',
        postTitle: govRole.postTitle,
        deptSlug: govRole.deptSlug,
        deptName: govRole.deptName,
        isWhip: govRole.isWhip,
        deptDigest: govRole.deptSlug ? (deptDigestCache.get(govRole.deptSlug) || null) : null
    };
    const list = Array.isArray(glossary) ? [...glossary] : [];
    const idx = list.findIndex(g => g?._type === 'ministerial_meta');
    if (idx >= 0) list[idx] = meta;
    else list.unshift(meta);
    return list;
}

async function fetchJsonWithTimeout(url, timeoutMs = 20000) {
    const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return res.json();
}

async function fetchExistingBriefingsForDate(sittingDate, mpIds) {
    const existingByMpId = new Map();
    const chunkSize = 150;

    for (let i = 0; i < mpIds.length; i += chunkSize) {
        const chunk = mpIds.slice(i, i + chunkSize);
        const { data, error } = await supabase
            .from('daily_briefings')
            .select('parliament_member_id, activity_tag, summary_para_1, summary_para_2, verbatim_excerpt, glossary')
            .eq('sitting_date', sittingDate)
            .in('parliament_member_id', chunk);

        if (error) {
            console.warn(`Existing briefings lookup warning: ${error.message}`);
            continue;
        }

        for (const row of data || []) {
            if (row.summary_para_1 && String(row.summary_para_1).trim().length > 0) {
                existingByMpId.set(Number(row.parliament_member_id), row);
            }
        }
    }

    return existingByMpId;
}

async function fetchHansardContributionsForDate(dateStr) {
    const byMember = new Map();
    let skip = 0;
    const take = 100;

    while (true) {
        const url = new URL(HANSARD_SEARCH_API);
        url.searchParams.set('queryParameters.startDate', dateStr);
        url.searchParams.set('queryParameters.endDate', dateStr);
        url.searchParams.set('queryParameters.house', 'Commons');
        url.searchParams.set('queryParameters.skip', String(skip));
        url.searchParams.set('queryParameters.take', String(take));

        let data;
        try {
            data = await fetchJsonWithTimeout(url.toString(), 25000);
        } catch (err) {
            console.warn(`Hansard fetch warning at skip=${skip}: ${err.message}`);
            break;
        }

        const results = data?.Results || data?.Contributions || [];
        if (results.length === 0) break;

        for (const item of results) {
            const memberId = Number(item?.MemberId ?? item?.AttributedToMemberId);
            if (!memberId) continue;

            const debateTitle = stripHtml(item?.DebateSection || item?.Title || 'Commons Debate');
            const text = stripHtml(item?.Value || item?.ContributionText || '');
            const hrsRef = item?.HRSReference || item?.ExternalId || '';

            if (!text) continue;

            if (!byMember.has(memberId)) {
                byMember.set(memberId, []);
            }
            byMember.get(memberId).push({
                debateTitle,
                text,
                hrsRef
            });
        }

        skip += results.length;
        const total = data?.TotalContributions ?? data?.TotalResults ?? 0;
        if (skip >= total) break;
    }

    return byMember;
}

function extractBillBaseTitle(divisionTitle) {
    return String(divisionTitle || '')
        .replace(/[:\-\u2013\u2014]?\s*(?:Second Reading|Third Reading|Report Stage|Committee|Programme|Money|Carry-over|Consideration of Lords Amendments|New Clause\s+[A-Z0-9]+|New Schedule\s+[A-Z0-9]+|Amendment\s+[A-Z0-9]+).*$/i, '')
        .trim();
}

const billLookupCache = new Map();

async function fetchBillSummaryFromParliament(divisionTitle) {
    const cleanBill = extractBillBaseTitle(divisionTitle);
    if (!cleanBill || cleanBill.length < 4) return null;

    const cacheKey = cleanBill.toLowerCase();
    if (billLookupCache.has(cacheKey)) {
        return billLookupCache.get(cacheKey);
    }

    try {
        const searchUrl = new URL(BILLS_SEARCH_API);
        searchUrl.searchParams.set('SearchTerm', cleanBill);
        searchUrl.searchParams.set('Take', '5');

        const data = await fetchJsonWithTimeout(searchUrl.toString(), 12000);
        const items = Array.isArray(data?.items) ? data.items : [];

        const matched = items.find(it => {
            const apiTitle = stripHtml(it?.shortTitle || it?.title || '').toLowerCase();
            return apiTitle === cacheKey || apiTitle.includes(cacheKey) || cacheKey.includes(apiTitle);
        }) || null;

        if (!matched) {
            billLookupCache.set(cacheKey, null);
            return null;
        }

        const billId = Number(matched?.billId) || null;
        let detail = matched;

        // Fetch full bill record (/api/v1/Bills/{billId}) because search results often omit summary/longTitle
        if (billId) {
            try {
                const fullBill = await fetchJsonWithTimeout(`${BILLS_SEARCH_API}/${billId}`, 12000);
                if (fullBill && typeof fullBill === 'object') {
                    detail = { ...matched, ...fullBill };
                }
            } catch {}
        }

        const summary = stripHtml(detail?.summary || '');
        const longTitle = stripHtml(detail?.longTitle || '');
        const result = {
            billId,
            billSummary: summary || null,
            billAims: longTitle && longTitle !== summary ? longTitle : null
        };

        billLookupCache.set(cacheKey, result);
        return result;
    } catch {
        billLookupCache.set(cacheKey, null);
        return null;
    }
}

function buildDivisionExplainer(title, divisionId, billInfo = null) {
    const cleanTitle = (title || 'House of Commons Division').trim();
    const lower = cleanTitle.toLowerCase();
    const parliamentUrl = divisionId
        ? `https://votes.parliament.uk/votes/commons/division/${divisionId}`
        : 'https://votes.parliament.uk/';

    const billBase = extractBillBaseTitle(cleanTitle) || cleanTitle;

    let stageSummary = 'A formal House of Commons division on a legislative motion or proposed measure.';
    const clauseMatch = cleanTitle.match(/\b(New Clause|New Schedule|Amendment)\s+([A-Z0-9]+)/i);

    if (clauseMatch) {
        const label = `${clauseMatch[1]} ${clauseMatch[2]}`;
        stageSummary = `This vote was on ${label}, a proposed addition or amendment considered during Commons scrutiny of ${billBase}.`;
    } else if (lower.includes('second reading')) {
        stageSummary = `Second Reading is the first major House of Commons debate and vote on the general principles of a Bill before detailed line-by-line scrutiny.`;
    } else if (lower.includes('third reading')) {
        stageSummary = `Third Reading is the final House of Commons vote on a Bill's text before it progresses to the House of Lords.`;
    } else if (lower.includes('report stage')) {
        stageSummary = `Report stage is the House of Commons stage where MPs review a Bill as amended in committee and vote on further proposed changes.`;
    } else if (lower.includes('opposition day')) {
        stageSummary = `An Opposition Day debate and vote on a motion brought forward by the Official Opposition.`;
    } else if (lower.includes('regulations') || lower.includes('order')) {
        stageSummary = `A Commons vote on secondary legislation (a Statutory Instrument) proposed under powers in an existing Act of Parliament.`;
    }

    return {
        ...(billInfo?.billSummary ? { billSummary: billInfo.billSummary } : {}),
        ...(billInfo?.billAims ? { billAims: billInfo.billAims } : {}),
        stageSummary,
        parliamentUrl
    };
}

async function fetchDivisionsForDate(dateStr) {
    const url = new URL(COMMONS_VOTES_API);
    url.searchParams.set('queryParameters.startDate', dateStr);
    url.searchParams.set('queryParameters.endDate', dateStr);
    url.searchParams.set('queryParameters.take', '50');

    let summaries = [];
    try {
        const data = await fetchJsonWithTimeout(url.toString(), 20000);
        summaries = Array.isArray(data) ? data : (data?.items || []);
    } catch (err) {
        console.warn(`Commons Votes search warning: ${err.message}`);
        return [];
    }

    const detailedDivisions = [];
    for (const div of summaries) {
        const divId = Number(div?.DivisionId);
        if (!divId) continue;

        try {
            const detail = await fetchJsonWithTimeout(`${COMMONS_DIVISION_DETAIL_API}/${divId}.json`, 20000);
            const ayeIds = new Set([
                ...(detail?.Ayes || []).map(m => Number(m.MemberId)),
                ...(detail?.AyeTellers || []).map(m => Number(m.MemberId))
            ]);
            const noIds = new Set([
                ...(detail?.Noes || []).map(m => Number(m.MemberId)),
                ...(detail?.NoTellers || []).map(m => Number(m.MemberId))
            ]);

            const ayeCount = Number(detail?.AyeCount ?? ayeIds.size);
            const noCount = Number(detail?.NoCount ?? noIds.size);
            const title = stripHtml(detail?.Title || div?.Title || `Division #${divId}`);
            const billInfo = await fetchBillSummaryFromParliament(title);

            detailedDivisions.push({
                divisionId: divId,
                title,
                houseResult: `Ayes ${ayeCount} – Noes ${noCount}`,
                ayeIds,
                noIds,
                explainer: buildDivisionExplainer(title, divId, billInfo)
            });
        } catch (err) {
            console.warn(`Division ${divId} detail warning: ${err.message}`);
        }
    }

    return detailedDivisions;
}

async function fetchWrittenQuestionsPage(params) {
    const items = [];
    let skip = 0;
    const take = 100;

    while (true) {
        const url = new URL(WRITTEN_QUESTIONS_API);
        for (const [k, v] of Object.entries(params)) {
            url.searchParams.set(k, String(v));
        }
        url.searchParams.set('house', 'Commons');
        url.searchParams.set('skip', String(skip));
        url.searchParams.set('take', String(take));

        let data = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                data = await fetchJsonWithTimeout(url.toString(), 45000);
                break;
            } catch (err) {
                if (attempt === 2) {
                    console.warn(`Written Questions fetch warning at skip=${skip}: ${err.message}`);
                } else {
                    await sleep(1200);
                }
            }
        }

        if (!data) break;

        const results = data?.results || data?.Results || [];
        if (results.length === 0) break;

        items.push(...results);
        skip += results.length;
        const total = data?.totalResults ?? data?.TotalResults ?? 0;
        if (skip >= total) break;
    }

    return items;
}

async function fetchWrittenQuestionsForDate(dateStr) {
    const byMember = new Map();

    const tabledItems = await fetchWrittenQuestionsPage({ tabledWhenFrom: dateStr, tabledWhenTo: dateStr });
    const answeredItems = await fetchWrittenQuestionsPage({ answeredWhenFrom: dateStr, answeredWhenTo: dateStr });

    const seenKeys = new Set();

    function pushQuestionRecord(memberId, direction, record) {
        if (!memberId) return;
        const dedupeKey = `${memberId}|${direction}|${record.id || record.uin}`;
        if (seenKeys.has(dedupeKey)) return;
        seenKeys.add(dedupeKey);

        if (!byMember.has(memberId)) {
            byMember.set(memberId, []);
        }
        byMember.get(memberId).push({ direction, ...record });
    }

    for (const item of tabledItems) {
        const val = item?.value || item;
        const askingMemberId = Number(val?.askingMemberId ?? val?.AskingMemberId);
        const uin = val?.uin ?? val?.Uin ?? '';
        const tabledDate = val?.dateTabled ? String(val.dateTabled).slice(0, 10) : dateStr;
        const department = val?.answeringBodyName ?? val?.answeringBody?.name ?? 'Government Department';
        const heading = stripHtml(val?.heading ?? 'Written Parliamentary Question');
        const questionText = stripHtml(val?.questionText ?? '');
        const answerText = stripHtml(val?.answerText ?? '');

        pushQuestionRecord(askingMemberId, 'asked', {
            id: val?.id,
            uin,
            department,
            heading,
            questionText: extractCompleteVerbatimSentences(questionText, 480) || questionText,
            answerText: answerText ? (extractCompleteVerbatimSentences(answerText, 620) || answerText) : null,
            dateAnswered: val?.dateAnswered ? String(val.dateAnswered).slice(0, 10) : null,
            url: uin
                ? `https://questions-statements.parliament.uk/written-questions/detail/${tabledDate}/${encodeURIComponent(uin)}`
                : 'https://questions-statements.parliament.uk/'
        });
    }

    for (const item of answeredItems) {
        const val = item?.value || item;
        const answeringMemberId = Number(val?.answeringMemberId ?? val?.AnsweringMemberId);
        const uin = val?.uin ?? val?.Uin ?? '';
        const tabledDate = val?.dateTabled ? String(val.dateTabled).slice(0, 10) : dateStr;
        const department = val?.answeringBodyName ?? val?.answeringBody?.name ?? 'Government Department';
        const askingMemberName = stripHtml(val?.askingMember?.nameDisplayAs ?? val?.askingMemberName ?? 'an MP');
        const heading = stripHtml(val?.heading ?? 'Written Parliamentary Question');
        const questionText = stripHtml(val?.questionText ?? '');
        const answerText = stripHtml(val?.answerText ?? '');

        pushQuestionRecord(answeringMemberId, 'answered', {
            id: val?.id,
            uin,
            department,
            askingMemberName,
            heading,
            questionText: extractCompleteVerbatimSentences(questionText, 400) || questionText,
            answerText: answerText ? (extractCompleteVerbatimSentences(answerText, 620) || answerText) : null,
            dateAnswered: val?.dateAnswered ? String(val.dateAnswered).slice(0, 10) : dateStr,
            url: uin
                ? `https://questions-statements.parliament.uk/written-questions/detail/${tabledDate}/${encodeURIComponent(uin)}`
                : 'https://questions-statements.parliament.uk/'
        });
    }

    return byMember;
}

async function fetchCommitteeSessionsForDate(dateStr) {
    const byMember = new Map();
    const startIso = `${dateStr}T00:00:00Z`;
    const endIso = `${dateStr}T23:59:59Z`;

    let meetings = [];
    try {
        const broadcastUrl = new URL(COMMITTEES_EVENTS_API);
        broadcastUrl.searchParams.set('StartDate', startIso);
        broadcastUrl.searchParams.set('EndDate', endIso);
        const data = await fetchJsonWithTimeout(broadcastUrl.toString(), 20000);
        meetings = Array.isArray(data) ? data : (data?.items || data?.value || []);
    } catch (err) {
        console.warn(`Committees Broadcast warning (${dateStr}): ${err.message}`);
        try {
            const eventsUrl = new URL(COMMITTEES_FALLBACK_API);
            eventsUrl.searchParams.set('StartDate', dateStr);
            eventsUrl.searchParams.set('EndDate', dateStr);
            const fallbackData = await fetchJsonWithTimeout(eventsUrl.toString(), 20000);
            meetings = Array.isArray(fallbackData) ? fallbackData : (fallbackData?.items || fallbackData?.value || []);
        } catch (fallbackErr) {
            console.
