/**
 * Whip — Step 2: Daily Parliamentary Briefing Generator (`generate_briefings.js`)
 *
 * Fetches House of Commons Hansard speeches, Select/Bill Committee appearances,
 * Written Parliamentary Questions, Commons Division votes (with per-division explainers),
 * and GOV.UK departmental activity for ministers, generates plain-English neutral
 * summaries via Gemini, and upserts into `daily_briefings`.
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
const GOVUK_SEARCH_API = 'https://www.gov.uk/api/search.json';

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

function getWeekBoundsForDate(isoDate) {
    const d = new Date(`${isoDate}T12:00:00Z`);
    const day = d.getUTCDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() + diffToMonday);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    return {
        mondayIso: monday.toISOString().slice(0, 10),
        sundayIso: sunday.toISOString().slice(0, 10)
    };
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

// --- Ministerial Role & GOV.UK Department Mapping ---
const DEPARTMENT_MAP = [
    { match: /\bprime minister\b/i, slug: 'prime-ministers-office-10-downing-street', name: '10 Downing Street' },
    { match: /\b(exchequer|treasury)\b/i, slug: 'hm-treasury', name: 'HM Treasury' },
    { match: /\bhome department|home secretary|policing|immigration|border security\b/i, slug: 'home-office', name: 'Home Office' },
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
    { match: /\battorney general|solicitor general\b/i, slug: 'attorney-generals-office', name: "Attorney General's Office" }
];

function extractMinisterialInfo(roleTitle) {
    if (!roleTitle || !roleTitle.includes('• MP for ')) return null;
    const postTitle = roleTitle.split('• MP for ')[0].trim();
    if (!postTitle) return null;

    const dept = DEPARTMENT_MAP.find(d => d.match.test(postTitle)) || null;
    const isWhip = /\b(whip|treasurer of hm household|comptroller|vice-chamberlain|lord commissioner)\b/i.test(postTitle);

    return {
        postTitle,
        deptSlug: dept?.slug || null,
        deptName: dept?.name || null,
        isWhip
    };
}

const configuredGeminiModel = cleanEnvValue(process.env.GEMINI_MODEL, 'GEMINI_MODEL');
const GEMINI_MODELS = [
    ...(configuredGeminiModel ? [configuredGeminiModel] : []),
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash'
];
let workingGeminiModel = null;

async function callGeminiApi(prompt) {
    const candidates = workingGeminiModel ? [workingGeminiModel] : GEMINI_MODELS;
    let lastError = null;

    for (const model of candidates) {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;

        for (let attempt = 0; attempt < 2; attempt++) {
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

            if (res.status === 429 && attempt === 0) {
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            break;
        }
    }

    throw lastError || new Error('No working Gemini model found');
}

async function fetchDepartmentWeeklyDigest(deptSlug, deptName, dateStr) {
    try {
        const { mondayIso, sundayIso } = getWeekBoundsForDate(dateStr);
        const url = new URL(GOVUK_SEARCH_API);
        url.searchParams.set('filter_organisations', deptSlug);
        url.searchParams.set('filter_public_timestamp', `from:${mondayIso},to:${sundayIso}`);
        url.searchParams.set('fields', 'title,description,link,public_timestamp');
        url.searchParams.set('order', '-public_timestamp');
        url.searchParams.set('count', '10');

        const data = await fetchJsonWithTimeout(url.toString(), 12000);
        const results = Array.isArray(data?.results) ? data.results : [];
        if (results.length === 0) return null;

        const items = results.slice(0, 5).map(r => ({
            title: stripHtml(r.title || ''),
            description: stripHtml(r.description || ''),
            publishedDate: r.public_timestamp ? String(r.public_timestamp).slice(0, 10) : null,
            url: r.link?.startsWith('http') ? r.link : `https://www.gov.uk${r.link || ''}`
        }));

        let summary = '';
        try {
            const digestInput = items
                .map(i => `- ${i.title}${i.description ? `: ${i.description.slice(0, 220)}` : ''}`)
                .join('\n');

            const prompt = `You are a strictly neutral, non-partisan UK public service editor writing for Whip (whipdaily.uk).
Summarize the ${deptName}'s official GOV.UK announcements and policy work during the week of ${mondayIso} to ${sundayIso} in 2 concise, specific, neutral British English sentences.
Return valid JSON only: {"summary": "..."}.

Announcements:
${digestInput}`;

            const payload = await callGeminiApi(prompt);
            const parsed = JSON.parse(payload?.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
            summary = (parsed.summary || '').trim();
        } catch {
            const titles = items.map(i => i.title).filter(Boolean).slice(0, 3);
            summary = `During this week, the ${deptName} published ${items.length} official ${items.length === 1 ? 'update' : 'updates'} on GOV.UK, covering ${titles.join('; ')}.`;
        }

        return {
            deptName,
            summary,
            items
        };
    } catch (err) {
        console.warn(`GOV.UK department digest warning (${deptSlug}): ${err.message}`);
        return null;
    }
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
            data = await fetchJsonWithTimeout(url.toString(), 30000);
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

function buildFallbackDivisionExplainer(divisionTitle, divisionId, readableDate) {
    const title = (divisionTitle || 'House of Commons Division').trim();
    const lower = title.toLowerCase();
    const parliamentUrl = divisionId
        ? `https://votes.parliament.uk/votes/commons/division/${divisionId}`
        : 'https://votes.parliament.uk/';

    const billBase = title
        .replace(/:\s*(Second Reading|Third Reading|Report Stage|Committee|Programme|Money).*$/i, '')
        .trim();

    const newClauseMatch = title.match(/\b(New Clause|New Schedule|Amendment)\s+([A-Z0-9]+)/i);
    if (newClauseMatch) {
        const clauseLabel = `${newClauseMatch[1]} ${newClauseMatch[2]}`;
        return {
            whatItDoes: `${clauseLabel} was a proposed addition or change to ${billBase} debated during its Commons scrutiny on ${readableDate}.`,
            whatAyeMeans: `Supported adding ${clauseLabel} into ${billBase}.`,
            whatNoMeans: `Voted against adding ${clauseLabel} to the Bill.`,
            parliamentUrl
        };
    }

    if (lower.includes('second reading')) {
        return {
            whatItDoes: `Second Reading is the first major Commons vote on the main principles of ${billBase}.`,
            whatAyeMeans: `Supported the general principles of ${billBase} so it could advance to detailed line-by-line committee scrutiny.`,
            whatNoMeans: `Opposed ${billBase} progressing further in the House of Commons.`,
            parliamentUrl
        };
    }

    if (lower.includes('third reading')) {
        return {
            whatItDoes: `Third Reading is the final House of Commons vote on the amended text of ${billBase} before it moves to the House of Lords.`,
            whatAyeMeans: `Approved the final Commons version of ${billBase}.`,
            whatNoMeans: `Voted to reject the final Commons version of ${billBase}.`,
            parliamentUrl
        };
    }

    if (lower.includes('opposition day')) {
        const topic = title.replace(/^Opposition [Dd]ay:\s*/i, '').replace(/:\s*Opposition motion$/i, '').trim();
        return {
            whatItDoes: `An Opposition Day motion putting forward a policy position or call to action on ${topic || 'a chosen policy topic'}.`,
            whatAyeMeans: `Backed the Opposition motion on ${topic || 'the debate topic'}.`,
            whatNoMeans: `Voted against the Opposition motion.`,
            parliamentUrl
        };
    }

    if (lower.includes('regulations') || lower.includes('order')) {
        return {
            whatItDoes: `${title} is secondary legislation (a Statutory Instrument) brought forward by ministers under powers granted by an existing Act of Parliament.`,
            whatAyeMeans: `Approved the regulations or order so they can take legal effect.`,
            whatNoMeans: `Voted to reject the regulations or order.`,
            parliamentUrl
        };
    }

    return {
        whatItDoes: `${title} was put to a formal House of Commons division on ${readableDate} to determine whether MPs supported the measure or motion.`,
        whatAyeMeans: `Supported the motion or legislative proposal.`,
        whatNoMeans: `Opposed the motion or legislative proposal.`,
        parliamentUrl
    };
}

async function fetchOfficialEvidenceForDivision(divisionTitle, speechesByMember) {
    const evidenceParts = [];
    const title = (divisionTitle || '').trim();

    const billBase = title
        .replace(/:\s*(Second Reading|Third Reading|Report Stage|Committee|Programme|Money).*$/i, '')
        .trim();

    if (/\bbill\b/i.test(billBase)) {
        try {
            const url = new URL(BILLS_SEARCH_API);
            url.searchParams.set('SearchTerm', billBase);
            url.searchParams.set('Take', '1');
            const data = await fetchJsonWithTimeout(url.toString(), 8000);
            const bill = data?.items?.[0];
            if (bill?.billId) {
                if (bill.longTitle) {
                    evidenceParts.push(`Bill Long Title: ${stripHtml(bill.longTitle)}`);
                }
                const newClauseMatch = title.match(/\b(?:New Clause|New Schedule|Amendment)\s+([A-Z0-9]+)/i);
                if (newClauseMatch) {
                    const clauseNum = newClauseMatch[1];
                    const stagesData = await fetchJsonWithTimeout(`${BILLS_SEARCH_API}/${bill.billId}/Stages`, 8000).catch(() => null);
                    const stages = stagesData?.items || [];
                    const reportOrLatest = stages.find(s => /report/i.test(s.description || '')) || stages[stages.length - 1];
                    if (reportOrLatest?.id) {
                        const amendUrl = new URL(`${BILLS_SEARCH_API}/${bill.billId}/Stages/${reportOrLatest.id}/Amendments`);
                        amendUrl.searchParams.set('SearchTerm', clauseNum);
                        amendUrl.searchParams.set('Take', '3');
                        const amendData = await fetchJsonWithTimeout(amendUrl.toString(), 8000).catch(() => null);
                        const matchedAmend = (amendData?.items || []).find(a =>
                            String(a.amendmentNumber || '').toLowerCase() === `nc${clauseNum.toLowerCase()}` ||
                            String(a.amendmentNumber || '').toLowerCase() === clauseNum.toLowerCase()
                        ) || amendData?.items?.[0];
                        if (matchedAmend) {
                            const amendSummary = stripHtml(matchedAmend.explanatoryStatement || matchedAmend.summaryText || '');
                            if (amendSummary) {
                                evidenceParts.push(`Amendment/Clause Explanatory Note: ${amendSummary.slice(0, 600)}`);
                            }
                        }
                    }
                }
            }
        } catch {}
    }

    if (speechesByMember && speechesByMember.size > 0) {
        const keywords = title
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 3 && !['bill', 'report', 'stage', 'second', 'third', 'reading', 'opposition', 'motion', 'draft', 'regulations', '2025', '2026'].includes(w));

        const matchedSnippets = [];
        for (const speeches of speechesByMember.values()) {
            for (const s of speeches) {
                const hay = `${s.debateTitle} ${s.text}`.toLowerCase();
                if (keywords.some(k => hay.includes(k))) {
                    matchedSnippets.push(`${s.debateTitle}: ${s.text.slice(0, 450)}`);
                    break;
                }
            }
            if (matchedSnippets.length >= 3) break;
        }
        if (matchedSnippets.length > 0) {
            evidenceParts.push(`Commons Debate Excerpts:\n${matchedSnippets.join('\n')}`);
        }
    }

    return evidenceParts.join('\n\n');
}

async function generateDivisionExplainer(detail, dateStr, speechesByMember) {
    const divisionId = detail.DivisionId;
    const title = detail.Title || 'House of Commons Division';
    const readableDate = formatReadableDate(dateStr);
    const fallback = buildFallbackDivisionExplainer(title, divisionId, readableDate);

    try {
        const officialEvidence = await fetchOfficialEvidenceForDivision(title, speechesByMember);
        const prompt = `You are a strictly neutral, non-partisan UK parliamentary editor writing for Whip (whipdaily.uk).
Explain in plain British English what the following House of Commons division was actually about so an everyday voter understands what MPs were voting on.

Division Title: "${title}"
Sitting Date: ${readableDate}
${officialEvidence ? `\nOfficial Parliament Context:\n${officialEvidence}\n` : ''}

Rules:
- Be strictly factual, concise, and non-partisan. Never take a political side.
- If it is a New Clause, Amendment, Opposition Day motion, or Statutory Instrument, explain specifically what policy change or proposal it sought to introduce.
- Return valid JSON only with keys: "whatItDoes", "whatAyeMeans", "whatNoMeans".
- "whatItDoes": 2 clear sentences explaining what the bill, clause, motion, or regulation actually does in plain English.
- "whatAyeMeans": 1 concise sentence starting with a verb (e.g., "Supported...").
- "whatNoMeans": 1 concise sentence starting with a verb (e.g., "Opposed...").`;

        const payload = await callGeminiApi(prompt);
        const rawText = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const parsed = JSON.parse(rawText);

        return {
            whatItDoes: parsed.whatItDoes || fallback.whatItDoes,
            whatAyeMeans: parsed.whatAyeMeans || fallback.whatAyeMeans,
            whatNoMeans: parsed.whatNoMeans || fallback.whatNoMeans,
            parliamentUrl: fallback.parliamentUrl
        };
    } catch (err) {
        console.warn(`Division explainer fallback for "${title}": ${err.message}`);
        return fallback;
    }
}

async function fetchDivisionVotes(dateStr, speechesByMember = null) {
    const votesByMember = new Map();
    let divisions = [];

    try {
        const url = new URL(COMMONS_VOTES_API);
        url.searchParams.set('startDate', dateStr);
        url.searchParams.set('endDate', dateStr);
        url.searchParams.set('take', '50');
        divisions = await fetchJsonWithTimeout(url.toString(), 20000);
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
            const detail = await fetchJsonWithTimeout(`${COMMONS_DIVISION_DETAIL_API}/${div.DivisionId}.json`, 20000);
            detailedDivisions.push(detail);
        } catch (err) {
            console.warn(`Division ${div.DivisionId} detail warning: ${err.message}`);
        }
    }

    await mapWithConcurrency(detailedDivisions, 3, async (detail) => {
        detail._explainer = await generateDivisionExplainer(detail, dateStr, speechesByMember);
    });

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
            houseResult,
            explainer: detail._explainer || null
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

function normalizePersonName(rawName) {
    return stripHtml(rawName || '')
        .replace(/\b(The Lord|Lord|Baroness|Dame|Sir|Dr|Mr|Mrs|Ms|Mx|Rt Hon|MP)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function extractParliamentMemberIdFromCommitteePerson(obj, memberIdByNormName) {
    if (!obj || typeof obj !== 'object') return null;

    const directId = Number(
        obj.memberId ??
        obj.MemberId ??
        obj.member?.id ??
        obj.member?.memberId
    );
    if (directId > 0) return directId;

    const photoUrl = String(obj.photoUrl ?? obj.PhotoUrl ?? obj.member?.photoUrl ?? '');
    const photoMatch = photoUrl.match(/\/Members\/(\d+)\//i);
    if (photoMatch) {
        return Number(photoMatch[1]);
    }

    if (memberIdByNormName) {
        const normName = normalizePersonName(obj.name ?? obj.Name ?? obj.member?.name);
        if (normName && memberIdByNormName.has(normName)) {
            return memberIdByNormName.get(normName);
        }
    }

    return null;
}

async function fetchCommitteeAppearances(dateStr, memberIdByNormName = null) {
    const byMember = new Map();

    let events = [];
    try {
        const url = new URL(COMMITTEES_EVENTS_API);
        url.searchParams.set('StartDateFrom', dateStr);
        url.searchParams.set('StartDateTo', dateStr);
        url.searchParams.set('ExcludeCancelledEvents', 'true');
        url.searchParams.set('Take', '100');

        const data = await fetchJsonWithTimeout(url.toString(), 20000);
        events = Array.isArray(data) ? data : (data?.items || data?.Items || []);
    } catch (err) {
        console.warn(`Committees Events list warning: ${err.message}`);
        return byMember;
    }

    await mapWithConcurrency(events, 6, async (ev) => {
        const eventId = ev?.id ?? ev?.Id;
        if (!eventId) return;

        const [detailData, attendanceData, activitiesData] = await Promise.all([
            fetchJsonWithTimeout(`${COMMITTEES_EVENTS_API}/${eventId}`, 15000).catch(() => null),
            fetchJsonWithTimeout(`${COMMITTEES_EVENTS_API}/${eventId}/Attendance`, 15000).catch(() => null),
            fetchJsonWithTimeout(`${COMMITTEES_EVENTS_API}/${eventId}/Activities`, 15000).catch(() => null)
        ]);

        const detail = detailData?.value || detailData || ev;
        const committeeName =
            detail?.committees?.[0]?.name ??
            detail?.committee?.name ??
            ev?.committees?.[0]?.name ??
            detail?.name ??
            'Select Committee';
        const title = stripHtml(detail?.name ?? detail?.title ?? ev?.name ?? ev?.title ?? committeeName);
        const topic = stripHtml(
            detail?.primaryDescription ??
            detail?.secondaryDescription ??
            detail?.description ??
            ev?.description ??
            title
        );
        const sessionUrl = `https://committees.parliament.uk/event/${eventId}/`;

        const rawAttendees = [
            ...(Array.isArray(attendanceData?.membersAttended) ? attendanceData.membersAttended : []),
            ...(Array.isArray(attendanceData) ? attendanceData : []),
            ...(Array.isArray(detail?.membersAttended) ? detail.membersAttended : []),
            ...(Array.isArray(detail?.attendees) ? detail.attendees : [])
        ];

        for (const person of rawAttendees) {
            if (person?.layMember) continue;
            const mId = extractParliamentMemberIdFromCommitteePerson(person, memberIdByNormName);
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

        const rawActivities = [
            ...(Array.isArray(activitiesData) ? activitiesData : (activitiesData?.activities || activitiesData?.items || [])),
            ...(Array.isArray(detail?.activities) ? detail.activities : []),
            ...(detail?.nextActivity ? [detail.nextActivity] : [])
        ];

        for (const act of rawActivities) {
            const actTitle = stripHtml(act?.name || act?.title || title) || title;
            const witnesses = [
                ...(Array.isArray(act?.witnesses) ? act.witnesses : []),
                ...(Array.isArray(act?.oralEvidenceWitnesses) ? act.oralEvidenceWitnesses : [])
            ];
            for (const w of witnesses) {
                const mId = extractParliamentMemberIdFromCommitteePerson(w, memberIdByNormName);
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

    if (events.length > 0 && byMember.size === 0) {
        console.warn(`Committees API warning: scanned ${events.length} events on ${dateStr} but matched 0 MPs — check upstream schema.`);
    } else {
        console.log(`Committees API scanned ${events.length} events on ${dateStr} -> matched ${byMember.size} MPs.`);
    }
    return byMember;
}

async function summarizeWithGemini(mp, dateStr, speeches, committees, writtenQuestions, votes, ministerialInfo) {
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
    const roleContext = ministerialInfo
        ? `Government Role: ${ministerialInfo.postTitle}${ministerialInfo.deptName ? ` (${ministerialInfo.deptName})` : ''}`
        : `Constituency MP for ${mp.constituencies?.name || 'UK'}`;

    const prompt = `You are a strictly neutral, non-partisan UK parliamentary reporter writing for Whip (whipdaily.uk).
Summarize what ${mp.full_name} (${mp.party}, ${roleContext}) did in Parliament on ${formatReadableDate(dateStr)} in plain, accessible British English.

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

async function getBillContextForDivisions(votes, readableDate) {
    const snippets = [];

    for (const v of (votes || []).slice(0, 3)) {
        if (v.explainer?.whatItDoes && !snippets.includes(v.explainer.whatItDoes)) {
            snippets.push(v.explainer.whatItDoes);
            if (snippets.length >= 2) break;
            continue;
        }

        const cleanBillName = (v.title || '')
            .replace(/:\s*(Second Reading|Third Reading|Report Stage|Committee|Programme|Money).*$/i, '')
            .trim();
        if (!cleanBillName) continue;

        if (!billContextCache.has(cleanBillName)) {
            let summary = null;
            if (/\bbill\b/i.test(cleanBillName)) {
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
        .select('parliament_member_id, full_name, short_name, party, role_title, constituencies(name)')
        .eq('is_current_member', true)
        .order('parliament_member_id', { ascending: true });

    if (mpError || !mps?.length) {
        throw new Error(`Failed to fetch active MPs: ${mpError?.message || '0 rows'}`);
    }

    const memberIdByNormName = new Map();
    const activeDeptSlugs = new Map();

    for (const mp of mps) {
        const fullNorm = normalizePersonName(mp.full_name);
        const shortNorm = normalizePersonName(mp.short_name);
        if (fullNorm) memberIdByNormName.set(fullNorm, mp.parliament_member_id);
        if (shortNorm) memberIdByNormName.set(shortNorm, mp.parliament_member_id);

        const mInfo = extractMinisterialInfo(mp.role_title);
        if (mInfo?.deptSlug && !activeDeptSlugs.has(mInfo.deptSlug)) {
            activeDeptSlugs.set(mInfo.deptSlug, mInfo.deptName);
        }
    }

    const [speechesByMember, committeesByMember, wqByMember] = await Promise.all([
        fetchHansardContributions(dateStr),
        fetchCommitteeAppearances(dateStr, memberIdByNormName),
        fetchWrittenQuestionsForDate(dateStr)
    ]);

    const { divisions, votesByMember } = await fetchDivisionVotes(dateStr, speechesByMember);

    const isNonSittingDay =
        speechesByMember.size === 0 &&
        divisions.length === 0 &&
        committeesByMember.size === 0 &&
        wqByMember.size === 0;

    // Fetch GOV.UK weekly departmental announcements once per active department on sitting days
    const deptDigestBySlug = new Map();
    if (!isNonSittingDay && activeDeptSlugs.size > 0) {
        const entries = Array.from(activeDeptSlugs.entries());
        await mapWithConcurrency(entries, 4, async ([slug, name]) => {
            const digest = await fetchDepartmentWeeklyDigest(slug, name, dateStr);
            if (digest) {
                deptDigestBySlug.set(slug, digest);
            }
        });
    }

    console.log(
        `Evidence for ${dateStr}: ${speechesByMember.size} MPs spoke, ` +
        `${divisions.length} divisions, ${committeesByMember.size} committee participants, ` +
        `${wqByMember.size} MPs tabled written questions, ` +
        `${deptDigestBySlug.size} departments with GOV.UK updates.`
    );

    const allDivisionSummaries = divisions.map(d => {
        const ayeCount = d.AyeCount ?? (d.Ayes?.length || 0);
        const noCount = d.NoCount ?? (d.Noes?.length || 0);
        return {
            divisionId: d.DivisionId,
            title: d.Title || 'House of Commons Division',
            houseResult: ayeCount > noCount
                ? `Passed (${ayeCount} Ayes to ${noCount} Noes)`
                : `Rejected (${ayeCount} Ayes to ${noCount} Noes)`,
            explainer: d._explainer || null
        };
    });

    const readableDate = formatReadableDate(dateStr);

    const rowsToUpsert = await mapWithConcurrency(mps, 4, async (mp) => {
        const memberId = mp.parliament_member_id;
        const speeches = speechesByMember.get(memberId) || [];
        const committees = committeesByMember.get(memberId) || [];
        const mpVotes = votesByMember.get(memberId) || [];
        const writtenQuestions = wqByMember.get(memberId) || [];
        const ministerialInfo = extractMinisterialInfo(mp.role_title);
        const deptDigest = ministerialInfo?.deptSlug
            ? (deptDigestBySlug.get(ministerialInfo.deptSlug) || null)
            : null;

        const votedIds = new Set(mpVotes.map(v => v.divisionId));
        const fullDayVotes = [
            ...mpVotes,
            ...allDivisionSummaries
                .filter(d => !votedIds.has(d.divisionId))
                .map(d => ({ ...d, mpVote: 'Abstained' }))
        ];

        const attachMinisterialMeta = (baseGlossary = []) => {
            const list = Array.isArray(baseGlossary) ? [...baseGlossary] : [];
            if (ministerialInfo) {
                list.push({
                    _type: 'ministerial_meta',
                    postTitle: ministerialInfo.postTitle,
                    deptSlug: ministerialInfo.deptSlug,
                    deptName: ministerialInfo.deptName,
                    isWhip: ministerialInfo.isWhip,
                    deptDigest
                });
            }
            return list;
        };

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
                const ai = await summarizeWithGemini(mp, dateStr, speeches, committees, writtenQuestions, mpVotes, ministerialInfo);
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
                    glossary: attachMinisterialMeta(ai.glossary),
                    committee_sessions: committees,
                    votes: fullDayVotes,
                    written_questions: writtenQuestions
                };
            } catch (err) {
                console.warn(`Gemini fallback for ${mp.short_name} (${memberId}): ${err.message}`);

                if (speeches.length > 0 || committees.length > 0) {
                    const uniqueDebates = [...new Set(speeches.map(s => s.debateTitle))].filter(Boolean);
                    const debateList = uniqueDebates.slice(0, 3).join(', ');
                    const committeeNames = [...new Set(committees.map(c => c.committeeName).filter(Boolean))];
                    const committeeClause = committeeNames.length > 0
                        ? ` and participated in ${committeeNames.join(', ')}`
                        : '';
                    const voteClause = mpVotes.length > 0
                        ? ` and cast ${mpVotes.length} recorded division ${mpVotes.length === 1 ? 'vote' : 'votes'}`
                        : '';

                    const summaryPara1 = speeches.length > 0
                        ? `${mp.short_name} spoke in the House of Commons on ${readableDate} during ${debateList}${committeeClause}${voteClause}.`
                        : `${mp.short_name} took part in ${committeeNames.join(', ') || 'Select Committee'} proceedings on ${readableDate}${voteClause}.`;

                    return {
                        parliament_member_id: memberId,
                        sitting_date: dateStr,
                        activity_tag: speeches.length > 0 ? 'Chamber Debate' : 'Select Committee',
                        hansard_ref: speeches[0]?.debateTitle
                            ? `HC Deb ${dateStr} — ${speeches[0].debateTitle}`
                            : `Commons Committees ${dateStr}`,
                        summary_para_1: summaryPara1,
                        summary_para_2: (await getBillContextForDivisions(mpVotes, readableDate)) || `Full verbatim contributions from ${debateList || committeeNames.join(', ') || 'this session'} are recorded in Hansard and parliament.uk.`,
                        verbatim_excerpt: extractCleanExcerpt(speeches[0]?.text, 600),
                        glossary: attachMinisterialMeta([]),
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
                    glossary: attachMinisterialMeta([]),
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
            const ministerNote = ministerialInfo
                ? ` Ministers do not table written questions or sit on select committees; check back at the end of the week for a roundup of ${ministerialInfo.deptName || 'departmental'} activity.`
                : '';

            return {
                parliament_member_id: memberId,
                sitting_date: dateStr,
                activity_tag: mpVotes.length === 1 ? '1 Division Vote' : `${mpVotes.length} Division Votes`,
                hansard_ref: `Commons Votes ${dateStr}`,
                summary_para_1: `${mp.short_name} did not speak in the main Commons Chamber on ${readableDate}, but voted ${firstVote.mpVote} on ${firstVote.title}${extraText}.${ministerNote}`,
                summary_para_2: billContext,
                verbatim_excerpt: null,
                glossary: attachMinisterialMeta([]),
                committee_sessions: [],
                votes: fullDayVotes,
                written_questions: []
            };
        }

        if (ministerialInfo) {
            const deptLabel = ministerialInfo.deptName || 'their government department';
            return {
                parliament_member_id: memberId,
                sitting_date: dateStr,
                activity_tag: 'Ministerial & Departmental Work',
                hansard_ref: `Ministerial Duty • ${dateStr}`,
                summary_para_1: `${mp.short_name} had no spoken Chamber contributions or recorded division votes on ${readableDate}. Ministers do not table written questions or sit on select committees, and typically speak in the Chamber only during their department's question rota or legislation.`,
                summary_para_2: `Most of a minister's working week is spent running ${deptLabel} and attending Cabinet or ministerial meetings. Check back at the end of the week for a roundup of ${deptLabel}'s official announcements.`,
                verbatim_excerpt: null,
                glossary: attachMinisterialMeta([]),
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
