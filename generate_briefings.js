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

const GEMINI_CONCURRENCY = 5;

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

const billLookupCache = new Map();

async function fetchBillSummaryFromParliament(billTitle) {
    const cleanBill = String(billTitle || '')
        .replace(/:\s*(Second Reading|Third Reading|Report Stage|Committee|Programme|Money).*$/i, '')
        .trim();
    if (!cleanBill || cleanBill.length < 4) return null;

    const cacheKey = cleanBill.toLowerCase();
    if (billLookupCache.has(cacheKey)) {
        return billLookupCache.get(cacheKey);
    }

    try {
        const url = new URL(BILLS_SEARCH_API);
        url.searchParams.set('SearchTerm', cleanBill);
        url.searchParams.set('Take', '5');

        const data = await fetchJsonWithTimeout(url.toString(), 12000);
        const items = Array.isArray(data?.items) ? data.items : [];

        const matched = items.find(it => {
            const apiTitle = stripHtml(it?.title || '').toLowerCase();
            return apiTitle === cacheKey || apiTitle.includes(cacheKey) || cacheKey.includes(apiTitle);
        }) || null;

        if (!matched) {
            billLookupCache.set(cacheKey, null);
            return null;
        }

        const summary = stripHtml(matched?.summary || '');
        const longTitle = stripHtml(matched?.longTitle || '');
        const result = {
            billId: matched?.billId || null,
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

    const billBase = cleanTitle
        .replace(/:\s*(Second Reading|Third Reading|Report Stage|Committee|Programme|Money).*$/i, '')
        .trim();

    let stageObj;
    const clauseMatch = cleanTitle.match(/\b(New Clause|New Schedule|Amendment)\s+([A-Z0-9]+)/i);
    if (clauseMatch) {
        const label = `${clauseMatch[1]} ${clauseMatch[2]}`;
        stageObj = {
            whatItDoes: `${label} was a proposed addition or amendment to ${billBase} debated during its Commons scrutiny.`,
            whatAyeMeans: `Supported adding ${label} into ${billBase}.`,
            whatNoMeans: `Voted against adding ${label} to the Bill.`
        };
    } else if (lower.includes('second reading')) {
        stageObj = {
            whatItDoes: `Second Reading is the first major Commons vote on the core principles of ${billBase}.`,
            whatAyeMeans: `Supported the general principles of ${billBase} so it could advance to detailed line-by-line scrutiny.`,
            whatNoMeans: `Opposed ${billBase} progressing further in the House of Commons.`
        };
    } else if (lower.includes('third reading')) {
        stageObj = {
            whatItDoes: `Third Reading is the final Commons vote on the amended text of ${billBase} before it moves to the House of Lords.`,
            whatAyeMeans: `Approved the final Commons version of ${billBase}.`,
            whatNoMeans: `Voted to reject the final Commons version of ${billBase}.`
        };
    } else if (lower.includes('opposition day')) {
        const topic = cleanTitle.replace(/^Opposition [Dd]ay:\s*/i, '').replace(/:\s*Opposition motion$/i, '').trim();
        stageObj = {
            whatItDoes: `An Opposition Day motion putting forward a policy position or call to action on ${topic || 'a chosen policy topic'}.`,
            whatAyeMeans: `Backed the Opposition motion on ${topic || 'the debate topic'}.`,
            whatNoMeans: `Voted against the Opposition motion.`
        };
    } else if (lower.includes('regulations') || lower.includes('order')) {
        stageObj = {
            whatItDoes: `${cleanTitle} is secondary legislation (a Statutory Instrument) brought forward by ministers under powers granted by an existing Act of Parliament.`,
            whatAyeMeans: `Approved the regulations or order so they can take legal effect.`,
            whatNoMeans: `Voted to reject the regulations or order.`
        };
    } else {
        stageObj = {
            whatItDoes: `${cleanTitle} was put to a formal House of Commons division to test MPs' support for the proposed measure or motion.`,
            whatAyeMeans: `Supported the motion or legislative proposal.`,
            whatNoMeans: `Opposed the motion or legislative proposal.`
        };
    }

    return {
        ...stageObj,
        ...(billInfo?.billSummary ? { billSummary: billInfo.billSummary } : {}),
        ...(billInfo?.billAims ? { billAims: billInfo.billAims } : {}),
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
            console.warn(`Committees Events fallback warning (${dateStr}): ${fallbackErr.message}`);
            return byMember;
        }
    }

    for (const meeting of meetings) {
        const m = meeting?.value || meeting;
        const committeeName = stripHtml(
            (Array.isArray(m?.committees) && m.committees[0]?.name) ||
            m?.committee?.name ||
            m?.committeeName ||
            'Select Committee'
        );
        const title = stripHtml(m?.title || m?.subject || committeeName);
        const eventId = m?.id || m?.eventId;
        const eventUrl = eventId
            ? `https://committees.parliament.uk/event/${eventId}/formal-meeting-oral-evidence-session/`
            : 'https://committees.parliament.uk/';

        const attendees = Array.isArray(m?.attendees) ? m.attendees : [];
        for (const att of attendees) {
            const memberId = Number(att?.memberId ?? att?.member?.id);
            if (!memberId) continue;
            if (!byMember.has(memberId)) byMember.set(memberId, []);
            byMember.get(memberId).push({
                committeeName,
                title,
                topic: title,
                role: att?.role || 'Committee Member',
                url: eventUrl
            });
        }

        const activities = Array.isArray(m?.activities) ? m.activities : [];
        for (const act of activities) {
            const witnesses = Array.isArray(act?.witnesses) ? act.witnesses : [];
            for (const w of witnesses) {
                const memberId = Number(w?.memberId ?? w?.member?.id);
                if (!memberId) continue;
                if (!byMember.has(memberId)) byMember.set(memberId, []);
                byMember.get(memberId).push({
                    committeeName,
                    title,
                    topic: stripHtml(act?.title || title),
                    role: 'Ministerial / MP Witness',
                    url: eventUrl
                });
            }
        }
    }

    return byMember;
}

async function fetchGovUkDigestForDepartment(deptSlug, deptName, dateStr) {
    if (!deptSlug) return null;

    try {
        const url = new URL(GOVUK_SEARCH_API);
        url.searchParams.set('filter_organisations', deptSlug);
        url.searchParams.set('filter_public_timestamp', `from:${dateStr},to:${dateStr}`);
        url.searchParams.set('fields', 'title,description,link,public_timestamp');
        url.searchParams.set('order', '-public_timestamp');
        url.searchParams.set('count', '5');

        const data = await fetchJsonWithTimeout(url.toString(), 15000);
        const results = Array.isArray(data?.results) ? data.results : [];
        if (results.length === 0) return null;

        const items = results.slice(0, 4).map(r => ({
            title: stripHtml(r.title || ''),
            description: stripHtml(r.description || ''),
            publishedDate: r.public_timestamp ? String(r.public_timestamp).slice(0, 10) : dateStr,
            url: r.link?.startsWith('http') ? r.link : `https://www.gov.uk${r.link || ''}`
        }));

        const titles = items.slice(0, 3).map(i => `“${i.title}”`).join(', ');
        const summary = `Official GOV.UK announcements from ${deptName} included ${titles}.`;

        return { deptName, summary, items };
    } catch {
        return null;
    }
}

let geminiWarnCount = 0;
let activeGeminiModel = 'gemini-3.8-flash';

async function summarizeWithGemini({ mp, readableDate, speeches, committees, writtenQuestions, mpVotes, govRole, verbatimExcerpt }) {
    if (skipLlm || !geminiApiKey) return null;

    const askedQuestions = writtenQuestions.filter(q => q.direction !== 'answered');
    const answeredQuestions = writtenQuestions.filter(q => q.direction === 'answered');

    const rankedSpeeches = [...speeches].sort((a, b) => b.text.length - a.text.length);

    const speechDigest = rankedSpeeches
        .slice(0, 4)
        .map(s => `- Debate "${s.debateTitle}": "${s.text.slice(0, 1200)}"`)
        .join('\n');

    const committeeDigest = committees
        .slice(0, 4)
        .map(c => `- ${c.committeeName} (${c.role}): ${c.title}`)
        .join('\n');

    const wqDigest = [
        ...askedQuestions.slice(0, 5).map(q => `- Tabled to ${q.department} (${q.heading}): "${q.questionText.slice(0, 320)}"`),
        ...answeredQuestions.slice(0, 5).map(q => `- Answered for ${q.department} (asked by ${q.askingMemberName || 'an MP'} on ${q.heading}): "${(q.answerText || q.questionText).slice(0, 320)}"`)
    ].join('\n');

    const voteDigest = mpVotes
        .slice(0, 6)
        .map(v => `- ${v.title}: Voted ${v.mpVote} (${v.houseResult})`)
        .join('\n');

    const prompt = `You are an impartial, strictly factual UK parliamentary correspondent writing for Whip.
Write a clear, accessible briefing on ${mp.full_name} (${mp.party}, ${mp.role_title}) on ${readableDate}.

Audience & Tone Rules:
- Write so anyone from a school politics student to an older adult without further education can read it effortlessly.
- Use short, easily digestible paragraphs (2–3 short sentences per paragraph), separated by a blank line (\\n\\n).
- Strictly neutral, non-partisan tone. Do not praise, criticize, or editorialize.
- Use "${mp.short_name}" (never include constituency in parentheses after their name).
- Never guess or assume specific topics of constituency work—if mentioning local work, refer only to "handling urgent constituent casework".

Verbatim Hansard Quote Rules (CRITICAL):
- If Chamber Speeches are provided below, weave ONE exact, word-for-word complete substantive sentence (or two consecutive complete sentences) from the speech transcript into "summary_para_1", enclosed in double quotation marks ("...").
- Choose a substantive policy point rather than a procedural pleasantry, eye-catching remark, or point of order.
- NEVER paraphrase, alter, or shorten words inside the quotation marks, and NEVER cut off a quote mid-word or mid-sentence.
- Introduce the quote naturally so it flows smoothly within the surrounding sentences.

Return ONLY valid JSON with keys: "activity_tag", "summary_para_1", "summary_para_2", "glossary".
- "activity_tag": short 2–4 word badge (e.g., "AI Risk Debate", "Answered 4 Written Questions", "Select Committee Evidence", "3 Division Votes").
- "summary_para_1": 2 to 3 short, well-paced paragraphs separated by \\n\\n covering speeches (with the exact verbatim quote), committee work, written questions tabled or answered as a minister, and/or division votes.
- "summary_para_2": 1 short paragraph (2–3 clear sentences) explaining "Why this matters"—specifically explaining in everyday language the bill, debate topic (e.g. AI risks, transport, local services), or policy issue the MP engaged with.
- "glossary": array of 1–2 objects {"term": "...", "plain": "..."} explaining any parliamentary term mentioned (or [] if none).

Data for ${readableDate}:
${govRole ? `Government Role: ${govRole.postTitle}` : ''}
${speechDigest ? `Chamber Speeches:\n${speechDigest}` : 'Chamber Speeches: None'}
${committeeDigest ? `Committee Sessions:\n${committeeDigest}` : 'Committee Sessions: None'}
${wqDigest ? `Written Parliamentary Questions:\n${wqDigest}` : 'Written Parliamentary Questions: None'}
${voteDigest ? `Commons Division Votes:\n${voteDigest}` : 'Commons Division Votes: None'}`;

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            if (attempt > 1) {
                await sleep(800);
            }

            const res = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${activeGeminiModel}:generateContent?key=${encodeURIComponent(geminiApiKey)}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: {
                            temperature: 0.2,
                            responseMimeType: 'application/json'
                        }
                    }),
                    signal: AbortSignal.timeout(12000)
                }
            );

            if ((res.status === 404 || res.status === 429 || res.status === 503) && attempt === 1) {
                const errPreview = await res.text().catch(() => '');
                if (geminiWarnCount < 3) {
                    geminiWarnCount += 1;
                    console.warn(`Gemini (${activeGeminiModel}) HTTP ${res.status}, switching to gemini-3.6-flash: ${errPreview.slice(0, 180)}`);
                }
                activeGeminiModel = 'gemini-3.6-flash';
                continue;
            }

            if (!res.ok) {
                const errPreview = await res.text().catch(() => '');
                if (geminiWarnCount < 5) {
                    geminiWarnCount += 1;
                    console.warn(`Gemini (${activeGeminiModel}) HTTP ${res.status} for ${mp.short_name}: ${errPreview.slice(0, 220)}`);
                }
                return null;
            }

            const payload = await res.json();
            const rawText = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!rawText) return null;

            const parsed = JSON.parse(rawText);
            if (!parsed?.summary_para_1 || !parsed?.summary_para_2) return null;

            const verifiedNarrative = ensureVerbatimQuoteIntegrity(
                parsed.summary_para_1,
                rankedSpeeches,
                verbatimExcerpt
            );

            return {
                activity_tag: String(parsed.activity_tag || 'Parliamentary Business').slice(0, 60),
                summary_para_1: verifiedNarrative,
                summary_para_2: String(parsed.summary_para_2).trim(),
                glossary: Array.isArray(parsed.glossary) ? parsed.glossary.slice(0, 3) : []
            };
        } catch (err) {
            if (attempt === 1) {
                activeGeminiModel = 'gemini-3.6-flash';
            } else if (geminiWarnCount < 5) {
                geminiWarnCount += 1;
                console.warn(`Gemini error for ${mp.short_name}: ${err.message}`);
            }
        }
    }

    return null;
}

export async function generateBriefings() {
    const targetDate = getTargetDate();
    const readableDate = formatReadableDate(targetDate);
    const shortRefDate = formatShortRefDate(targetDate);

    console.log(
        `[${new Date().toISOString()}] Generating Whip briefings for ${targetDate} (${readableDate})... ` +
        `(GEMINI_API_KEY configured: ${geminiApiKey ? 'yes' : 'NO'}, SKIP_LLM: ${skipLlm}, FORCE_REGEN: ${forceRegen})`
    );

    const { data: mps, error: mpError } = await supabase
        .from('mps')
        .select('parliament_member_id, full_name, short_name, party, role_title, constituencies(name)')
        .eq('is_current_member', true);

    if (mpError || !mps?.length) {
        throw new Error(`Could not fetch active MPs: ${mpError?.message || '0 rows'}`);
    }

    const mpIds = mps.map(m => Number(m.parliament_member_id)).filter(Boolean);
    const existingByMpId = forceRegen ? new Map() : await fetchExistingBriefingsForDate(targetDate, mpIds);

    const [hansardByMember, divisions, writtenQuestionsByMember, committeesByMember] = await Promise.all([
        fetchHansardContributionsForDate(targetDate),
        fetchDivisionsForDate(targetDate),
        fetchWrittenQuestionsForDate(targetDate),
        fetchCommitteeSessionsForDate(targetDate)
    ]);

    const isNonSittingDay =
        hansardByMember.size === 0 &&
        divisions.length === 0 &&
        writtenQuestionsByMember.size === 0 &&
        committeesByMember.size === 0;

    console.log(
        `Fetched: ${hansardByMember.size} speakers, ${divisions.length} divisions, ` +
        `${writtenQuestionsByMember.size} MPs with WQs (asked/answered), ${committeesByMember.size} committee participants. ` +
        `Cached existing briefings: ${existingByMpId.size}.`
    );

    const deptDigestCache = new Map();
    const uniqueDepts = new Map();
    for (const mp of mps) {
        const govRole = resolveGovernmentRole(mp);
        if (govRole?.deptSlug && !uniqueDepts.has(govRole.deptSlug)) {
            uniqueDepts.set(govRole.deptSlug, govRole.deptName);
        }
    }
    await Promise.all(
        Array.from(uniqueDepts.entries()).map(async ([slug, name]) => {
            const digest = await fetchGovUkDigestForDepartment(slug, name, targetDate);
            deptDigestCache.set(slug, digest);
        })
    );

    const rowsToUpsert = [];
    const activeTasks = [];
    let reusedCount = 0;
    let aiSuccessCount = 0;

    for (const mp of mps) {
        const memberId = Number(mp.parliament_member_id);
        const sinnFein = isSinnFeinMp(mp);
        const speakerOrDeputy = isSpeakerOrDeputyMp(mp);
        const govRole = resolveGovernmentRole(mp);
        const speeches = hansardByMember.get(memberId) || [];
        const committees = committeesByMember.get(memberId) || [];
        const writtenQuestions = writtenQuestionsByMember.get(memberId) || [];

        const mpVotes = divisions.map(div => {
            let mpVote = 'Abstained';
            if (div.ayeIds.has(memberId)) mpVote = 'Aye';
            else if (div.noIds.has(memberId)) mpVote = 'No';

            return {
                divisionId: div.divisionId,
                title: div.title,
                houseResult: div.houseResult,
                mpVote,
                explainer: div.explainer
            };
        });

        const activeVotes = mpVotes.filter(v => v.mpVote === 'Aye' || v.mpVote === 'No');

        if (isNonSittingDay) {
            rowsToUpsert.push({
                parliament_member_id: memberId,
                sitting_date: targetDate,
                activity_tag: sinnFein ? 'Abstentionist MP' : 'Non-Sitting Day',
                hansard_ref: sinnFein
                    ? `Abstentionist Policy • ${shortRefDate}`
                    : `Commons Recess / Non-Sitting • ${shortRefDate}`,
                summary_para_1: sinnFein
                    ? `The House of Commons did not sit on ${readableDate}.\n\nIn line with Sinn Féin’s policy of abstentionism, ${mp.short_name} does not take the oath of allegiance or sit in Westminster, focusing instead on constituency representation in Northern Ireland.`
                    : `The House of Commons did not sit on ${readableDate}.\n\nWhen the House is not sitting, MPs focus on handling urgent constituent casework, meeting local residents, and preparing for upcoming committee work.`,
                summary_para_2: sinnFein
                    ? `Under Section 1 of the Parliamentary Oaths Act 1866, MPs must swear an oath or make a solemn affirmation of allegiance to the Crown before taking their seats, speaking, or voting in the House of Commons.`
                    : `Much of an MP's job happens outside the main debating Chamber—handling urgent constituent casework and writing directly to government departments on behalf of residents.`,
                verbatim_excerpt: null,
                glossary: sinnFein
                    ? [
                        {
                            term: 'Abstentionism',
                            plain: 'Sinn Féin’s longstanding policy of contesting Westminster elections while refusing to take the oath of allegiance or sit, speak, or vote in the House of Commons.'
                        },
                        {
                            term: 'Parliamentary Oath',
                            plain: 'The legal oath or affirmation of allegiance to the monarch required under the Parliamentary Oaths Act 1866 before an elected MP can sit or vote in the Commons.'
                        }
                    ]
                    : (govRole ? [{
                        _type: 'ministerial_meta',
                        postTitle: govRole.postTitle,
                        deptSlug: govRole.deptSlug,
                        deptName: govRole.deptName,
                        isWhip: govRole.isWhip,
                        deptDigest: govRole.deptSlug ? (deptDigestCache.get(govRole.deptSlug) || null) : null
                    }] : []),
                votes: [],
                written_questions: [],
                committee_sessions: []
            });
            continue;
        }

        const hasSubstantiveActivity =
            speeches.length > 0 ||
            committees.length > 0 ||
            writtenQuestions.length > 0 ||
            activeVotes.length > 0;

        if (!hasSubstantiveActivity) {
            let activityTag = '';
            let summaryPara1 = '';
            let summaryPara2 = '';
            let glossary = [];
            let hansardRef = `HC Deb ${shortRefDate}`;

            if (sinnFein) {
                activityTag = 'Abstentionist MP';
                hansardRef = `Abstentionist Policy • ${shortRefDate}`;
                summaryPara1 = `${mp.short_name} did not attend the Commons Chamber or vote on ${readableDate} in line with Sinn Féin’s policy of abstentionism at Westminster.\n\nInstead of sitting in the House of Commons, Sinn Féin MPs focus on constituency representation in Northern Ireland.`;
                summaryPara2 = `Under Section 1 of the Parliamentary Oaths Act 1866, MPs must swear an oath or make a solemn affirmation of allegiance to the Crown before sitting or voting in the House of Commons. Sinn Féin MPs refuse to take the oath, do not sit in Westminster, and do not draw an MP salary.`;
                glossary = [
                    {
                        term: 'Abstentionism',
                        plain: 'Sinn Féin’s policy of contesting Westminster elections while refusing to take the oath of allegiance or sit, speak, or vote in the House of Commons.'
                    },
                    {
                        term: 'Parliamentary Oath',
                        plain: 'The legal oath or affirmation of allegiance to the monarch required under the Parliamentary Oaths Act 1866 before an elected MP can sit or vote in the Commons.'
                    }
                ];
            } else if (speakerOrDeputy) {
                activityTag = 'Chairing the House';
                hansardRef = `Speaker’s Chair • ${shortRefDate}`;
                summaryPara1 = `${mp.short_name} did not speak in debates or vote in Commons divisions on ${readableDate} due to the strict impartiality required of the Speaker’s Chair.`;
                summaryPara2 = `By constitutional convention, the Speaker and Deputy Speakers preside over House of Commons debates, keep order, and select amendments—voting only to break a tied result.`;
            } else if (govRole) {
                activityTag = 'Ministerial & Departmental Work';
                summaryPara1 = `${mp.short_name} did not speak in the Commons Chamber or cast recorded division votes on ${readableDate}, carrying out ${govRole.postTitle} duties.`;
                summaryPara2 = `Government ministers divide their week between running their department, preparing legislation, answering official correspondence, and speaking in the Chamber during their department's question rota.`;
            } else {
                activityTag = 'Constituency & Parliamentary Work';
                summaryPara1 = `${mp.short_name} did not speak in the Commons Chamber, attend a public select committee session, or cast a recorded vote on ${readableDate}.\n\nHaving a quiet day on the Chamber floor is common for backbench MPs, particularly when Parliament is debating bills handled by specialist committees.`;
                summaryPara2 = `Much of an MP's working week takes place away from the main Chamber—handling urgent constituent casework, meeting local residents, and writing to government ministers on behalf of constituents.`;
            }

            if (govRole) {
                glossary = [
                    {
                        _type: 'ministerial_meta',
                        postTitle: govRole.postTitle,
                        deptSlug: govRole.deptSlug,
                        deptName: govRole.deptName,
                        isWhip: govRole.isWhip,
                        deptDigest: govRole.deptSlug ? (deptDigestCache.get(govRole.deptSlug) || null) : null
                    },
                    ...glossary
                ];
            }

            rowsToUpsert.push({
                parliament_member_id: memberId,
                sitting_date: targetDate,
                activity_tag: activityTag,
                hansard_ref: hansardRef,
                summary_para_1: summaryPara1,
                summary_para_2: summaryPara2,
                verbatim_excerpt: null,
                glossary,
                votes: mpVotes,
                written_questions: writtenQuestions,
                committee_sessions: committees
            });
            continue;
        }

        const existingRow = existingByMpId.get(memberId);
        if (existingRow && !forceRegen) {
            reusedCount += 1;
            const { hrsRef } = extractBestVerbatimQuote(speeches, 360);
            const hansardRef = hrsRef ? `HC Deb ${shortRefDate} • ${hrsRef}` : `HC Deb ${shortRefDate}`;
            let glossary = Array.isArray(existingRow.glossary) ? [...existingRow.glossary] : [];

            if (govRole) {
                const updatedMeta = {
                    _type: 'ministerial_meta',
                    postTitle: govRole.postTitle,
                    deptSlug: govRole.deptSlug,
                    deptName: govRole.deptName,
                    isWhip: govRole.isWhip,
                    deptDigest: govRole.deptSlug ? (deptDigestCache.get(govRole.deptSlug) || null) : null
                };
                const idx = glossary.findIndex(g => g?._type === 'ministerial_meta');
                if (idx >= 0) glossary[idx] = updatedMeta;
                else glossary = [updatedMeta, ...glossary];
            }

            rowsToUpsert.push({
                parliament_member_id: memberId,
                sitting_date: targetDate,
                activity_tag: existingRow.activity_tag || 'Parliamentary Business',
                hansard_ref: hansardRef,
                summary_para_1: existingRow.summary_para_1,
                summary_para_2: existingRow.summary_para_2 || '',
                verbatim_excerpt: existingRow.verbatim_excerpt || null,
                glossary,
                votes: mpVotes,
                written_questions: writtenQuestions,
                committee_sessions: committees
            });
            continue;
        }

        activeTasks.push({
            mp,
            memberId,
            govRole,
            speeches,
            committees,
            writtenQuestions,
            mpVotes,
            activeVotes
        });
    }

    for (let i = 0; i < activeTasks.length; i += GEMINI_CONCURRENCY) {
        const batch = activeTasks.slice(i, i + GEMINI_CONCURRENCY);
        const batchResults = await Promise.all(
            batch.map(async (task) => {
                const { mp, memberId, govRole, speeches, committees, writtenQuestions, mpVotes, activeVotes } = task;
                const { quote, hrsRef } = extractBestVerbatimQuote(speeches, 360);
                const verbatimExcerpt = quote || null;
                const hansardRef = hrsRef ? `HC Deb ${shortRefDate} • ${hrsRef}` : `HC Deb ${shortRefDate}`;

                const aiSummary = await summarizeWithGemini({
                    mp,
                    readableDate,
                    speeches,
                    committees,
                    writtenQuestions,
                    mpVotes: activeVotes,
                    govRole,
                    verbatimExcerpt
                });

                let activityTag = '';
                let summaryPara1 = '';
                let summaryPara2 = '';
                let glossary = [];

                if (aiSummary) {
                    aiSuccessCount += 1;
                    activityTag = aiSummary.activity_tag;
                    summaryPara1 = aiSummary.summary_para_1;
                    summaryPara2 = aiSummary.summary_para_2;
                    glossary = aiSummary.glossary;
                } else {
                    const askedQs = writtenQuestions.filter(q => q.direction !== 'answered');
                    const answeredQs = writtenQuestions.filter(q => q.direction === 'answered');
                    const votePara = activeVotes.length > 0
                        ? `\n\nIn the voting lobbies, ${mp.short_name} cast ${activeVotes.length} recorded division ${activeVotes.length === 1 ? 'vote' : 'votes'}, including voting ${activeVotes[0].mpVote} on ${activeVotes[0].title}.`
                        : '';

                    if (speeches.length > 0) {
                        const topics = [...new Set(speeches.map(s => s.debateTitle))].slice(0, 2);
                        activityTag = topics[0].slice(0, 42);
                        const quotePara = verbatimExcerpt
                            ? `\n\nDuring the debate, ${mp.short_name} told the House: “${verbatimExcerpt}”`
                            : '';
                        summaryPara1 = `On ${readableDate}, ${mp.short_name} spoke in the Commons Chamber during proceedings on ${topics.join(' and ')}.${quotePara}${votePara}`;
                        summaryPara2 = `Debates in the House of Commons allow MPs to question ministers, put local concerns on the official record, and scrutinise proposals before laws are passed.`;
                    } else if (committees.length > 0) {
                        const commName = committees[0].committeeName;
                        activityTag = commName.slice(0, 42);
                        summaryPara1 = `${mp.short_name} did not speak in the main Commons Chamber on ${readableDate}, instead taking part in ${committees.length} select committee ${committees.length === 1 ? 'session' : 'sessions'} with the ${commName}.${votePara}`;
                        summaryPara2 = `Select committees are cross-party groups of MPs that investigate government departments and public bodies, questioning ministers and expert witnesses on the public record.`;
                    } else if (answeredQs.length > 0) {
                        const dept = answeredQs[0].department;
                        const topics = [...new Set(answeredQs.map(q => q.heading))].slice(0, 3);
                        activityTag = answeredQs.length === 1 ? 'Answered 1 Written Question' : `Answered ${answeredQs.length} Written Questions`;
                        summaryPara1 = `${mp.short_name} did not speak in the main Commons Chamber on ${readableDate}, but answered ${answeredQs.length} written parliamentary ${answeredQs.length === 1 ? 'question' : 'questions'} on behalf of ${dept} regarding ${topics.join(', ')}.${votePara}`;
                        summaryPara2 = `Ministers provide formal written replies to MPs' parliamentary questions on behalf of their department, placing policy details and official figures on the public record.`;
                    } else if (askedQs.length > 0) {
                        const depts = [...new Set(askedQs.map(q => q.department))];
                        const topics = [...new Set(askedQs.map(q => q.heading))].slice(0, 3);
                        activityTag = askedQs.length === 1 ? '1 Written Question' : `${askedQs.length} Written Questions`;
                        summaryPara1 = `${mp.short_name} did not speak in the main Commons Chamber on ${readableDate}, but tabled ${askedQs.length} written ${askedQs.length === 1 ? 'question' : 'questions'} to ${depts.slice(0, 2).join(' and ')} regarding ${topics.join(', ')}.${votePara}`;
                        summaryPara2 = `Written Parliamentary Questions require government departments to publish formal, on-the-record answers within a set timeframe.`;
                    } else {
                        activityTag = activeVotes.length === 1 ? '1 Division Vote' : `${activeVotes.length} Division Votes`;
                        const firstVote = activeVotes[0];
                        summaryPara1 = `${mp.short_name} did not speak in the main Commons Chamber on ${readableDate}, but took part in ${activeVotes.length} Commons ${activeVotes.length === 1 ? 'vote' : 'votes'}, including voting ${firstVote.mpVote} on ${firstVote.title}.`;
                        summaryPara2 = firstVote.explainer?.whatItDoes || `Voting in Commons divisions is how MPs formally approve or reject bills, amendments, and government motions.`;
                    }
                }

                if (govRole) {
                    glossary = [
                        {
                            _type: 'ministerial_meta',
                            postTitle: govRole.postTitle,
                            deptSlug: govRole.deptSlug,
                            deptName: govRole.deptName,
                            isWhip: govRole.isWhip,
                            deptDigest: govRole.deptSlug ? (deptDigestCache.get(govRole.deptSlug) || null) : null
                        },
                        ...glossary
                    ];
                }

                return {
                    parliament_member_id: memberId,
                    sitting_date: targetDate,
                    activity_tag: activityTag,
                    hansard_ref: hansardRef,
                    summary_para_1: summaryPara1,
                    summary_para_2: summaryPara2,
                    verbatim_excerpt: verbatimExcerpt,
                    glossary,
                    votes: mpVotes,
                    written_questions: writtenQuestions,
                    committee_sessions: committees
                };
            })
        );
        rowsToUpsert.push(...batchResults);
    }

    for (let i = 0; i < rowsToUpsert.length; i += 100) {
        const chunk = rowsToUpsert.slice(i, i + 100);
        const { error: upsertErr } = await supabase
            .from('daily_briefings')
            .upsert(chunk, { onConflict: 'parliament_member_id,sitting_date' });
        if (upsertErr) {
            throw new Error(`Failed upserting daily_briefings batch ${i}: ${upsertErr.message}`);
        }
    }

    console.log(
        `[${new Date().toISOString()}] Successfully upserted ${rowsToUpsert.length} briefings for ${targetDate} ` +
        `(${reusedCount} reused from cache, ${aiSuccessCount}/${activeTasks.length} new Gemini summaries).`
    );
}

generateBriefings();
