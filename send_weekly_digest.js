/**
 * Whip — Sunday Morning Weekly MP Briefing Newsletter Sender (`send_weekly_newsletter.js`)
 *
 * Queries active subscribers in `newsletter_subscribers`, compiles the completed
 * parliamentary week (Monday–Friday) for each subscribed MP from `daily_briefings`,
 * renders an editorial plain-English HTML + plain-text email with static vote
 * explainers and one-click unsubscribe links, and sends via Resend.
 */

import 'dotenv/config';
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

if (!supabaseKey) {
    console.error('Missing SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
}

if (!resendApiKey && !dryRun) {
    console.error('Missing RESEND_API_KEY (or set DRY_RUN=true to preview without sending).');
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
    return sorted.length === 1 ? endStr : `${startStr} – ${endStr}`;
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
    const isMinister = Boolean(mp.role_title && mp.role_title.includes('• MP for '));

    let deptInfo = null;
    const deptUpdates = [];
    for (const r of rows || []) {
        if (!Array.isArray(r.glossary)) continue;
        const meta = r.glossary.find(g => g?._type === 'ministerial_meta');
        if (meta) {
            if (!deptInfo) deptInfo = meta;
            if (meta.deptDigest) deptUpdates.push(meta.deptDigest);
        }
    }

    const substantiveEntries = activeDayEntries.filter(e =>
        e.row.activity_tag !== 'Constituency & Parliamentary Work' &&
        e.row.activity_tag !== 'Ministerial & Departmental Work' &&
        e.row.activity_tag !== 'Abstentionist MP' &&
        e.row.activity_tag !== 'Chairing the House' &&
        e.row.activity_tag !== 'No Vote Recorded'
    );

    const spokenOrCommitteeEntries = substantiveEntries.filter(e =>
        !/^\d+\s+Division Votes?$/i.test(e.row.activity_tag || '') &&
        !/^\d+\s+Written Questions?$/i.test(e.row.activity_tag || '') &&
        !/^Answered\s+\d+\s+Written Questions?$/i.test(e.row.activity_tag || '') &&
        !/^Written Questions/i.test(e.row.activity_tag || '')
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

    const spokenContexts = spokenOrCommitteeEntries
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
    } else if (spokenOrCommitteeEntries.length === 0) {
        const paragraphs = [];
        paragraphs.push(`${mp.short_name} did not speak in the main Commons Chamber during the week of ${rangeLabel}, focusing on other parliamentary duties.`);

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
        const dayParagraphs = spokenOrCommitteeEntries.map(({ date, row }) => {
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

            const cleanedFirst = subParas[0]
                .replace(/^On\s+[A-Za-z]+,\s+\d{1,2}\s+[A-Za-z]+\s+\d{4},\s*/i, '')
                .replace(/\s+on\s+[A-Za-z]+,\s+\d{1,2}\s+[A-Za-z]+\s+\d{4}(?=\s+(?:during|in|at)\b)/i, '');

            subParas[0] = `On ${formatShortPillDate(date)}, ${cleanedFirst}`;
            return subParas.join('\n\n');
        }).filter(Boolean);

        if (activeVoteRows.length > 0) {
            dayParagraphs.push(`Across the week, ${mp.short_name} also cast ${activeVoteRows.length} recorded division ${activeVoteRows.length === 1 ? 'vote' : 'votes'}.`);
        }

        para1 = dayParagraphs.join('\n\n');
        para2 = uniqueContexts[0] || `Debates in the House of Commons allow MPs to question ministers, put local concerns on the official record, and scrutinise proposals before laws are passed.`;
        activityTag = `${spokenOrCommitteeEntries.length} Active ${spokenOrCommitteeEntries.length === 1 ? 'Day' : 'Days'}`;
    }

    const deptDigest = deptUpdates[0] || null;
    return {
        rangeLabel,
        activityTag,
        contextHeading,
        summaryPara1: para1,
        summaryPara2: para2,
        deptName: deptInfo?.deptName || deptDigest?.deptName || null,
        deptSummary: deptDigest?.summary || '',
        deptItems: Array.isArray(deptDigest?.items) ? deptDigest.items.slice(0, 4) : [],
        committees: combinedCommittees,
        writtenQuestions: combinedWqs,
        votes: combinedVotes
    };
}

function renderEmailNarrativeHtml(text) {
    return String(text || '')
        .split(/\n{2,}/)
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => {
            const formatted = escapeHtml(p).replace(
                /(“[^”]+”|&quot;[^&]+&quot;)/g,
                '<em style="font-family: Georgia, \'Times New Roman\', serif; font-style: italic; color: #111827;">$1</em>'
            );
            return `<p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.7; color: #111827;">${formatted}</p>`;
        })
        .join('');
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

        const voteMeaning = isAye
            ? v.explainer?.whatAyeMeans
            : isNo
                ? v.explainer?.whatNoMeans
                : null;

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
                    ${v.explainer?.whatItDoes ? `<p style="margin: 0 0 6px 0; font-size: 13px; line-height: 1.55; color: #4B5563;">${escapeHtml(v.explainer.whatItDoes)}</p>` : ''}
                    ${voteMeaning ? `<p style="margin: 0; font-size: 12px; line-height: 1.5; color: #4B5563;"><strong style="color: #111827;">What their vote meant:</strong> ${escapeHtml(voteMeaning)}${v.explainer?.parliamentUrl ? ` &nbsp;<a href="${escapeHtml(v.explainer.parliamentUrl)}" style="color: #006548; text-decoration: none; font-weight: 500;">Official record &rarr;</a>` : ''}</p>` : ''}
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
                    <p style="margin: 0 0 6px 0; font-size: 13px; line-height: 1.55; color: #4B5563;">${escapeHtml(q.answerText || q.questionText || '')}</p>
                    ${q.url ? `<a href="${escapeHtml(q.url)}" style="font-size: 12px; font-weight: 500; color: #006548; text-decoration: none;">View on Parliament.uk &rarr;</a>` : ''}
                </td>
            </tr>
        `;
    }).join('');

    return `
        <div style="margin-top: 32px;">
            <h2 style="margin: 0 0 12px 0; font-family: Georgia, 'Times New Roman', serif; font-size: 20px; font-weight: 700; color: #111827;">
                Written Parliamentary Questions (${questions.length})
            </h2>
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top: 1px solid #E5E7EB;">
                ${rowsHtml}
            </table>
        </div>
    `;
}

function renderEmailCommitteesHtml(committees) {
    if (!committees || committees.length === 0) return '';

    const rowsHtml = committees.map(c => `
        <tr>
            <td style="padding: 14px 0; border-bottom: 1px solid #E5E7EB;">
                <p style="margin: 0 0 4px 0; font-size: 11px; font-weight: 600; color: #006548;">
                    ${escapeHtml(c.committeeName)}${c.sittingDateLabel ? ` &middot; ${escapeHtml(c.sittingDateLabel)}` : ''}
                </p>
                <p style="margin: 0 0 4px 0; font-size: 14px; font-weight: 600; color: #111827;">${escapeHtml(c.title || c.committeeName)}</p>
                <p style="margin: 0; font-size: 12px; color: #4B5563;">${escapeHtml(c.role || 'Committee Member')}</p>
            </td>
        </tr>
    `).join('');

    return `
        <div style="margin-top: 32px;">
            <h2 style="margin: 0 0 12px 0; font-family: Georgia, 'Times New Roman', serif; font-size: 20px; font-weight: 700; color: #111827;">
                Select Committee Work (${committees.length})
            </h2>
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top: 1px solid #E5E7EB;">
                ${rowsHtml}
            </table>
        </div>
    `;
}

function buildNewsletterEmail({ mp, mpSlug, briefing, unsubscribeToken }) {
    const seat = getConstituencyName(mp);
    const mpPageUrl = `${siteBaseUrl}/mp/${mpSlug}/`;
    const unsubscribeUrl = `${siteBaseUrl}/?unsubscribe=${encodeURIComponent(unsubscribeToken)}`;
    const dotColor = mp.party_color || '#006548';

    const subject = `${mp.short_name} in Parliament: ${briefing.rangeLabel}`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #FAFAFA; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #111827;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #FAFAFA; padding: 24px 12px;">
        <tr>
            <td align="center">
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 620px; background-color: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 16px; overflow: hidden;">
                    <!-- Top Masthead -->
                    <tr>
                        <td style="padding: 22px 28px; border-bottom: 1px solid #E5E7EB;">
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td style="font-family: Georgia, 'Times New Roman', serif; font-size: 24px; font-weight: 700; color: #111827;">
                                        Whip<span style="color: #006548;">.</span>
                                    </td>
                                    <td align="right" style="font-size: 12px; color: #9CA3AF;">
                                        Sunday Briefing &middot; ${escapeHtml(briefing.rangeLabel)}
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- MP Identity Header -->
                    <tr>
                        <td style="padding: 28px 28px 22px 28px; border-bottom: 1px solid #E5E7EB;">
                            <p style="margin: 0 0 8px 0; font-size: 12px; font-weight: 500; color: #4B5563;">
                                <span style="display: inline-block; width: 8px; height: 8px; border-radius: 999px; background-color: ${escapeHtml(dotColor)}; margin-right: 6px; vertical-align: middle;"></span>
                                <strong style="color: #111827;">${escapeHtml(mp.party || 'Independent')}</strong>
                                <span style="color: #9CA3AF;"> / </span>
                                ${escapeHtml(seat)}
                            </p>
                            <h1 style="margin: 0; font-family: Georgia, 'Times New Roman', serif; font-size: 32px; font-weight: 700; color: #111827; line-height: 1.15;">
                                ${escapeHtml(mp.full_name)}
                            </h1>
                            <p style="margin: 8px 0 0 0; font-size: 13px; color: #4B5563;">
                                ${escapeHtml(mp.role_title || `MP for ${seat}`)} &middot; <span style="color: #9CA3AF;">${escapeHtml(briefing.activityTag)}</span>
                            </p>
                        </td>
                    </tr>

                    <!-- Main Narrative -->
                    <tr>
                        <td style="padding: 28px;">
                            ${renderEmailNarrativeHtml(briefing.summaryPara1)}

                            <!-- Why This Matters Callout -->
                            <div style="margin-top: 20px; padding: 14px 16px; border-left: 3px solid #006548; background-color: #FAFAFA; border-radius: 0 10px 10px 0;">
                                <p style="margin: 0 0 6px 0; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #006548;">
                                    ${escapeHtml(briefing.contextHeading)}
                                </p>
                                <p style="margin: 0; font-size: 14px; line-height: 1.65; color: #4B5563;">
                                    ${escapeHtml(briefing.summaryPara2)}
                                </p>
                            </div>

                            ${renderEmailCommitteesHtml(briefing.committees)}
                            ${renderEmailWrittenQuestionsHtml(briefing.writtenQuestions)}

                            <!-- Voting Record with Static Explainers -->
                            <div style="margin-top: 32px;">
                                <h2 style="margin: 0 0 12px 0; font-family: Georgia, 'Times New Roman', serif; font-size: 20px; font-weight: 700; color: #111827;">
                                    Voting Record (${briefing.votes.length})
                                </h2>
                                ${renderEmailVotesSection(briefing.votes)}
                            </div>

                            <!-- CTA Button -->
                            <div style="margin-top: 32px; text-align: center;">
                                <a href="${escapeHtml(mpPageUrl)}" style="display: inline-block; padding: 12px 22px; background-color: #111827; color: #FFFFFF; font-size: 13px; font-weight: 600; text-decoration: none; border-radius: 10px;">
                                    View full record &amp; profile on Whip &rarr;
                                </a>
                            </div>
                        </td>
                    </tr>

                    <!-- Footer & One-Click Unsubscribe -->
                    <tr>
                        <td style="padding: 20px 28px; background-color: #FAFAFA; border-top: 1px solid #E5E7EB; font-size: 12px; color: #9CA3AF; line-height: 1.6;">
                            <p style="margin: 0 0 6px 0;">
                                You are receiving this Sunday briefing because you subscribed to updates on <strong style="color: #4B5563;">${escapeHtml(mp.full_name)}</strong>.
                            </p>
                            <p style="margin: 0;">
                                <a href="${escapeHtml(unsubscribeUrl)}" style="color: #006548; text-decoration: underline;">Unsubscribe with one click</a>
                                &nbsp;&middot;&nbsp;
                                Contains Parliamentary information licensed under the Open Parliament Licence v3.0.
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

    const text = [
        `WHIP — Sunday Briefing (${briefing.rangeLabel})`,
        `${mp.full_name} (${mp.party} — ${seat})`,
        `${mp.role_title || `MP for ${seat}`} • ${briefing.activityTag}`,
        ``,
        briefing.summaryPara1,
        ``,
        `${briefing.contextHeading.toUpperCase()}:`,
        briefing.summaryPara2,
        ``,
        briefing.votes.length > 0
            ? `VOTING RECORD:\n` + briefing.votes.map(v => {
                const meaning = v.mpVote === 'Aye' ? v.explainer?.whatAyeMeans : v.mpVote === 'No' ? v.explainer?.whatNoMeans : '';
                return `- ${v.title} [${v.mpVote === 'Abstained' ? 'No vote recorded' : `Voted ${v.mpVote}`}]\n  ${v.explainer?.whatItDoes || ''}${meaning ? `\n  What their vote meant: ${meaning}` : ''}`;
            }).join('\n')
            : `VOTING RECORD:\nNo House of Commons division votes were held last week.`,
        ``,
        `Full record: ${mpPageUrl}`,
        `Unsubscribe: ${unsubscribeUrl}`
    ].join('\n');

    return { subject, html, text };
}

async function sendViaResend({ to, subject, html, text }) {
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from: fromEmail,
            to: [to],
            subject,
            html,
            text
        }),
        signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Resend HTTP ${res.status}: ${errBody.slice(0, 220)}`);
    }

    return res.json();
}

export async function sendWeeklyNewsletters() {
    const weekDates = getTargetWeekDates();
    const weekKey = weekDates[0];

    console.log(
        `[${new Date().toISOString()}] Running Whip Sunday Newsletter for week ${weekDates[0]}..${weekDates[weekDates.length - 1]} ` +
        `(DRY_RUN: ${dryRun})`
    );

    const { data: subscribers, error: subErr } = await supabase
        .from('newsletter_subscribers')
        .select('id, email, parliament_member_id, unsubscribe_token, last_sent_week')
        .eq('is_active', true);

    if (subErr) {
        throw new Error(`Failed loading newsletter_subscribers: ${subErr.message}`);
    }

    if (!subscribers || subscribers.length === 0) {
        console.log('No active newsletter subscribers found. Exiting.');
        return;
    }

    const dueSubscribers = subscribers.filter(s => s.last_sent_week !== weekKey);
    if (dueSubscribers.length === 0) {
        console.log(`All ${subscribers.length} active subscribers have already been sent the ${weekKey} edition.`);
        return;
    }

    const { data: mps, error: mpErr } = await supabase
        .from('mps')
        .select('parliament_member_id, full_name, short_name, party, party_color, role_title, constituencies(name)')
        .eq('is_current_member', true);

    if (mpErr || !mps?.length) {
        throw new Error(`Failed loading MPs: ${mpErr?.message || '0 rows'}`);
    }

    const mpById = new Map(mps.map(m => [Number(m.parliament_member_id), m]));
    const slugById = buildMpSlugMap(mps);

    const subscribedMpIds = [...new Set(
        dueSubscribers
            .map(s => Number(s.parliament_member_id))
            .filter(id => mpById.has(id))
    )];

    const briefingByMpId = new Map();
    for (const mpId of subscribedMpIds) {
        const mp = mpById.get(mpId);
        const { data: rows, error: rowErr } = await supabase
            .from('daily_briefings')
            .select('*')
            .eq('parliament_member_id', mpId)
            .in('sitting_date', weekDates);

        if (rowErr) {
            console.warn(`Warning fetching briefings for MP ${mpId}: ${rowErr.message}`);
            continue;
        }

        briefingByMpId.set(mpId, compileWeeklyBriefing(mp, weekDates, rows || []));
    }

    let sentCount = 0;
    let failCount = 0;

    for (const sub of dueSubscribers) {
        const mpId = Number(sub.parliament_member_id);
        const mp = mpById.get(mpId);
        const briefing = briefingByMpId.get(mpId);
        if (!mp || !briefing) continue;

        const mpSlug = slugById.get(mpId) || '';
        const { subject, html, text } = buildNewsletterEmail({
            mp,
            mpSlug,
            briefing,
            unsubscribeToken: sub.unsubscribe_token
        });

        if (dryRun) {
            console.log(`[DRY RUN] Would send "${subject}" to ${sub.email}`);
            sentCount += 1;
            continue;
        }

        try {
            await sendViaResend({ to: sub.email, subject, html, text });
            await supabase
                .from('newsletter_subscribers')
                .update({ last_sent_week: weekKey, last_sent_at: new Date().toISOString() })
                .eq('id', sub.id);
            sentCount += 1;
        } catch (err) {
            failCount += 1;
            console.warn(`Failed sending to ${sub.email}: ${err.message}`);
        }
    }

    console.log(
        `[${new Date().toISOString()}] Finished Sunday newsletter run: ${sentCount} sent, ${failCount} failed.`
    );
}

sendWeeklyNewsletters();
