/**
 * Whip - Sunday Morning Weekly MP Briefing Newsletter Sender (`send_weekly_digest.js`)
 *
 * Queries active subscribers in `newsletter_subscribers`, resolves each subscriber's
 * current sitting MP via `constituency_id` (with `parliament_member_id` fallback),
 * compiles the completed parliamentary week (Monday-Friday) for each subscribed MP
 * from `daily_briefings`, renders an editorial plain-English HTML + plain-text email
 * with static vote explainers and one-click unsubscribe links, and sends via Resend.
 *
 * Preview / test modes (do not update subscriber `last_sent_week` or `mp_changed_at`):
 * - `node send_weekly_digest.js --preview` (or `PREVIEW_FILE=preview_email.html`):
 *   Writes HTML preview to disk and prints a summary without sending emails.
 * - `PREVIEW_EMAIL=you@example.com`:
 *   Sends the preview email only to `PREVIEW_EMAIL`.
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

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
const resendApiKey = cleanEnvValue(process.env.RESEND_API_KEY, 'RESEND_API_KEY');
const fromEmail = cleanEnvValue(process.env.NEWSLETTER_FROM_EMAIL, 'NEWSLETTER_FROM_EMAIL') || 'Whip <briefing@whipdaily.uk>';
const siteBaseUrl = (cleanEnvValue(process.env.SITE_BASE_URL, 'SITE_BASE_URL') || 'https://whipdaily.uk').replace(/\/+$/, '');
const dryRun = /^true$/i.test(cleanEnvValue(process.env.DRY_RUN, 'DRY_RUN'));
const targetWeekDateOverride = cleanEnvValue(process.env.TARGET_DATE, 'TARGET_DATE');
const previewEmail = cleanEnvValue(process.env.PREVIEW_EMAIL, 'PREVIEW_EMAIL');
const previewMpQuery = cleanEnvValue(process.env.PREVIEW_MP, 'PREVIEW_MP');
const cliHasPreviewFlag = process.argv.includes('--preview');
const previewFileEnv = cleanEnvValue(process.env.PREVIEW_FILE, 'PREVIEW_FILE');
const previewFilePath = previewFileEnv || (cliHasPreviewFlag ? 'preview_email.html' : '');
const isPreviewOnly = Boolean(previewFilePath) && !previewEmail;

if (!supabaseKey) {
    console.error('Missing SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
}

if (!resendApiKey && !dryRun && !isPreviewOnly) {
    console.error('Missing RESEND_API_KEY (or use --preview / PREVIEW_FILE / DRY_RUN=true).');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function slugify(str) {
    return String(str || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function getConstituencyName(mp) {
    if (mp?.constituencies?.name) return mp.constituencies.name;
    if (mp?.role_title && mp.role_title.includes('MP for ')) {
        return mp.role_title.split('MP for ').pop().trim();
    }
    return 'UK Constituency';
}

function isGovernmentMinister(mp) {
    const role = String(mp?.role_title || '').trim();
    if (!role || !role.includes('• MP for ')) return false;
    const prefix = role.split('• MP for ')[0].trim();
    if (/\b(spokesperson|shadow|opposition|liberal democrat|scottish national party|snp|green party|reform uk|plaid cymru|democratic unionist|dup)\b/i.test(prefix)) {
        return false;
    }
    return /\b(prime minister|chancellor of the exchequer|secretary of state|minister of state|parliamentary under-secretary|minister for|minister of|paymaster general|attorney general|solicitor general|advocate general|lord chancellor|lord president|lord privy seal|leader of the house of commons|chief secretary|financial secretary|economic secretary)\b/i.test(prefix);
}

function classifyChamberSection(title = '') {
    const t = String(title || '').trim();
    if (/^points? of order$/i.test(t)) {
        return { kind: 'point_of_order', label: 'a point of order' };
    }
    if (/^(business of the house|business questions|weekly business|forthcoming business)$/i.test(t)) {
        return { kind: 'business_questions', label: 'Business Questions' };
    }
    if (/urgent question/i.test(t)) {
        return { kind: 'urgent_question', label: 'an Urgent Question' };
    }
    if (/ministerial statement|statement/i.test(t)) {
        return { kind: 'statement', label: 'a ministerial statement' };
    }
    if (/oral answers|questions to |prime minister/i.test(t)) {
        return { kind: 'oral_questions', label: 'Oral Questions' };
    }
    return { kind: 'debate', label: t || 'Commons business' };
}

function rowHasChamberContribution(row) {
    if (!row) return false;
    const tag = String(row.activity_tag || '').trim();
    if (
        tag === 'Non-Sitting Day' ||
        tag === 'Constituency & Parliamentary Work' ||
        tag === 'Ministerial & Departmental Work' ||
        tag === 'Abstentionist MP' ||
        tag === 'Chairing the House' ||
        tag === 'No Vote Recorded' ||
        /^\d+\s+Division Votes?$/i.test(tag) ||
        /^\d+\s+Written Questions?$/i.test(tag) ||
        /^Answered\s+\d+\s+Written Questions?$/i.test(tag) ||
        /^Written Questions/i.test(tag)
    ) {
        return false;
    }
    return Boolean(String(row.summary_para_1 || '').trim());
}

function buildMpSlugMap(mps) {
    const usedSlugs = new Set();
    const slugById = new Map();

    const sorted = [...mps].sort((a, b) =>
        String(a.short_name || '').localeCompare(String(b.short_name || ''))
    );

    for (const mp of sorted) {
        const base = slugify(mp.short_name || mp.full_name || `member-${mp.parliament_member_id}`);
        let candidate = base || `member-${mp.parliament_member_id}`;
        if (usedSlugs.has(candidate)) {
            const seatSlug = slugify(getConstituencyName(mp));
            candidate = seatSlug ? `${base}-${seatSlug}` : `${base}-${mp.parliament_member_id}`;
        }
        if (usedSlugs.has(candidate)) {
            candidate = `${base}-${mp.parliament_member_id}`;
        }
        usedSlugs.add(candidate);
        slugById.set(Number(mp.parliament_member_id), candidate);
    }

    return slugById;
}

function getLondonTodayIso() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/London',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
}

function getMondayOfWeek(isoDate) {
    const d = new Date(`${isoDate}T12:00:00Z`);
    const day = d.getUTCDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + diffToMonday);
    return d.toISOString().slice(0, 10);
}

function getTargetWeekDates() {
    if (/^\d{4}-\d{2}-\d{2}$/.test(targetWeekDateOverride)) {
        const mon = getMondayOfWeek(targetWeekDateOverride);
        const days = [];
        for (let i = 0; i < 5; i++) {
            const d = new Date(`${mon}T12:00:00Z`);
            d.setUTCDate(d.getUTCDate() + i);
            days.push(d.toISOString().slice(0, 10));
        }
        return days;
    }

    const todayIso = getLondonTodayIso();
    const d = new Date(`${todayIso}T12:00:00Z`);
    const currentMon = getMondayOfWeek(todayIso);
    const prevMonDate = new Date(`${currentMon}T12:00:00Z`);
    prevMonDate.setUTCDate(prevMonDate.getUTCDate() - 7);

    const todayDay = d.getUTCDay();
    const targetMon = todayDay === 0 ? currentMon : prevMonDate.toISOString().slice(0, 10);

    const days = [];
    for (let i = 0; i < 5; i++) {
        const dayObj = new Date(`${targetMon}T12:00:00Z`);
        dayObj.setUTCDate(dayObj.getUTCDate() + i);
        days.push(dayObj.toISOString().slice(0, 10));
    }
    return days;
}

function formatShortPillDate(isoDate) {
    const d = new Date(`${isoDate}T12:00:00Z`);
    return d.toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC'
    });
}

function formatWeekRangeLabel(dates) {
    if (!dates || dates.length === 0) return '';
    const sorted = [...dates].sort();
    const first = new Date(`${sorted[0]}T12:00:00Z`);
    const last = new Date(`${sorted[sorted.length - 1]}T12:00:00Z`);
    const startStr = first.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const endStr = last.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    return sorted.length === 1 ? endStr : `${startStr} - ${endStr}`;
}

function formatCleanSubjectList(titles) {
    const unique = [...new Set(titles.map(t =>
        t.replace(/:\s*(Second Reading|Third Reading|Report Stage|Committee|Programme|Money).*$/i, '').trim()
    ))].filter(Boolean);

    if (unique.length === 0) return '';
    if (unique.length === 1) return unique[0];
    if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
    return `${unique[0]}, ${unique[1]}, and ${unique.length - 2} other ${unique.length - 2 === 1 ? 'measure' : 'measures'}`;
}

function resolveDueSubscribers(subscribers, currentMps, weekKey) {
    const currentMpByConstituency = new Map();
    const currentMpById = new Map();

    for (const mp of currentMps || []) {
        currentMpById.set(Number(mp.parliament_member_id), mp);
        if (mp.constituency_id != null) {
            currentMpByConstituency.set(Number(mp.constituency_id), mp);
        }
    }

    const readyToSend = [];
    const vacantSeats = [];

    for (const sub of subscribers || []) {
        if (sub.last_sent_week === weekKey) continue;

        const seatId = sub.constituency_id != null ? Number(sub.constituency_id) : null;
        const resolvedMp = seatId != null
            ? currentMpByConstituency.get(seatId)
            : currentMpById.get(Number(sub.parliament_member_id));

        const seatName = resolvedMp?.constituencies?.name || sub.constituencies?.name || 'your constituency';

        if (!resolvedMp) {
            vacantSeats.push({ subscriber: sub, seatName });
            continue;
        }

        const isNewMpHandover = Boolean(sub.mp_changed_at);
        const handoverNotice = isNewMpHandover
            ? `Representative update: ${resolvedMp.full_name} (${resolvedMp.party}) now represents ${seatName}. Your Sunday briefing has been updated automatically.`
            : null;

        readyToSend.push({
            subscriberId: sub.id,
            email: sub.email,
            unsubscribeToken: sub.unsubscribe_token,
            seatName,
            mp: resolvedMp,
            isNewMpHandover,
            handoverNotice
        });
    }

    return { readyToSend, vacantSeats };
}

function compileWeeklyBriefing(mp, weekDates, rows) {
    const sortedDates = [...weekDates].sort();
    const rowByDate = new Map((rows || []).map(r => [r.sitting_date, r]));

    const activeDayEntries = sortedDates
        .map(d => ({ date: d, row: rowByDate.get(d) }))
        .filter(e => e.row && e.row.activity_tag !== 'Non-Sitting Day');

    const effectiveDates = activeDayEntries.length > 0
        ? activeDayEntries.map(e => e.date)
        : sortedDates;
    const rangeLabel = formatWeekRangeLabel(effectiveDates);

    const isSinnFein = /^sinn\s*f[eé]in$/i.test(String(mp?.party || '').trim());
    const isSpeakerOrDeputy = /\b(speaker|chairman of ways and means|deputy chairman of ways and means)\b/i.test(String(mp?.role_title || ''));
    const isMinister = isGovernmentMinister(mp);

    let deptInfo = null;
    const deptUpdates = [];
    if (isMinister) {
        for (const r of rows || []) {
            if (!Array.isArray(r.glossary)) continue;
            const meta = r.glossary.find(g => g?._type === 'ministerial_meta');
            if (meta) {
                if (!deptInfo) deptInfo = meta;
                if (meta.deptDigest) deptUpdates.push(meta.deptDigest);
            }
        }
    }

    const chamberSpokeEntries = activeDayEntries.filter(e => rowHasChamberContribution(e.row));

    const substantiveEntries = activeDayEntries.filter(e =>
        e.row.activity_tag !== 'Constituency & Parliamentary Work' &&
        e.row.activity_tag !== 'Ministerial & Departmental Work' &&
        e.row.activity_tag !== 'Abstentionist MP' &&
        e.row.activity_tag !== 'Chairing the House' &&
        e.row.activity_tag !== 'No Vote Recorded'
    );

    const combinedVotes = [];
    const combinedWqs = [];
    const combinedCommittees = [];

    for (const { date, row } of activeDayEntries) {
        const dateLabel = formatShortPillDate(date);
        for (const v of (Array.isArray(row.votes) ? row.votes : [])) {
            combinedVotes.push({ ...v, sittingDateLabel: dateLabel });
        }
        for (const q of (Array.isArray(row.written_questions) ? row.written_questions : [])) {
            combinedWqs.push({ ...q, sittingDateLabel: dateLabel });
        }
        for (const c of (Array.isArray(row.committee_sessions) ? row.committee_sessions : [])) {
            combinedCommittees.push({ ...c, sittingDateLabel: dateLabel });
        }
    }

    const activeVoteRows = combinedVotes.filter(v => v.mpVote === 'Aye' || v.mpVote === 'No');

    const spokenContexts = chamberSpokeEntries
        .map(e => (e.row.summary_para_2 || '').trim())
        .filter(txt => txt && !/^Full verbatim contributions are recorded in Hansard/i.test(txt));

    const allContexts = substantiveEntries
        .map(e => (e.row.summary_para_2 || '').trim())
        .filter(txt => txt && !/^Full verbatim contributions are recorded in Hansard/i.test(txt));

    const uniqueContexts = [...new Set(spokenContexts.length > 0 ? spokenContexts : allContexts)];

    let para1 = '';
    let para2 = '';
    let contextHeading = 'Why this matters';
    let activityTag = 'Weekly Roundup';

    if (activeDayEntries.length === 0) {
        activityTag = 'Commons Recess';
        contextHeading = 'What MPs do when Parliament is not sitting';
        para1 = `The House of Commons was not sitting during the week of ${rangeLabel}.\n\nWhen Parliament is in recess or not sitting, MPs focus on constituency surgeries, local visits, and handling urgent casework on behalf of residents.`;
        para2 = `Much of an MP's role happens outside the debating Chamber—writing directly to government departments and public bodies to resolve issues raised by constituents.`;
    } else if (substantiveEntries.length === 0 && combinedWqs.length === 0 && combinedCommittees.length === 0) {
        if (isSinnFein) {
            activityTag = 'Abstentionist MP';
            contextHeading = 'Why Sinn Féin MPs do not sit at Westminster';
            para1 = `${mp.short_name} did not attend the Commons Chamber, sit on committees, table written questions, or vote during the week of ${rangeLabel} in line with Sinn Féin’s policy of abstentionism.\n\nInstead of taking a seat in Westminster, Sinn Féin MPs represent constituents locally in Northern Ireland.`;
            para2 = `Under Section 1 of the Parliamentary Oaths Act 1866, MPs must swear an oath or make a solemn affirmation of allegiance to the Crown before taking their seats in the House of Commons. Sinn Féin MPs do not take the oath, sit in Westminster, or draw an MP salary.`;
        } else if (isSpeakerOrDeputy) {
            activityTag = 'Chairing the House';
            contextHeading = 'Role of the Speaker’s Chair';
            para1 = `${mp.short_name} did not speak in debates or vote in Commons divisions during the week of ${rangeLabel} due to the strict impartiality required of the Speaker’s Chair.`;
            para2 = `By constitutional convention, the Speaker and Deputy Speakers preside over House of Commons debates, keep order, and select amendments—voting only to break a tied result.`;
        } else if (isMinister) {
            activityTag = deptInfo?.deptName || 'Ministerial Duty';
            contextHeading = 'What ministers do outside the Chamber';
            para1 = `${mp.short_name} had no spoken Commons Chamber contributions or recorded division votes during the week of ${rangeLabel}.`;
            para2 = `Ministers do not table written questions or sit on select committees, focusing on running their department and speaking in the Chamber during their department's question rota or legislation.`;
        } else {
            activityTag = `${activeDayEntries.length} Sitting ${activeDayEntries.length === 1 ? 'Day' : 'Days'}`;
            contextHeading = 'What MPs do behind the scenes';
            const missedLine = combinedVotes.length > 0
                ? `\n\nAcross ${combinedVotes.length} Commons ${combinedVotes.length === 1 ? 'vote' : 'votes'} held last week, no vote was recorded for ${mp.short_name}—which can happen when an MP is away on parliamentary business, paired with an opposing MP, or carrying out constituency duties.`
                : '';
            para1 = `${mp.short_name} did not speak in the Commons Chamber, attend a public select committee session, or cast a recorded vote during the week of ${rangeLabel}.\n\nHaving a quiet week on the Chamber floor is common for backbench MPs, particularly when Parliament is debating bills handled by specialist committees.${missedLine}`;
            para2 = `Much of an MP's working week takes place away from the main Chamber—handling urgent constituent casework, meeting local residents, and writing to government ministers on behalf of constituents.`;
        }
    } else if (chamberSpokeEntries.length === 0) {
        const paragraphs = [];
        paragraphs.push(`${mp.short_name} did not speak in the Commons Chamber during the week of ${rangeLabel}, focusing on other parliamentary duties.`);

        if (combinedCommittees.length > 0) {
            const labels = [...new Set(combinedCommittees.map(c => `${c.committeeName} (${c.sittingDateLabel})`))];
            paragraphs.push(`They took part in ${combinedCommittees.length} select committee ${combinedCommittees.length === 1 ? 'session' : 'sessions'}: ${labels.join(', ')}.`);
        }
        if (combinedWqs.length > 0) {
            const askedWqs = combinedWqs.filter(q => q.direction !== 'answered');
            const answeredWqs = combinedWqs.filter(q => q.direction === 'answered');
            if (answeredWqs.length > 0) {
                const depts = [...new Set(answeredWqs.map(q => q.department))];
                const topics = [...new Set(answeredWqs.map(q => q.heading))].slice(0, 2);
                paragraphs.push(`On behalf of ${depts.slice(0, 2).join(' and ')}, ${mp.short_name} answered ${answeredWqs.length} written parliamentary ${answeredWqs.length === 1 ? 'question' : 'questions'} on ${topics.join(' and ')}.`);
            }
            if (askedWqs.length > 0) {
                const depts = [...new Set(askedWqs.map(q => q.department))];
                const topics = [...new Set(askedWqs.map(q => q.heading))].slice(0, 2);
                paragraphs.push(`They tabled ${askedWqs.length} written parliamentary ${askedWqs.length === 1 ? 'question' : 'questions'} to ${depts.slice(0, 2).join(' and ')} on ${topics.join(' and ')}.`);
            }
        }
        if (activeVoteRows.length > 0) {
            const ayeTitles = activeVoteRows.filter(v => v.mpVote === 'Aye').map(v => v.title);
            const noTitles = activeVoteRows.filter(v => v.mpVote === 'No').map(v => v.title);
            const voteParts = [];
            if (ayeTitles.length > 0) voteParts.push(`voting Aye on ${formatCleanSubjectList(ayeTitles)}`);
            if (noTitles.length > 0) voteParts.push(`voting No on ${formatCleanSubjectList(noTitles)}`);

            paragraphs.push(`In the voting lobbies, ${mp.short_name} took part in ${activeVoteRows.length} ${activeVoteRows.length === 1 ? 'division' : 'divisions'}, ${voteParts.join(' and ')}.`);
        }
        para1 = paragraphs.join('\n\n');
        para2 = uniqueContexts[0] || `Much of an MP's parliamentary work takes place in committees, written scrutiny, and division votes outside main Chamber speeches.`;
        activityTag = activeVoteRows.length > 0
            ? `${activeVoteRows.length} ${activeVoteRows.length === 1 ? 'Vote' : 'Votes'}`
            : `${combinedWqs.length} Written ${combinedWqs.length === 1 ? 'Question' : 'Questions'}`;
    } else {
        const dayParagraphs = chamberSpokeEntries.map(({ date, row }) => {
            const body = (row.summary_para_1 || '').trim();
            const subParas = body
                .split(/\n{2,}/)
                .map(s => s.trim())
                .filter(s =>
                    s &&
                    !/^In the voting lobbies,/i.test(s) &&
                    !/routinely spend time handling urgent constituent casework/i.test(s)
                );
            if (subParas.length === 0) return '';

            const sec = classifyChamberSection(row.activity_tag);
            const cleanedFirst = subParas[0]
                .replace(/^On\s+[A-Za-z]+,\s+\d{1,2}\s+[A-Za-z]+\s+\d{4},\s*/i, '')
                .replace(/\s+on\s+[A-Za-z]+,\s+\d{1,2}\s+[A-Za-z]+\s+\d{4}(?=\s+(?:during|in|at)\b)/i, '')
                .replace(/\bdid not speak in the (?:main )?Commons Chamber\b/i, `spoke in the Commons Chamber during ${sec.label}`);

            subParas[0] = `On ${formatShortPillDate(date)}, ${cleanedFirst}`;
            return subParas.join('\n\n');
        }).filter(Boolean);

        if (activeVoteRows.length > 0) {
            dayParagraphs.push(`Across the week, ${mp.short_name} also cast ${activeVoteRows.length} recorded division ${activeVoteRows.length === 1 ? 'vote' : 'votes'}.`);
        }

        para1 = dayParagraphs.join('\n\n');
        para2 = uniqueContexts[0] || `Contributions in the House of Commons Chamber—including debates, Business Questions, Oral Questions, statements, and points of order—place scrutiny and parliamentary business on the official record.`;
        activityTag = `${chamberSpokeEntries.length} Active ${chamberSpokeEntries.length === 1 ? 'Day' : 'Days'}`;
    }

    const deptDigest = isMinister ? (deptUpdates[0] || null) : null;
    return {
        rangeLabel,
        activityTag,
        contextHeading,
        summaryPara1: para1,
        summaryPara2: para2,
        deptName: isMinister ? (deptInfo?.deptName || deptDigest?.deptName || null) : null,
        deptSummary: isMinister ? (deptDigest?.summary || '') : '',
        deptItems: isMinister && Array.isArray(deptDigest?.items) ? deptDigest.items.slice(0, 4) : [],
        committees: combinedCommittees,
        writtenQuestions: combinedWqs,
        votes: combinedVotes
    };
}

function resolveWrittenQuestionAttribution(quoteText, writtenQuestions = []) {
    const cleanQ = String(quoteText || '').replace(/^[“"]|[”"]$/g, '').trim();
    if (!cleanQ) return '';

    const normQuote = cleanQ.toLowerCase().replace(/\s+/g, ' ');
    const matchedWq = (Array.isArray(writtenQuestions) ? writtenQuestions : []).find(q => {
        const qText = String(q.questionText || '').toLowerCase().replace(/\s+/g, ' ');
        const aText = String(q.answerText || '').toLowerCase().replace(/\s+/g, ' ');
        return (qText && (qText.includes(normQuote.slice(0, 60)) || normQuote.includes(qText.slice(0, 60)))) ||
               (aText && (aText.includes(normQuote.slice(0, 60)) || normQuote.includes(aText.slice(0, 60))));
    });

    const askTargetMatch = cleanQ.match(/^To ask (the [^,]+),/i);

    if (matchedWq) {
        if (matchedWq.direction === 'answered') {
            return `Written parliamentary answer on behalf of ${matchedWq.department || 'the Government'}`;
        }
        if (askTargetMatch) {
            return `Written question tabled to ${askTargetMatch[1]}`;
        }
        return `Written question tabled to ${matchedWq.department || 'a government department'}`;
    }

    if (askTargetMatch) {
        return `Written question tabled to ${askTargetMatch[1]}`;
    }

    return '';
}

function renderEmailNarrativeHtml(text, writtenQuestions = []) {
    const paragraphs = String(text || '')
        .split(/\n{2,}/)
        .map(p => p.trim())
        .filter(Boolean);

    const blocks = [];
    for (let i = 0; i < paragraphs.length; i++) {
        const p = paragraphs[i];
        const isStandaloneQuote = /^[“"][^”"]+[”"]$/.test(p);

        if (isStandaloneQuote) {
            let explicitAttr = '';
            const nextPara = paragraphs[i + 1] || '';
            const attrTagMatch = nextPara.match(/^\[WQ_ATTR:\s*([^\]]+)\]$/i);
            if (attrTagMatch) {
                explicitAttr = attrTagMatch[1].trim();
                i += 1;
            }
            const wqCaption = explicitAttr || resolveWrittenQuestionAttribution(p, writtenQuestions);

            blocks.push(`
                <blockquote style="margin: 0 0 18px 0; padding: 2px 0 2px 14px; border-left: 2px solid #E5E7EB;">
                    <p style="margin: 0; font-family: Georgia, 'Times New Roman', serif; font-style: italic; font-size: 16px; line-height: 1.7; color: #111827;">${escapeHtml(p)}</p>
                    ${wqCaption ? `<p style="margin: 6px 0 0 0; font-size: 12px; font-weight: 500; color: #9CA3AF;">${escapeHtml(wqCaption)}</p>` : ''}
                </blockquote>
            `);
            continue;
        }

        const formatted = escapeHtml(p).replace(
            /(“[^”]+”|&quot;[^&]+&quot;)/g,
            '<em style="font-family: Georgia, \'Times New Roman\', serif; font-style: italic; color: #111827;">$1</em>'
        );
        blocks.push(`<p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.7; color: #111827;">${formatted}</p>`);
    }

    return blocks.join('');
}

function renderEmailVotesSection(votes) {
    if (!votes || votes.length === 0) {
        return `<p style="margin: 0; font-size: 14px; color: #4B5563;">No House of Commons division votes were held last week.</p>`;
    }

    const rowsHtml = votes.map(v => {
        const isAye = v.mpVote === 'Aye';
        const isNo = v.mpVote === 'No';
        const pillBg = isAye ? '#E6F0ED' : isNo ? '#FEF2F2' : '#F3F4F6';
        const pillColor = isAye ? '#006548' : isNo ? '#B91C1C' : '#4B5563';
        const badgeLabel = v.mpVote === 'Abstained' ? 'No vote recorded' : `Voted ${v.mpVote}`;

        const exp = v.explainer || {};
        const underlyingSubject = String(exp.underlyingSubject || exp.billSummary || '').trim();
        const amendmentDetails = String(exp.amendmentDetails || '').trim();
        const proposerView = String(exp.proposerView || exp.whatItDoes || '').trim();
        const stageAndMeaning = String(
            exp.stageAndMeaning ||
            exp.stageSummary ||
            (isAye ? exp.whatAyeMeans : isNo ? exp.whatNoMeans : '') ||
            ''
        ).trim();
        const parliamentUrl = String(exp.parliamentUrl || '').trim();

        return `
            <tr>
                <td style="padding: 16px 0; border-bottom: 1px solid #E5E7EB;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                            <td style="font-size: 15px; font-weight: 600; color: #111827; line-height: 1.4;">
                                ${escapeHtml(v.title)}
                            </td>
                            <td align="right" valign="top" style="padding-left: 12px; white-space: nowrap;">
                                <span style="display: inline-block; padding: 3px 10px; font-size: 12px; font-weight: 600; border-radius: 999px; background-color: ${pillBg}; color: ${pillColor};">
                                    ${escapeHtml(badgeLabel)}
                                </span>
                            </td>
                        </tr>
                    </table>
                    <p style="margin: 4px 0 8px 0; font-size: 12px; color: #9CA3AF;">
                        ${escapeHtml(v.houseResult || '')}${v.sittingDateLabel ? ` &middot; ${escapeHtml(v.sittingDateLabel)}` : ''}
                    </p>
                    ${underlyingSubject ? `<p style="margin: 0 0 6px 0; font-size: 13px; line-height: 1.55; color: #4B5563;"><strong style="color: #111827;">What this is about:</strong> ${escapeHtml(underlyingSubject)}</p>` : ''}
                    ${amendmentDetails ? `<p style="margin: 0 0 6px 0; font-size: 13px; line-height: 1.55; color: #4B5563;"><strong style="color: #111827;">The amendment being voted on:</strong> ${escapeHtml(amendmentDetails)}</p>` : ''}
                    ${proposerView ? `<p style="margin: 0 0 6px 0; font-size: 13px; line-height: 1.55; color: #111827;"><strong style="color: #111827;">Why it is being put forward:</strong> ${escapeHtml(proposerView)}</p>` : ''}
                    ${stageAndMeaning ? `<p style="margin: 0; font-size: 12px; line-height: 1.5; color: #4B5563;"><strong style="color: #111827;">Stage in Parliament &amp; what it means:</strong> ${escapeHtml(stageAndMeaning)}${parliamentUrl ? ` &nbsp;<a href="${escapeHtml(parliamentUrl)}" style="color: #006548; text-decoration: none; font-weight: 500;">Official record &rarr;</a>` : ''}</p>` : ''}
                </td>
            </tr>
        `;
    }).join('');

    return `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top: 1px solid #E5E7EB;">
            ${rowsHtml}
        </table>
    `;
}

function renderEmailWrittenQuestionsHtml(questions) {
    if (!questions || questions.length === 0) return '';

    const rowsHtml = questions.slice(0, 6).map(q => {
        const isAns = q.direction === 'answered';
        const badge = isAns
            ? `${escapeHtml(q.department)} &middot; Answered${q.sittingDateLabel ? ` ${escapeHtml(q.sittingDateLabel)}` : ''}`
            : `${escapeHtml(q.department)} &middot; Tabled${q.sittingDateLabel ? ` ${escapeHtml(q.sittingDateLabel)}` : ''}`;

        return `
            <tr>
                <td style="padding: 14px 0; border-bottom: 1px solid #E5E7EB;">
                    <p style="margin: 0 0 4px 0; font-size: 11px; font-weight: 600; color: #006548;">${badge}</p>
                    <p style="margin: 0 0 6px 0; font-size: 14px; font-weight: 600; color: #111827;">${escapeHtml(q.heading)}</p>
