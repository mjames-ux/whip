/**
 * Whip — Step 1: Active House of Commons Members & Constituencies Sync (`sync_roster.js`)
 *
 * Fetches all sitting MPs from the UK Parliament Members API, updates `constituencies`
 * and `mps` (including `member_since` tenure start dates), marks departed MPs inactive,
 * and updates `system_status` dissolution state.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const MEMBERS_SEARCH_API = 'https://members-api.parliament.uk/api/Members/Search';

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

export async function syncRoster() {
    console.log(`[${new Date().toISOString()}] Syncing active Commons roster...`);
    let skip = 0;
    const take = 20;
    const allItems = [];

    while (true) {
        const url = new URL(MEMBERS_SEARCH_API);
        url.searchParams.set('House', '1');
        url.searchParams.set('IsCurrentMember', 'true');
        url.searchParams.set('skip', String(skip));
        url.searchParams.set('take', String(take));

        const res = await fetch(url.toString(), {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) throw new Error(`Members API HTTP ${res.status}`);

        const data = await res.json();
        const items = data?.items || [];
        if (items.length === 0) break;

        allItems.push(...items);
        skip += items.length;
        if (skip >= (data?.totalResults || 0)) break;
    }

    if (allItems.length === 0) {
        console.warn('0 active MPs returned — enabling Dissolution Mode.');
        await supabase
            .from('system_status')
            .upsert({ id: 1, is_parliament_dissolved: true, last_roster_sync: new Date().toISOString() });
        return;
    }

    const constituencyMap = new Map();
    const mpRecords = [];
    const activeIds = new Set();

    for (const entry of allItems) {
        const val = entry.value;
        if (!val?.id) continue;

        activeIds.add(val.id);
        const membership = val.latestHouseMembership || {};
        const seatName = membership.membershipFrom;
        const parliamentConstituencyId = membership.membershipFromId ? Number(membership.membershipFromId) : null;
        const memberSince = membership.membershipStartDate
            ? String(membership.membershipStartDate).slice(0, 10)
            : null;

        if (seatName && parliamentConstituencyId && !constituencyMap.has(seatName)) {
            constituencyMap.set(seatName, {
                parliament_constituency_id: parliamentConstituencyId,
                name: seatName
            });
        }

        mpRecords.push({
            parliament_member_id: val.id,
            full_name: val.nameDisplayAs || val.nameListAs,
            short_name: val.nameDisplayAs || val.nameListAs,
            party: val.latestParty?.name || 'Independent',
            party_color: val.latestParty?.backgroundColour ? `#${val.latestParty.backgroundColour}` : '#006548',
            role_title: `MP for ${seatName || 'UK Constituency'}`,
            seat_name: seatName,
            member_since: memberSince,
            is_current_member: true
        });
    }

    const constituencyRows = Array.from(constituencyMap.values());
    if (constituencyRows.length > 0) {
        const { error: constErr } = await supabase
            .from('constituencies')
            .upsert(constituencyRows, { onConflict: 'name' });
        if (constErr) throw new Error(`Constituency upsert error: ${constErr.message}`);
    }

    const { data: dbConstituencies } = await supabase.from('constituencies').select('id, name');
    const constIdByName = new Map((dbConstituencies || []).map(c => [c.name, c.id]));

    const finalMps = mpRecords.map(({ seat_name, ...rest }) => ({
        ...rest,
        constituency_id: constIdByName.get(seat_name) || null
    }));

    const { error: mpErr } = await supabase
        .from('mps')
        .upsert(finalMps, { onConflict: 'parliament_member_id' });
    if (mpErr) throw new Error(`MPs upsert error: ${mpErr.message}`);

    const { data: existingCurrent } = await supabase
        .from('mps')
        .select('parliament_member_id')
        .eq('is_current_member', true);

    const departedIds = (existingCurrent || [])
        .map(r => r.parliament_member_id)
        .filter(id => !activeIds.has(id));

    if (departedIds.length > 0) {
        await supabase
            .from('mps')
            .update({ is_current_member: false })
            .in('parliament_member_id', departedIds);
        console.log(`Marked ${departedIds.length} departed MP(s) inactive.`);
    }

    await supabase
        .from('system_status')
        .upsert({ id: 1, is_parliament_dissolved: false, last_roster_sync: new Date().toISOString() });

    console.log(`[${new Date().toISOString()}] Roster sync complete: ${finalMps.length} active MPs synced.`);
}

syncRoster();
