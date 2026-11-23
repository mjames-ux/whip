/**
 * Whip — Step 3: Static MP Page & Sitemap Generator (`build_pages.js`)
 *
 * Reads active MPs and the latest parliamentary week's briefings from Supabase,
 * generates crawlable static HTML pages at `mp/{slug}/index.html` using `index.html`
 * as the layout shell, and writes `sitemap.xml` and `robots.txt` at the repo root.
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const SITE_ORIGIN = 'https://whipdaily.uk';

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

if (!supabaseKey) {
    console.error('Missing SUPABASE_SERVICE_ROLE_KEY.');
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

function renderNarrativeParagraphsHtml(text) {
    const paragraphs = String(text || '')
        .split(/\n{2,}/)
        .map(p => p.trim())
        .filter(Boolean);

    if (paragraphs.length === 0) return '';

    return paragraphs.map(p => {
        const escaped = escapeHtml(p).replace(
            /(“[^”]+”|&quot;[^&]+&quot;)/g,
            '<em class="font-editorial italic text-ink">$1</em>'
        );
        return `<p class="text-[17px] sm:text-[19px] leading-[1.75] text-ink font-normal tracking-[-0.01em]">${escaped}</p>`;
    }).join('\n                        ');
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

function buildUniqueMpSlugs(mps) {
    const slugByMemberId = new Map();
    const usedSlugs = new Set();

    for (const mp of mps) {
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
        slugByMemberId.set(mp.parliament_member_id, candidate);
    }

    return slugByMemberId;
}

function getMondayOfWeek(isoDate) {
    const d = new Date(`${isoDate}T12:00:00Z`);
    const day = d.getUTCDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + diffToMonday);
    return d.toISOString().slice(0, 10);
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

function buildStaticWeeklySummary(mp, weekDates, rows) {
    const sortedDates = [...weekDates].sort();
    const rowByDate = new Map((rows || []).map(r => [r.sitting_date, r]));
    const rangeLabel = formatWeekRangeLabel(sortedDates);

    const isSinnFein = /^sinn\s*f[eé]in$/i.test(String(mp?.party || '').trim());
    const isSpeakerOrDeputy = /\b(speaker|chairman of ways and means|deputy chairman of ways and means)\b/i.test(String(mp?.role_title || ''));
    const isMinister = Boolean(mp.role_title && mp.role_title.includes('• MP for '));
    const postTitle = isMinister ? mp.role_title.split('• MP for ')[0].trim() : null;

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

    const activeDayEntries = sortedDates
        .map(d => ({ date: d, row: rowByDate.get(d) }))
        .filter(e => e.row && e.row.activity_tag !== 'Non-Sitting Day');

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

    if (substantiveEntries.length === 0 && combinedWqs.length === 0 && combinedCommittees.length === 0) {
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
        para1,
        para2,
        postTitle,
        deptName: deptInfo?.deptName || deptDigest?.deptName || null,
        deptSummary: deptDigest?.summary || '',
        deptItems: Array.isArray(deptDigest?.items) ? deptDigest.items.slice(0, 4) : [],
        committees: combinedCommittees,
        writtenQuestions: combinedWqs,
        votes: combinedVotes
    };
}

function renderStaticMpPage(templateHtml, mp, slug, weekly) {
    const seatName = getConstituencyName(mp);
    const roleDisplay = mp.role_title || `MP for ${seatName}`;
    const canonicalUrl = `${SITE_ORIGIN}/mp/${slug}/`;
    const pageTitle = `${mp.full_name} (${seatName}) — Parliament Briefing | Whip`;
    const flatSummary = weekly.para1.replace(/\n+/g, ' ');
    const metaDesc = `${mp.full_name} (${mp.party}, ${roleDisplay}): ${flatSummary}`.slice(0, 160);

    const jsonLd = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Person',
        name: mp.full_name,
        jobTitle: roleDisplay,
        affiliation: {
            '@type': 'Organization',
            name: mp.party
        },
        url: canonicalUrl,
        sameAs: `https://members.parliament.uk/member/${mp.parliament_member_id}/contact`
    });

    const seoHeadTags = `
    <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
    <meta property="og:type" content="article">
    <meta property="og:site_name" content="Whip">
    <meta property="og:title" content="${escapeHtml(pageTitle)}">
    <meta property="og:description" content="${escapeHtml(metaDesc)}">
    <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="${escapeHtml(pageTitle)}">
    <meta name="twitter:description" content="${escapeHtml(metaDesc)}">
    <script type="application/ld+json">${jsonLd}</script>
    <script>window.__WHIP_INITIAL_MP_SLUG__ = ${JSON.stringify(slug)};</script>`;

    let html = templateHtml;

    html = html.replace(
        /<title>[\s\S]*?<\/title>/,
        `<title>${escapeHtml(pageTitle)}</title>`
    );
    html = html.replace(
        /<meta name="description" content="[^"]*">/,
        `<meta name="description" content="${escapeHtml(metaDesc)}">${seoHeadTags}`
    );

    html = html
        .replace('id="topMasthead" class="hidden ', 'id="topMasthead" class="')
        .replace('id="landingHero" class="', 'id="landingHero" class="hidden ')
        .replace('id="landingCaption" class="', 'id="landingCaption" class="hidden ')
        .replace('id="briefingWorkspace" class="hidden ', 'id="briefingWorkspace" class="');

    const narrativeHtml = renderNarrativeParagraphsHtml(weekly.para1);

    html = html
        .replace('id="sittingDateDisplay" class="text-xs sm:text-sm font-medium text-inkSecondary tracking-tight mb-6">\n                Loading parliamentary record...', `id="sittingDateDisplay" class="text-xs sm:text-sm font-medium text-inkSecondary tracking-tight mb-6">\n                Week in Parliament (${escapeHtml(weekly.rangeLabel)})`)
        .replace('id="mpPartyName" class="text-ink">—</span>', `id="mpPartyName" class="text-ink">${escapeHtml(mp.party)}</span>`)
        .replace('id="mpConstituency">—</span>', `id="mpConstituency">${escapeHtml(seatName)}</span>`)
        .replace('id="mpName" class="font-editorial text-4xl sm:text-5xl font-bold text-ink tracking-[-0.025em] leading-[1.08]">\n                            Loading MP...', `id="mpName" class="font-editorial text-4xl sm:text-5xl font-bold text-ink tracking-[-0.025em] leading-[1.08]">\n                            ${escapeHtml(mp.full_name)}`)
        .replace('id="mpRole">—</span>', `id="mpRole">${escapeHtml(roleDisplay)}</span>`)
        .replace('id="activityBadge" class="text-inkTertiary">—</span>', `id="activityBadge" class="text-inkTertiary">${escapeHtml(weekly.activityTag)}</span>`)
        .replace('<div id="summaryNarrativeBody" class="space-y-4">\n                            <p class="text-[17px] sm:text-[19px] leading-[1.75] text-ink font-normal tracking-[-0.01em]">Fetching parliamentary record...</p>\n                        </div>', `<div id="summaryNarrativeBody" class="space-y-4">\n                            ${narrativeHtml}\n                        </div>`)
        .replace('id="contextHeading" class="text-xs font-semibold uppercase tracking-[0.12em] text-commonsGreen mb-2">\n                                Why this matters', `id="contextHeading" class="text-xs font-semibold uppercase tracking-[0.12em] text-commonsGreen mb-2">\n                                ${escapeHtml(weekly.contextHeading)}`)
        .replace('id="summaryPara2" class="text-[15px] sm:text-base leading-[1.75] text-inkSecondary">\n                                Loading background context...', `id="summaryPara2" class="text-[15px] sm:text-base leading-[1.75] text-inkSecondary">\n                                ${escapeHtml(weekly.para2)}`)
        .replace('id="hansardRefTag" class="text-xs text-inkTertiary font-mono">\n                                —', `id="hansardRefTag" class="text-xs text-inkTertiary font-mono">\n                                Week of ${escapeHtml(weekly.rangeLabel)}`);

    if (weekly.deptSummary) {
        const deptItemsHtml = weekly.deptItems.map(item => `
            <a href="${escapeHtml(item.url || 'https://www.gov.uk/')}" target="_blank" rel="noopener noreferrer" class="py-4 flex items-center justify-between gap-4 group">
                <div class="min-w-0">
                    <p class="text-sm font-medium text-ink">${escapeHtml(item.title)}</p>
                </div>
                <span aria-hidden="true" class="text-sm text-inkTertiary shrink-0">&rarr;</span>
            </a>
        `).join('');

        html = html
            .replace('id="departmentActivitySection" aria-label="Departmental Activity" class="hidden ', 'id="departmentActivitySection" aria-label="Departmental Activity" class="')
            .replace('id="departmentNameBadge" class="text-xs text-inkTertiary font-medium">\n                                GOV.UK', `id="departmentNameBadge" class="text-xs text-inkTertiary font-medium">\n                                ${escapeHtml(weekly.deptName || 'GOV.UK')}`)
            .replace('id="departmentSummaryText" class="text-sm sm:text-base text-inkSecondary leading-relaxed mb-6">\n                            —', `id="departmentSummaryText" class="text-sm sm:text-base text-inkSecondary leading-relaxed mb-6">\n                            ${escapeHtml(weekly.deptSummary)}`)
            .replace('<!-- Populated dynamically via JS -->\n                        </div>\n                    </section>\n\n                    <!-- 3. Select Committees', `${deptItemsHtml}\n                        </div>\n                    </section>\n\n                    <!-- 3. Select Committees`);
    }

    if (weekly.committees.length > 0) {
        const commHtml = weekly.committees.map(c => `
            <div class="py-5 space-y-2">
                <span class="text-xs font-medium text-commonsGreen">${escapeHtml(c.committeeName)} • ${escapeHtml(c.sittingDateLabel)}</span>
                <p class="text-sm font-medium text-ink">${escapeHtml(c.title || c.committeeName)}</p>
            </div>
        `).join('');

        html = html
            .replace('id="committeeSessionsSection" aria-label="Select Committee Work" class="hidden ', 'id="committeeSessionsSection" aria-label="Select Committee Work" class="')
            .replace('id="committeeCountBadge" class="text-xs text-inkTertiary font-medium">\n                                0 sessions', `id="committeeCountBadge" class="text-xs text-inkTertiary font-medium">\n                                ${weekly.committees.length} ${weekly.committees.length === 1 ? 'session' : 'sessions'}`)
            .replace('id="committeeSessionsList" class="divide-y divide-hairline border-t border-b border-hairline">\n                            <!-- Populated dynamically via JS -->', `id="committeeSessionsList" class="divide-y divide-hairline border-t border-b border-hairline">\n                            ${commHtml}`);
    }

    if (weekly.writtenQuestions.length > 0) {
        const wqHtml = weekly.writtenQuestions.map(q => {
            const isAns = q.direction === 'answered';
            const label = isAns
                ? `${escapeHtml(q.department)} • Answered ${escapeHtml(q.sittingDateLabel)}`
                : `${escapeHtml(q.department)} • Tabled ${escapeHtml(q.sittingDateLabel)}`;
            return `
                <div class="py-5 space-y-2">
                    <span class="text-xs font-medium text-commonsGreen">${label}</span>
                    <p class="text-sm font-medium text-ink">${escapeHtml(q.heading)}</p>
                    <p class="text-xs text-inkSecondary">${escapeHtml(q.answerText || q.questionText || '')}</p>
                </div>
            `;
        }).join('');

        html = html
            .replace('id="writtenQuestionsSection" aria-label="Written Parliamentary Questions" class="hidden ', 'id="writtenQuestionsSection" aria-label="Written Parliamentary Questions" class="')
            .replace('id="wqCountBadge" class="text-xs text-inkTertiary font-medium">\n                                0 questions', `id="wqCountBadge" class="text-xs text-inkTertiary font-medium">\n                                ${weekly.writtenQuestions.length} ${weekly.writtenQuestions.length === 1 ? 'question' : 'questions'}`)
            .replace('id="writtenQuestionsList" class="divide-y divide-hairline border-t border-b border-hairline">\n                            <!-- Populated dynamically via JS -->', `id="writtenQuestionsList" class="divide-y divide-hairline border-t border-b border-hairline">\n                            ${wqHtml}`);
    }

    if (weekly.votes.length > 0) {
        const votesHtml = weekly.votes.map(v => `
            <div class="py-4 flex items-center justify-between gap-3">
                <div>
                    <p class="text-sm font-medium text-ink">${escapeHtml(v.title)}</p>
                    <p class="text-xs text-inkTertiary mt-1">${escapeHtml(v.houseResult || '')} • ${escapeHtml(v.sittingDateLabel)}</p>
                </div>
                <span class="px-3 py-1 rounded-full text-xs font-medium border border-hairline">${v.mpVote === 'Abstained' ? 'No vote recorded' : `Voted ${escapeHtml(v.mpVote)}`}</span>
            </div>
        `).join('');

        html = html
            .replace('id="voteCountBadge" class="text-xs text-inkTertiary font-medium">\n                                0 divisions', `id="voteCountBadge" class="text-xs text-inkTertiary font-medium">\n                                ${weekly.votes.length} ${weekly.votes.length === 1 ? 'division' : 'divisions'}`)
            .replace('id="votingRecordsList" class="divide-y divide-hairline border-t border-b border-hairline">\n                            <!-- Populated dynamically via JS -->', `id="votingRecordsList" class="divide-y divide-hairline border-t border-b border-hairline">\n                            ${votesHtml}`);
    }

    return html;
}

export async function buildPages() {
    console.log(`[${new Date().toISOString()}] Building static MP pages & sitemap...`);

    const templatePath = path.resolve('index.html');
    const templateHtml = await fs.readFile(templatePath, 'utf8');

    const { data: mps, error: mpError } = await supabase
        .from('mps')
        .select('parliament_member_id, full_name, short_name, party, party_color, role_title, member_since, constituencies(name)')
        .eq('is_current_member', true)
        .order('short_name', { ascending: true });

    if (mpError || !mps?.length) {
        throw new Error(`Failed to fetch active MPs: ${mpError?.message || '0 rows'}`);
    }

    const probeId = mps[0].parliament_member_id;
    const { data: recentDatesData } = await supabase
        .from('daily_briefings')
        .select('sitting_date, activity_tag')
        .eq('parliament_member_id', probeId)
        .order('sitting_date', { ascending: false })
        .limit(14);

    const activeDates = [...new Set(
        (recentDatesData || [])
            .filter(r => r.activity_tag !== 'Non-Sitting Day')
            .map(r => r.sitting_date)
    )];
    const latestMonday = activeDates[0] ? getMondayOfWeek(activeDates[0]) : null;
    const latestWeekDates = latestMonday
        ? activeDates.filter(d => getMondayOfWeek(d) === latestMonday)
        : [];

    const rowsByMember = new Map();
    if (latestWeekDates.length > 0) {
        const { data: allWeekRows, error: rowsErr } = await supabase
            .from('daily_briefings')
            .select('*')
            .in('sitting_date', latestWeekDates);

        if (rowsErr) {
            throw new Error(`Failed to fetch weekly briefings: ${rowsErr.message}`);
        }

        for (const r of allWeekRows || []) {
            if (!rowsByMember.has(r.parliament_member_id)) {
                rowsByMember.set(r.parliament_member_id, []);
            }
            rowsByMember.get(r.parliament_member_id).push(r);
        }
    }

    const slugByMemberId = buildUniqueMpSlugs(mps);
    const mpRootDir = path.resolve('mp');
    await fs.rm(mpRootDir, { recursive: true, force: true });
    await fs.mkdir(mpRootDir, { recursive: true });

    const todayIso = new Date().toISOString().slice(0, 10);
    const sitemapUrls = [
        `  <url>\n    <loc>${SITE_ORIGIN}/</loc>\n    <lastmod>${todayIso}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>`
    ];

    for (const mp of mps) {
        const slug = slugByMemberId.get(mp.parliament_member_id);
        const rows = rowsByMember.get(mp.parliament_member_id) || [];
        const weekly = buildStaticWeeklySummary(mp, latestWeekDates, rows);
        const pageHtml = renderStaticMpPage(templateHtml, mp, slug, weekly);

        const dir = path.join(mpRootDir, slug);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'index.html'), pageHtml, 'utf8');

        sitemapUrls.push(
            `  <url>\n    <loc>${SITE_ORIGIN}/mp/${slug}/</loc>\n    <lastmod>${todayIso}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.8</priority>\n  </url>`
        );
    }

    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapUrls.join('\n')}\n</urlset>\n`;
    await fs.writeFile(path.resolve('sitemap.xml'), sitemapXml, 'utf8');

    const robotsTxt = `User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`;
    await fs.writeFile(path.resolve('robots.txt'), robotsTxt, 'utf8');

    console.log(`[${new Date().toISOString()}] Generated ${mps.length} static MP pages + sitemap.xml + robots.txt.`);
}

buildPages();
