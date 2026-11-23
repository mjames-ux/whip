/**
 * Whip — Sunday Weekly MP Briefing Newsletter Dispatcher (`send_weekly_digest.js`)
 *
 * Runs on Sunday mornings, compiles the completed parliamentary week's summary
 * for each MP with active subscribers, and delivers a clean editorial email via Resend.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SITE_ORIGIN = 'https://whipdaily.uk';
const RESEND_API_URL = 'https://api.resend.com/emails';

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
const fromEmail = cleanEnvValue(process.env.NEWSLETTER_FROM_EMAIL, 'NEWSLETTER_FROM_EMAIL') || 'Whip <sunday@whipdaily.uk>';

if (!supabaseKey || !resendApiKey) {
    console.error('Missing SUPABASE_SERVICE_ROLE_KEY or RESEND_API_KEY.');
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

function compileEmailBriefing(mp, weekDates, rows) {
    const sortedDates = [...weekDates].sort();
    const rowByDate = new Map((rows || []).map(r => [r.sitting_date, r]));
    const rangeLabel = formatWeekRangeLabel(sortedDates);

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
        !/^Answered\s+\d+\s+Written Questions?$/i.test(e.row.activity_tag || '')
    );

    const activeVotes = [];
    for (const { row } of activeDayEntries) {
        for (const v of (Array.isArray(row.votes) ? row.votes : [])) {
            if (v.mpVote === 'Aye' || v.mpVote === 'No') {
                activeVotes.push(v);
            }
        }
    }

    const contexts = substantiveEntries
        .map(e => (e.row.summary_para_2 || '').trim())
        .filter(Boolean);

    let para1 = '';
    if (spokenOrCommitteeEntries.length > 0) {
        const dayParagraphs = spokenOrCommitteeEntries.map(({ date, row }) => {
            const subParas = (row.summary_para_1 || '')
                .split(/\n{2,}/)
                .map(s => s.trim())
                .filter(s => s && !/^In the voting lobbies,/i.test(s) && !/routinely spend time handling urgent constituent casework/i.test(s));
            if (subParas.length === 0) return '';
            const cleanedFirst = subParas[0]
                .replace(/^On\s+[A-Za-z]+,\s+\d{1,2}\s+[A-Za-z]+\s+\d{4},\s*/i, '')
                .replace(/\s+on\s+[A-Za-z]+,\s+\d{1,2}\s+[A-Za-z]+\s+\d{4}(?=\s+(?:during|in|at)\b)/i, '');
            subParas[0] = `On ${formatShortPillDate(date)}, ${cleanedFirst}`;
            return subParas.join('\n\n');
        }).filter(Boolean);

        if (activeVotes.length > 0) {
            dayParagraphs.push(`Across the week, ${mp.short_name} also cast ${activeVotes.length} recorded division ${activeVotes.length === 1 ? 'vote' : 'votes'}.`);
        }
        para1 = dayParagraphs.join('\n\n');
    } else if (substantiveEntries.length > 0) {
        para1 = substantiveEntries.map(e => e.row.summary_para_1).join('\n\n');
    } else {
        para1 = `${mp.short_name} did not speak in the Commons Chamber or cast recorded division votes during the week of ${rangeLabel}, focusing on constituency casework and parliamentary correspondence.`;
    }

    const para2 = contexts[0] || `Much of an MP's working week takes place away from the main Chamber—handling urgent constituent casework, scrutinising bills, and writing to ministers on behalf of local residents.`;

    return { rangeLabel, para1, para2, voteCount: activeVotes.length };
}

function renderEmailHtml({ mp, mpUrl, unsubscribeUrl, briefing }) {
    const paragraphsHtml = briefing.para1
        .split(/\n{2,}/)
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => {
            const formatted = escapeHtml(p).replace(
                /(“[^”]+”|&quot;[^&]+&quot;)/g,
                '<em style="font-style:italic;color:#111827;">$1</em>'
            );
            return `<p style="margin:0 0 16px 0;font-size:16px;line-height:1.7;color:#111827;">${formatted}</p>`;
        })
        .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#fafaf9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#fafaf9;padding:24px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:580px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:16px;padding:32px 28px;">
          <tr>
            <td style="padding-bottom:20px;border-bottom:1px solid #e5e7eb;">
              <span style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;color:#111827;">Whip<span style="color:#006548;">.</span></span>
              <span style="font-size:12px;color:#6b7280;margin-left:8px;">Sunday Parliamentary Briefing</span>
            </td>
          </tr>
          <tr>
            <td style="padding-top:24px;">
              <p style="margin:0 0 6px 0;font-size:12px;color:#6b7280;">Week in Parliament (${escapeHtml(briefing.rangeLabel)})</p>
              <p style="margin:0 0 4px 0;font-size:13px;font-weight:600;color:#006548;">${escapeHtml(mp.party)}</p>
              <h1 style="margin:0 0 20px 0;font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1.2;font-weight:700;color:#111827;">${escapeHtml(mp.full_name)}</h1>
              ${paragraphsHtml}
              <div style="margin:24px 0;padding:16px 18px;border-left:3px solid #006548;background-color:#f9fafb;border-radius:0 8px 8px 0;">
                <p style="margin:0 0 6px 0;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#006548;">Why this matters</p>
                <p style="margin:0;font-size:14px;line-height:1.65;color:#4b5563;">${escapeHtml(briefing.para2)}</p>
              </div>
              <p style="margin:24px 0 0 0;">
                <a href="${escapeHtml(mpUrl)}" style="display:inline-block;padding:12px 20px;background-color:#111827;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;border-radius:10px;">View full voting record &amp; Hansard links &rarr;</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding-top:28px;margin-top:28px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#6b7280;">
              You’re receiving this because you subscribed to weekly Sunday briefings for ${escapeHtml(mp.short_name)} on Whip.<br>
              <a href="${escapeHtml(unsubscribeUrl)}" style="color:#4b5563;text-decoration:underline;">Unsubscribe in one click</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendResendEmail({ to, subject, html, text, unsubscribeUrl, idempotencyKey }) {
    const res = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey
        },
        body: JSON.stringify({
            from: fromEmail,
            to: [to],
            subject,
            html,
            text,
            headers: {
                'List-Unsubscribe': `<${unsubscribeUrl}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
            }
        }),
        signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Resend HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }
    return res.json();
}

export async function sendWeeklyDigest() {
    console.log(`[${new Date().toISOString()}] Starting Sunday Weekly MP Briefing dispatch...`);

    const { data: subscribers, error: subErr } = await supabase
        .from('newsletter_subscribers')
        .select('id, email, parliament_member_id, unsubscribe_token')
        .eq('is_active', true);

    if (subErr) throw new Error(`Failed loading subscribers: ${subErr.message}`);
    if (!subscribers?.length) {
        console.log('No active newsletter subscribers yet. Exiting.');
        return;
    }

    const { data: mps, error: mpErr } = await supabase
        .from('mps')
        .select('parliament_member_id, full_name, short_name, party, role_title, constituencies(name)')
        .eq('is_current_member', true);

    if (mpErr || !mps?.length) throw new Error(`Failed loading MPs: ${mpErr?.message || '0 rows'}`);

    const mpById = new Map(mps.map(m => [Number(m.parliament_member_id), m]));

    // Build unique slugs matching build_pages.js
    const slugById = new Map();
    const usedSlugs = new Set();
    for (const mp of [...mps].sort((a, b) => (a.short_name || '').localeCompare(b.short_name || ''))) {
        const base = slugify(mp.short_name || mp.full_name || `member-${mp.parliament_member_id}`);
        let candidate = base;
        if (usedSlugs.has(candidate)) {
            const seat = slugify(mp?.constituencies?.name || '');
            candidate = seat ? `${base}-${seat}` : `${base}-${mp.parliament_member_id}`;
        }
        usedSlugs.add(candidate);
        slugById.set(Number(mp.parliament_member_id), candidate);
    }

    // Find the latest parliamentary week in daily_briefings
    const probeId = mps[0].parliament_member_id;
    const { data: recentDates } = await supabase
        .from('daily_briefings')
        .select('sitting_date, activity_tag')
        .eq('parliament_member_id', probeId)
        .order('sitting_date', { ascending: false })
        .limit(14);

    const activeDates = [...new Set(
        (recentDates || [])
            .filter(r => r.activity_tag !== 'Non-Sitting Day')
            .map(r => r.sitting_date)
    )];

    const latestMonday = activeDates[0] ? getMondayOfWeek(activeDates[0]) : null;
    const weekDates = latestMonday ? activeDates.filter(d => getMondayOfWeek(d) === latestMonday) : [];

    if (weekDates.length === 0) {
        console.log('No sitting days found for the past week (Parliament in recess). Skipping Sunday send.');
        return;
    }

    const subscribedMpIds = [...new Set(subscribers.map(s => Number(s.parliament_member_id)))];
    const { data: weekRows, error: rowsErr } = await supabase
        .from('daily_briefings')
        .select('*')
        .in('parliament_member_id', subscribedMpIds)
        .in('sitting_date', weekDates);

    if (rowsErr) throw new Error(`Failed loading weekly briefings: ${rowsErr.message}`);

    const rowsByMp = new Map();
    for (const r of weekRows || []) {
        const id = Number(r.parliament_member_id);
        if (!rowsByMp.has(id)) rowsByMp.set(id, []);
        rowsByMp.get(id).push(r);
    }

    const briefingCache = new Map();
    let sentCount = 0;

    for (const sub of subscribers) {
        const mpId = Number(sub.parliament_member_id);
        const mp = mpById.get(mpId);
        if (!mp) continue;

        if (!briefingCache.has(mpId)) {
            briefingCache.set(mpId, compileEmailBriefing(mp, weekDates, rowsByMp.get(mpId) || []));
        }

        const briefing = briefingCache.get(mpId);
        const slug = slugById.get(mpId);
        const mpUrl = `${SITE_ORIGIN}/mp/${slug}/`;
        const unsubscribeUrl = `${SITE_ORIGIN}/?unsubscribe=${encodeURIComponent(sub.unsubscribe_token)}`;
        const subject = `${mp.short_name} in Parliament (${briefing.rangeLabel})`;
        const html = renderEmailHtml({ mp, mpUrl, unsubscribeUrl, briefing });
        const text = `${mp.full_name} — Week in Parliament (${briefing.rangeLabel})\n\n${briefing.para1}\n\nWhy this matters:\n${briefing.para2}\n\nFull record: ${mpUrl}\nUnsubscribe: ${unsubscribeUrl}`;

        try {
            await sendResendEmail({
                to: sub.email,
                subject,
                html,
                text,
                unsubscribeUrl,
                idempotencyKey: `weekly-${latestMonday}-${sub.id}`
            });
            sentCount += 1;
            // Stay comfortably inside Resend's default 10 req/s rate limit
            await new Promise(r => setTimeout(r, 150));
        } catch (err) {
            console.error(`Failed sending to ${sub.email} for MP ${mpId}: ${err.message}`);
        }
    }

    console.log(`[${new Date().toISOString()}] Dispatched ${sentCount}/${subscribers.length} Sunday MP briefings.`);
}

sendWeeklyDigest();
