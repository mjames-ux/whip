/**
 * Whip - Step 3: Weekly Sunday Email Digest Sender (`send_weekly_digest.js`)
 *
 * Groups active rows in `newsletter_subscribers` by email address so a subscriber
 * following multiple MPs (e.g. Wes Streeting + James Cleverley) receives ONE
 * combined Sunday morning email covering all of their MPs, costing a single email send.
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
const fromEmail = cleanEnvValue(process.env.DIGEST_FROM_EMAIL, 'DIGEST_FROM_EMAIL') || 'Whip. <briefing@whipdaily.uk>';
const siteBaseUrl = (cleanEnvValue(process.env.SITE_BASE_URL, 'SITE_BASE_URL') || 'https://whipdaily.uk').replace(/\/+$/, '');
const dryRun = /^true$/i.test(cleanEnvValue(process.env.DRY_RUN, 'DRY_RUN'));
const testRecipient = cleanEnvValue(process.env.TEST_EMAIL, 'TEST_EMAIL').toLowerCase();

if (!supabaseKey) {
    console.error('Missing SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
}

if (!resendApiKey && !dryRun) {
    console.error('Missing RESEND_API_KEY (or set DRY_RUN=true to preview).');
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

function getMondayOfWeek(isoDate) {
    const d = new Date(`${isoDate}T12:00:00Z`);
    const day = d.getUTCDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + diffToMonday);
    return d.toISOString().slice(0, 10);
}

function getLondonTodayIso() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/London',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
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

function getConstituencyName(mp) {
    if (mp?.constituencies?.name) return mp.constituencies.name;
    if (mp?.role_title && mp.role_title.includes('MP for ')) {
        return mp.role_title.split('MP for ').pop().trim();
    }
    return 'UK Constituency';
}

function buildMpSlugMap(mps) {
    const usedSlugs = new Set();
    const slugByMpId = new Map();

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
        slugByMpId.set(Number(mp.parliament_member_id), candidate);
    }

    return slugByMpId;
}

function buildMpWeeklySection(mp, slug, weekDates, rows, unsubscribeToken) {
    const sortedDates = [...weekDates].sort();
    const rowByDate = new Map((rows || []).map(r => [r.sitting_date, r]));
    const rangeLabel = formatWeekRangeLabel(sortedDates);
    const seat = getConstituencyName(mp);
    const mpUrl = `${siteBaseUrl}/mp/${slug}/?date=WEEK`;
    const unsubSingleUrl = `${siteBaseUrl}/?unsubscribe=${encodeURIComponent(unsubscribeToken)}`;

    const activeEntries = sortedDates
        .map(d => ({ date: d, row: rowByDate.get(d) }))
        .filter(e => e.row && e.row.activity_tag !== 'Non-Sitting Day');

    const substantiveEntries = activeEntries.filter(e =>
        e.row.activity_tag !== 'Constituency & Parliamentary Work' &&
        e.row.activity_tag !== 'Ministerial & Departmental Work' &&
        e.row.activity_tag !== 'Abstentionist MP' &&
        e.row.activity_tag !== 'Chairing the House' &&
        e.row.activity_tag !== 'No Vote Recorded'
    );

    const allVotes = [];
    let wqCount = 0;
    let committeeCount = 0;

    for (const { date, row } of activeEntries) {
        const dateLabel = formatShortPillDate(date);
        for (const v of (Array.isArray(row.votes) ? row.votes : [])) {
            if (v.mpVote === 'Aye' || v.mpVote === 'No') {
                allVotes.push({ ...v, sittingDateLabel: dateLabel });
            }
        }
        wqCount += Array.isArray(row.written_questions) ? row.written_questions.length : 0;
        committeeCount += Array.isArray(row.committee_sessions) ? row.committee_sessions.length : 0;
    }

    const paragraphs = [];
    if (substantiveEntries.length === 0 && allVotes.length === 0 && wqCount === 0 && committeeCount === 0) {
        paragraphs.push(
            `${mp.short_name} had no spoken contributions in the Commons Chamber, public committee sessions, or recorded division votes during the week of ${rangeLabel}, focusing on constituency and off-floor parliamentary work.`
        );
    } else {
        for (const { date, row } of substantiveEntries.slice(0, 4)) {
            const firstPara = String(row.summary_para_1 || '')
                .split(/\n{2,}/)[0]
                ?.replace(/^On\s+[A-Za-z]+,\s+\d{1,2}\s+[A-Za-z]+\s+\d{4},\s*/i, '')
                .trim();
            if (firstPara) {
                paragraphs.push(`<strong>${escapeHtml(formatShortPillDate(date))}:</strong> ${escapeHtml(firstPara)}`);
            }
        }
        if (paragraphs.length === 0) {
            const bits = [];
            if (committeeCount > 0) bits.push(`${committeeCount} select committee ${committeeCount === 1 ? 'session' : 'sessions'}`);
            if (wqCount > 0) bits.push(`${wqCount} written parliamentary ${wqCount === 1 ? 'question' : 'questions'}`);
            if (allVotes.length > 0) bits.push(`${allVotes.length} Commons division ${allVotes.length === 1 ? 'vote' : 'votes'}`);
            paragraphs.push(
                `${mp.short_name} had no spoken Chamber speeches during the week of ${rangeLabel}, taking part in ${bits.join(', ')}.`
            );
        }
    }

    const votesHtml = allVotes.length > 0
        ? `
            <div style="margin-top: 14px; padding: 12px 14px; background-color: #FAFAFA; border: 1px solid #E5E7EB; border-radius: 10px;">
                <p style="margin: 0 0 8px 0; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #006548;">
                    Recorded Division Votes (${allVotes.length})
                </p>
                <ul style="margin: 0; padding-left: 16px; color: #374151; font-size: 13px; line-height: 1.55;">
                    ${allVotes.slice(0, 6).map(v => `
                        <li style="margin-bottom: 4px;">
                            <strong>Voted ${escapeHtml(v.mpVote)}</strong> — ${escapeHtml(v.title)} <span style="color: #9CA3AF;">(${escapeHtml(v.sittingDateLabel)})</span>
                        </li>
                    `).join('')}
                </ul>
            </div>
        `
        : '';

    const html = `
        <section style="padding: 26px 0; border-bottom: 1px solid #E5E7EB;">
            <p style="margin: 0 0 4px 0; font-size: 12px; font-weight: 500; color: #006548;">
                ${escapeHtml(mp.party || 'MP')} &middot; ${escapeHtml(seat)}
            </p>
            <h2 style="margin: 0 0 14px 0; font-family: Georgia, 'Times New Roman', serif; font-size: 24px; line-height: 1.2; color: #111827;">
                <a href="${escapeHtml(mpUrl)}" style="color: #111827; text-decoration: none;">${escapeHtml(mp.full_name)}</a>
            </h2>
            ${paragraphs.map(p => `<p style="margin: 0 0 12px 0; font-size: 15px; line-height: 1.65; color: #1F2937;">${p}</p>`).join('')}
            ${votesHtml}
            <p style="margin: 16px 0 0 0; font-size: 13px;">
                <a href="${escapeHtml(mpUrl)}" style="color: #006548; font-weight: 600; text-decoration: none;">Read full briefing &amp; vote explainers &rarr;</a>
                <span style="color: #D1D5DB; margin: 0 8px;">|</span>
                <a href="${escapeHtml(unsubSingleUrl)}" style="color: #9CA3AF; text-decoration: underline;">Unsubscribe from ${escapeHtml(mp.short_name)}</a>
            </p>
        </section>
    `;

    const plainVotes = allVotes.length > 0
        ? `\nVotes:\n${allVotes.slice(0, 6).map(v => `- Voted ${v.mpVote}: ${v.title} (${v.sittingDateLabel})`).join('\n')}\n`
        : '';

    const text = [
        `${mp.full_name} (${mp.party} · ${seat})`,
        ...paragraphs.map(p => p.replace(/<[^>]*>/g, '')),
        plainVotes.trim(),
        `Full briefing: ${mpUrl}`,
        `Unsubscribe from ${mp.short_name}: ${unsubSingleUrl}`
    ].filter(Boolean).join('\n\n');

    return { html, text, mpName: mp.short_name };
}

function composeCombinedDigestEmail({ email, sections, weekRangeLabel, primaryUnsubscribeToken }) {
    const count = sections.length;
    let subject = '';
    if (count === 1) {
        subject = `What ${sections[0].mpName} did in Parliament (${weekRangeLabel})`;
    } else if (count === 2) {
        subject = `Your Sunday Briefing: ${sections[0].mpName} & ${sections[1].mpName}`;
    } else {
        subject = `Your Sunday Briefing: ${sections[0].mpName}, ${sections[1].mpName} & ${count - 2} more ${count - 2 === 1 ? 'MP' : 'MPs'}`;
    }

    const unsubAllUrl = `${siteBaseUrl}/?unsubscribe_all=${encodeURIComponent(primaryUnsubscribeToken)}`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #FFFFFF; color: #111827; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <div style="max-width: 600px; margin: 0 auto; padding: 32px 20px;">
        <header style="padding-bottom: 20px; border-bottom: 1px solid #E5E7EB;">
            <a href="${escapeHtml(siteBaseUrl)}" style="font-family: Georgia, 'Times New Roman', serif; font-size: 28px; font-weight: 700; color: #111827; text-decoration: none;">
                Whip<span style="color: #006548;">.</span>
            </a>
            <p style="margin: 6px 0 0 0; font-size: 13px; color: #6B7280;">
                Sunday Parliamentary Roundup &middot; Week of ${escapeHtml(weekRangeLabel)}
            </p>
        </header>

        ${sections.map(s => s.html).join('')}

        <footer style="padding-top: 24px; font-size: 12px; line-height: 1.6; color: #9CA3AF;">
            <p style="margin: 0 0 8px 0;">
                You’re receiving this combined Sunday briefing at ${escapeHtml(email)} because you subscribed to ${count === 1 ? '1 MP' : `${count} MPs`} on Whip.
            </p>
            <p style="margin: 0;">
                <a href="${escapeHtml(unsubAllUrl)}" style="color: #6B7280; text-decoration: underline;">Unsubscribe from all Whip. Sunday briefings</a>
                &nbsp;&middot;&nbsp;
                <a href="${escapeHtml(siteBaseUrl)}/privacy/" style="color: #6B7280; text-decoration: underline;">Privacy Policy</a>
            </p>
        </footer>
    </div>
</body>
</html>`;

    const text = [
        `WHIP. — Sunday Parliamentary Roundup (Week of ${weekRangeLabel})`,
        '============================================================',
        sections.map(s => s.text).join('\n\n------------------------------------------------------------\n\n'),
        '============================================================',
        `Unsubscribe from all Whip. Sunday briefings: ${unsubAllUrl}`
    ].join('\n\n');

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
        })
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Resend HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    return res.json();
}

async function main() {
    console.log(`[${new Date().toISOString()}] Starting Whip. Sunday digest run (DRY_RUN=${dryRun})...`);

    const { data: mps, error: mpErr } = await supabase
        .from('mps')
        .select('parliament_member_id, full_name, short_name, party, role_title, constituencies(name)')
        .eq('is_current_member', true)
        .order('short_name', { ascending: true });

    if (mpErr || !mps?.length) {
        throw new Error(`Could not load MPs: ${mpErr?.message || '0 rows'}`);
    }

    const mpById = new Map(mps.map(m => [Number(m.parliament_member_id), m]));
    const slugByMpId = buildMpSlugMap(mps);

    // Determine the target week's sitting dates (most recent completed sitting week, or current week on Sun/Sat)
    const probeId = mps[0].parliament_member_id;
    const { data: recentDates } = await supabase
        .from('daily_briefings')
        .select('sitting_date, activity_tag')
        .eq('parliament_member_id', probeId)
        .order('sitting_date', { ascending: false })
        .limit(21);

    const activeDates = [...new Set(
        (recentDates || [])
            .filter(r => r.activity_tag !== 'Non-Sitting Day')
            .map(r => r.sitting_date)
    )];

    if (activeDates.length === 0) {
        console.log('No active Commons sitting days found in recent window — skipping digest.');
        return;
    }

    const targetMonday = getMondayOfWeek(activeDates[0]);
    const targetWeekDates = activeDates.filter(d => getMondayOfWeek(d) === targetMonday).sort();
    const weekRangeLabel = formatWeekRangeLabel(targetWeekDates);

    console.log(`Target week: ${weekRangeLabel} (${targetWeekDates.join(', ')})`);

    // Load active subscribers
    let subQuery = supabase
        .from('newsletter_subscribers')
        .select('email, parliament_member_id, unsubscribe_token')
        .eq('is_active', true);

    if (testRecipient) {
        subQuery = subQuery.eq('email', testRecipient);
    }

    const { data: subscribers, error: subErr } = await subQuery;
    if (subErr) {
        throw new Error(`Could not load newsletter_subscribers: ${subErr.message}`);
    }

    if (!subscribers || subscribers.length === 0) {
        console.log('No active subscribers found.');
        return;
    }

    // Group subscriptions by email address (1 email per reader, covering all subscribed MPs)
    const byEmail = new Map();
    const allSubscribedMpIds = new Set();

    for (const row of subscribers) {
        const email = String(row.email || '').trim().toLowerCase();
        const mpId = Number(row.parliament_member_id);
        if (!email || !mpId || !mpById.has(mpId)) continue;

        if (!byEmail.has(email)) {
            byEmail.set(email, []);
        }
        // Avoid duplicate MP entries for the same email
        if (!byEmail.get(email).some(item => item.mpId === mpId)) {
            byEmail.get(email).push({
                mpId,
                unsubscribeToken: row.unsubscribe_token
            });
            allSubscribedMpIds.add(mpId);
        }
    }

    console.log(`Found ${subscribers.length} active MP subscriptions merged into ${byEmail.size} unique recipient emails.`);

    // Fetch weekly briefings only for MPs that have at least one subscriber
    const briefingsByMpId = new Map();
    const subscribedMpList = [...allSubscribedMpIds];

    for (let i = 0; i < subscribedMpList.length; i += 100) {
        const chunk = subscribedMpList.slice(i, i + 100);
        const { data: rows, error: bErr } = await supabase
            .from('daily_briefings')
            .select('*')
            .in('parliament_member_id', chunk)
            .in('sitting_date', targetWeekDates);

        if (bErr) {
            throw new Error(`Failed loading briefings batch: ${bErr.message}`);
        }

        for (const r of rows || []) {
            const id = Number(r.parliament_member_id);
            if (!briefingsByMpId.has(id)) briefingsByMpId.set(id, []);
            briefingsByMpId.get(id).push(r);
        }
    }

    let sentCount = 0;
    let errorCount = 0;

    for (const [email, items] of byEmail.entries()) {
        // Sort MPs alphabetically by short_name inside each subscriber's email
        const sortedItems = [...items].sort((a, b) => {
            const nameA = mpById.get(a.mpId)?.short_name || '';
            const nameB = mpById.get(b.mpId)?.short_name || '';
            return nameA.localeCompare(nameB);
        });

        const sections = sortedItems.map(item => {
            const mp = mpById.get(item.mpId);
            const slug = slugByMpId.get(item.mpId);
            const rows = briefingsByMpId.get(item.mpId) || [];
            return buildMpWeeklySection(mp, slug, targetWeekDates, rows, item.unsubscribeToken);
        });

        const primaryToken = sortedItems[0].unsubscribeToken;
        const { subject, html, text } = composeCombinedDigestEmail({
            email,
            sections,
            weekRangeLabel,
            primaryUnsubscribeToken: primaryToken
        });

        if (dryRun) {
            console.log(`[DRY RUN] Would send 1 email to ${email} covering ${sections.length} MP(s): "${subject}"`);
            sentCount += 1;
            continue;
        }

        try {
            await sendViaResend({ to: email, subject, html, text });
            sentCount += 1;
            console.log(`Sent digest to ${email} (${sections.length} MP(s)).`);
        } catch (err) {
            errorCount += 1;
            console.error(`Failed sending digest to ${email}: ${err.message}`);
        }
    }

    console.log(`[${new Date().toISOString()}] Digest complete. Emails sent: ${sentCount}, failed: ${errorCount}.`);
}

main().catch(err => {
    console.error('Fatal error in send_weekly_digest:', err);
    process.exitCode = 1;
});
