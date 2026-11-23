/**
 * Whip — Step 1: Active Commons Roster & Full Government Payroll Sync (`sync_roster.js`)
 *
 * Fetches all 650 sitting House of Commons MPs and all active Government payroll posts
 * (Cabinet, Ministers of State, Parliamentary Under-Secretaries, Law Officers, and Whips)
 * from the official UK Parliament Members API and upserts them into Supabase.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const MEMBERS_SEARCH_API = 'https://members-api.parliament.uk/api/Members/Search';
const GOVERNMENT_POSTS_API = 'https://members-api.parliament.uk/api/Posts/GovernmentPosts';
const MEMBER_BIOGRAPHY_API = 'https://members-api.parliament.uk/api/Members';

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
    'Democratic Unionist Party': '#D46A4C',
    'Reform UK': '#12B6CF',
    'Green Party': '#02A95B',
    'Plaid Cymru': '#005B54',
    'Social Democratic & Labour Party': '#2AA82C',
    'Alliance': '#F6CB2F',
    'Ulster Unionist Party': '#48A5EE',
    'Traditional Unionist Voice': '#0C3A6A',
    'Speaker': '#111111',
    'Independent': '#6B7280'
};

function isActiveHolder(holder) {
    if (!holder) return false;
    if (!holder.endDate) return true;
    const endMs = new Date(holder.endDate).getTime();
    return !Number.isNaN(endMs) && endMs > Date.now();
}

function formatPostWithDept(postName, deptName) {
    const cleanPost = String(postName || '').trim();
    const cleanDept = String(deptName || '').trim();
    if (!cleanPost) return '';
    if (!cleanDept) return cleanPost;

    const shortDept = cleanDept
        .replace(/^department (for|of)\s+/i, '')
        .replace(/^ministry of\s+/i, '')
        .trim();

    const alreadyHasDept =
        cleanPost.toLowerCase().includes(cleanDept.toLowerCase()) ||
        (shortDept.length > 3 && cleanPost.toLowerCase().includes(shortDept.toLowerCase())) ||
        /\b(prime minister|chancellor of the exchequer|home secretary|foreign secretary)\b/i.test(cleanPost);

    return alreadyHasDept ? cleanPost : `${cleanPost} (${cleanDept})`;
}

async function fetchJson(url) {
    const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return res.json();
}

async function fetchAllCommonsMembers() {
    const allMembers = [];
    let skip = 0;
    const take = 20;

    while (true) {
        const url = new URL(MEMBERS_SEARCH_API);
        url.searchParams.set('House', '1');
        url.searchParams.set('IsCurrentMember', 'true');
        url.searchParams.set('skip', String(skip));
        url.searchParams.set('take', String(take));

        const data = await fetchJson(url.toString());
        const items = data?.items || [];
        if (items.length === 0) break;

        for (const item of items) {
            if (item?.value) {
                allMembers.push(item.value);
            }
        }

        skip += items.length;
        const totalResults = data?.totalResults ?? 0;
        if (skip >= totalResults) break;
    }

    return allMembers;
}

function addPostForMember(postsByMember, memberId, formattedTitle) {
    if (!memberId || !formattedTitle) return;
    if (!postsByMember.has(memberId)) {
        postsByMember.set(memberId, []);
    }
    const list = postsByMember.get(memberId);
    if (!list.includes(formattedTitle)) {
        list.push(formattedTitle);
    }
}

async function fetchGovernmentPostsByMemberId() {
    const postsByMember = new Map();

    try {
        const data = await fetchJson(GOVERNMENT_POSTS_API);
        const rawList = Array.isArray(data) ? data : (data?.items || data?.value || []);

        for (const entry of rawList) {
            const post = entry?.post || entry?.value || entry;
            const postName = (post?.name || post?.postName || entry?.name || '').trim();
            const deptName = (
                post?.governmentDepartments?.[0]?.name ||
                post?.department?.name ||
                entry?.governmentDepartments?.[0]?.name ||
                ''
            ).trim();
            const holders = Array.isArray(post?.postHolders)
                ? post.postHolders
                : (Array.isArray(entry?.postHolders) ? entry.postHolders : []);

            for (const holder of holders) {
                if (!isActiveHolder(holder)) continue;
                const memberId = Number(
                    holder?.member?.id ??
                    holder?.member?.value?.id ??
                    holder?.memberId
                );
                if (!memberId || !postName) continue;
                addPostForMember(postsByMember, memberId, formatPostWithDept(postName, deptName));
            }
        }
    } catch (err) {
        console.warn(`GovernmentPosts fetch warning: ${err.message}`);
    }

    return postsByMember;
}

async function enrichFromMemberBiography(memberIds, postsByMember) {
    const batchSize = 25;
    for (let i = 0; i < memberIds.length; i += batchSize) {
        const batch = memberIds.slice(i, i + batchSize);
        await Promise.all(
            batch.map(async (memberId) => {
                try {
                    const bio = await fetchJson(`${MEMBER_BIOGRAPHY_API}/${memberId}/Biography`);
                    const val = bio?.value || bio || {};
                    const govPosts = Array.isArray(val.governmentPosts) ? val.governmentPosts : [];
                    for (const gp of govPosts) {
                        if (!isActiveHolder(gp)) continue;
                        const postName = (gp?.name || gp?.postName || '').trim();
                        const deptName = (gp?.governmentDepartments?.[0]?.name || gp?.department?.name || '').trim();
                        addPostForMember(postsByMember, memberId, formatPostWithDept(postName, deptName));
                    }
                } catch {
                    // Ignore individual member biography misses
                }
            })
        );
    }
}

export async function syncRoster() {
    console.log(`[${new Date().toISOString()}] Syncing active House of Commons MPs & full Government payroll...`);

    const [members, govPostsByMember] = await Promise.all([
        fetchAllCommonsMembers(),
        fetchGovernmentPostsByMemberId()
    ]);

    if (members.length === 0) {
        console.warn('No active MPs returned from Parliament API — aborting sync to avoid clearing roster.');
        return;
    }

    const memberIds = members.map(m => Number(m.id)).filter(Boolean);
    await enrichFromMemberBiography(memberIds, govPostsByMember);

    console.log(`Fetched ${members.length} active MPs and ${govPostsByMember.size} Government payroll postholders.`);

    const constituencyMap = new Map();
    for (const m of members) {
        const membership = m.latestHouseMembership || {};
        const seatName = (membership.membershipFrom || '').trim();
        const seatId = Number(membership.membershipFromId) || null;
        if (seatName && !constituencyMap.has(seatName)) {
            constituencyMap.set(seatName, {
                name: seatName,
                parliament_constituency_id: seatId
            });
        }
    }

    const constituencyRows = Array.from(constituencyMap.values());
    if (constituencyRows.length > 0) {
        const { error: constErr } = await supabase
            .from('constituencies')
            .upsert(constituencyRows, { onConflict: 'name' });
        if (constErr) {
            console.warn(`Constituency upsert warning: ${constErr.message}`);
        }
    }

    const { data: dbConstituencies } = await supabase
        .from('constituencies')
        .select('id, name');
    const constIdByName = new Map((dbConstituencies || []).map(c => [c.name, c.id]));

    const activeIds = new Set();
    const mpRows = members.map(m => {
        const memberId = Number(m.id);
        activeIds.add(memberId);

        const membership = m.latestHouseMembership || {};
        const seatName = (membership.membershipFrom || 'UK Constituency').trim();
        const partyName = (m.latestParty?.name || 'Independent').trim();
        const partyColor = PARTY_COLORS[partyName]
            || (m.latestParty?.backgroundColour ? `#${m.latestParty.backgroundColour.replace(/^#/, '')}` : '#6B7280');

        const govTitles = govPostsByMember.get(memberId) || [];
        const roleTitle = govTitles.length > 0
            ? `${govTitles.join(' & ')} • MP for ${seatName}`
            : `MP for ${seatName}`;

        return {
            parliament_member_id: memberId,
            full_name: (m.nameDisplayAs || m.nameListAs || '').trim(),
            short_name: (m.nameDisplayAs || '').replace(/^(Rt Hon\s+|Sir\s+|Dame\s+|Dr\s+|Mr\s+|Mrs\s+|Ms\s+|Mx\s+)/gi, '').trim(),
            party: partyName,
            party_color: partyColor,
            role_title: roleTitle,
            constituency_id: constIdByName.get(seatName) || null,
            member_since: membership.membershipStartDate ? String(membership.membershipStartDate).slice(0, 10) : null,
            is_current_member: true
        };
    });

    for (let i = 0; i < mpRows.length; i += 200) {
        const chunk = mpRows.slice(i, i + 200);
        const { error: upsertErr } = await supabase
            .from('mps')
            .upsert(chunk, { onConflict: 'parliament_member_id' });
        if (upsertErr) {
            throw new Error(`MP upsert failed at batch ${i}: ${upsertErr.message}`);
        }
    }

    const { data: existingCurrent } = await supabase
        .from('mps')
        .select('parliament_member_id')
        .eq('is_current_member', true);

    const retiredIds = (existingCurrent || [])
        .map(r => r.parliament_member_id)
        .filter(id => !activeIds.has(id));

    if (retiredIds.length > 0) {
        await supabase
            .from('mps')
            .update({ is_current_member: false })
            .in('parliament_member_id', retiredIds);
        console.log(`Marked ${retiredIds.length} former MPs as inactive.`);
    }

    console.log(`[${new Date().toISOString()}] Roster sync complete (${mpRows.length} active MPs).`);
}

syncRoster();
