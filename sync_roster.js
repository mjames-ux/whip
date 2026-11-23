/**
 * Whip — Step 1: Active House of Commons Roster & Ministerial Posts Sync (`sync_mps.js`)
 *
 * Fetches all 650 current MPs from the UK Parliament Members API, maps active
 * Government ministerial posts from `/api/Posts/GovernmentPosts` into `role_title`,
 * upserts constituencies, and upserts MPs into Supabase.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const MEMBERS_SEARCH_API = 'https://members-api.parliament.uk/api/Members/Search';
const GOVERNMENT_POSTS_API = 'https://members-api.parliament.uk/api/Posts/GovernmentPosts';

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

const PARTY_COLORS = {
    'Labour': '#E4003B',
    'Labour (Co-op)': '#E4003B',
    'Conservative': '#0087DC',
    'Liberal Democrat': '#FAA61A',
    'Scottish National Party': '#FDF38E',
    'Sinn Féin': '#326760',
    'Reform UK': '#12B6CF',
    'Green Party': '#02A95B',
    'Democratic Unionist Party': '#D46A4C',
    'Plaid Cymru': '#005B54',
    'Social Democratic & Labour Party': '#2AA82C',
    'Alliance': '#F6CB2F',
    'Ulster Unionist Party': '#48A5EE',
    'Traditional Unionist Voice': '#0C3A6A',
    'Speaker': '#111111',
    'Independent': '#6B7280'
};

function getPartyColor(partyName) {
    if (!partyName) return '#6B7280';
    for (const [key, color] of Object.entries(PARTY_COLORS)) {
        if (partyName.toLowerCase().includes(key.toLowerCase())) {
            return color;
        }
    }
    return '#006548';
}

async function fetchGovernmentPostsByMemberId() {
    const postsByMember = new Map();
    try {
        const res = await fetch(GOVERNMENT_POSTS_API, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(20000)
        });
        if (!res.ok) {
            console.warn(`GovernmentPosts API returned HTTP ${res.status}`);
            return postsByMember;
        }
        const payload = await res.json();
        const items = Array.isArray(payload) ? payload : (payload?.value || payload?.items || []);

        for (const entry of items) {
            const post = entry?.value || entry;
            const postTitle = (post?.name || post?.title || '').trim();
            if (!postTitle) continue;

            const holders = Array.isArray(post?.postHolders) ? post.postHolders : [];
            for (const h of holders) {
                if (h?.endDate) continue;
                const mId = Number(h?.member?.value?.id ?? h?.member?.id ?? h?.memberId);
                if (!mId) continue;

                const existing = postsByMember.get(mId) || [];
                if (!existing.includes(postTitle)) {
                    existing.push(postTitle);
                    postsByMember.set(mId, existing);
                }
            }
        }
        console.log(`Mapped active ministerial posts for ${postsByMember.size} members.`);
    } catch (err) {
        console.warn(`GovernmentPosts fetch warning: ${err.message}`);
    }
    return postsByMember;
}

export async function syncMps() {
    console.log(`[${new Date().toISOString()}] Syncing active Commons roster...`);

    const postsByMember = await fetchGovernmentPostsByMemberId();

    const allMembers = [];
    let skip = 0;
    const take = 20;

    while (true) {
        const url = new URL(MEMBERS_SEARCH_API);
        url.searchParams.set('House', '1');
        url.searchParams.set('IsCurrentMember', 'true');
        url.searchParams.set('skip', String(skip));
        url.searchParams.set('take', String(take));

        const res = await fetch(url.toString(), {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(20000)
        });

        if (!res.ok) {
            throw new Error(`Members Search API HTTP ${res.status}`);
        }

        const data = await res.json();
        const items = data?.items || [];
        if (items.length === 0) break;

        allMembers.push(...items);
        skip += items.length;

        const total = data?.totalResults ?? 0;
        if (skip >= total) break;
    }

    if (allMembers.length === 0) {
        throw new Error('Members Search API returned 0 active MPs — aborting sync.');
    }

    const constituencyMap = new Map();
    const mpRows = [];

    for (const item of allMembers) {
        const val = item?.value;
        if (!val?.id) continue;

        const membership = val.latestHouseMembership || {};
        const seatId = Number(membership.membershipFromId) || null;
        const seatName = (membership.membershipFrom || 'UK Constituency').trim();
        const partyName = (val.latestParty?.name || 'Independent').trim();

        if (seatId && !constituencyMap.has(seatId)) {
            constituencyMap.set(seatId, {
                parliament_constituency_id: seatId,
                name: seatName
            });
        }

        const fullName = (val.nameDisplayAs || val.nameFullTitle || `Member ${val.id}`).trim();
        const shortName = (val.nameDisplayAs || fullName).trim();
        const memberSince = membership.membershipStartDate
            ? String(membership.membershipStartDate).slice(0, 10)
            : null;

        const govPosts = postsByMember.get(Number(val.id)) || [];
        const primaryPost = govPosts[0] || null;
        const roleTitle = primaryPost
            ? `${primaryPost} • MP for ${seatName}`
            : `MP for ${seatName}`;

        mpRows.push({
            parliament_member_id: Number(val.id),
            full_name: fullName,
            short_name: shortName,
            party: partyName,
            party_color: getPartyColor(partyName),
            role_title: roleTitle,
            constituency_id: seatId,
            member_since: memberSince,
            is_current_member: true
        });
    }

    const constituencyRows = Array.from(constituencyMap.values());
    for (let i = 0; i < constituencyRows.length; i += 200) {
        const chunk = constituencyRows.slice(i, i + 200);
        const { error } = await supabase
            .from('constituencies')
            .upsert(chunk, { onConflict: 'parliament_constituency_id' });
        if (error) {
            throw new Error(`Constituencies upsert failed: ${error.message}`);
        }
    }

    const activeIds = new Set(mpRows.map(m => m.parliament_member_id));
    for (let i = 0; i < mpRows.length; i += 200) {
        const chunk = mpRows.slice(i, i + 200);
        const { error } = await supabase
            .from('mps')
            .upsert(chunk, { onConflict: 'parliament_member_id' });
        if (error) {
            throw new Error(`MPs upsert failed: ${error.message}`);
        }
    }

    const { data: existingMps } = await supabase
        .from('mps')
        .select('parliament_member_id')
        .eq('is_current_member', true);

    const departedIds = (existingMps || [])
        .map(r => r.parliament_member_id)
        .filter(id => !activeIds.has(id));

    if (departedIds.length > 0) {
        await supabase
            .from('mps')
            .update({ is_current_member: false })
            .in('parliament_member_id', departedIds);
    }

    console.log(`[${new Date().toISOString()}] Roster sync complete: ${mpRows.length} active MPs synced.`);
}

syncMps();
