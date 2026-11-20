/**
 * Whip — Step 1: 6:00 AM Daily MP Roster Sync
 *
 * Fetches all currently sitting House of Commons MPs from the official UK Parliament
 * Members API and upserts them into Postgres. Automatically detects if Parliament
 * has been dissolved ahead of a General Election.
 *
 * Requirements:
 *   npm install @supabase/supabase-js dotenv
 *
 * Environment Variables (.env):
 *   SUPABASE_URL=https://your-project.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const PARLIAMENT_MEMBERS_API = 'https://members-api.parliament.uk/api/Members/Search';
const PARLIAMENT_CONSTITUENCY_API = 'https://members-api.parliament.uk/api/Location/Constituency';
const PAGE_SIZE = 20; // Parliament API standard page size

// Initialize Supabase admin client (bypasses Row Level Security for background cron jobs)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Fetches all active House of Commons MPs by paginating through Parliament's Members API.
 */
async function fetchAllSittingMPs() {
    const allMembers = [];
    let skip = 0;
    let totalResults = null;

    while (totalResults === null || skip < totalResults) {
        const url = new URL(PARLIAMENT_MEMBERS_API);
        url.searchParams.set('House', '1');              // 1 = House of Commons
        url.searchParams.set('IsCurrentMember', 'true'); // Only active MPs
        url.searchParams.set('skip', String(skip));
        url.searchParams.set('take', String(PAGE_SIZE));

        const response = await fetch(url.toString(), {
            headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
            throw new Error(`Parliament Members API error (${response.status}): ${response.statusText}`);
        }

        const payload = await response.json();
        totalResults = payload.totalResults ?? 0;

        if (!Array.isArray(payload.items) || payload.items.length === 0) {
            break;
        }

        allMembers.push(...payload.items);
        skip += payload.items.length;
    }

    return allMembers;
}

/**
 * Fetches official ONS GSS code (e.g., E14001234) and region for a constituency ID
 * so Postcodes.io lookups match accurately even after boundary changes.
 */
async function fetchConstituencyMetadata(constituencyId) {
    try {
        const response = await fetch(`${PARLIAMENT_CONSTITUENCY_API}/${constituencyId}`, {
            headers: { 'Accept': 'application/json' }
        });
        if (!response.ok) return { gssCode: null, region: null };

        const payload = await response.json();
        const val = payload?.value;
        return {
            gssCode: val?.gssCode || null,
            region: val?.regionName || null
        };
    } catch {
        return { gssCode: null, region: null };
    }
}

/**
 * Main sync routine: updates constituencies, upserts MPs, marks departed MPs inactive,
 * and toggles Dissolution Mode if active MP count drops to 0.
 */
export async function syncRoster() {
    console.log(`[${new Date().toISOString()}] Starting Whip 6:00 AM MP roster sync...`);

    try {
        const rawMembers = await fetchAllSittingMPs();
        console.log(`Fetched ${rawMembers.length} active House of Commons MPs from Parliament API.`);

        // 1. Detect General Election Dissolution
        // During dissolution, Parliament returns 0 current members.
        if (rawMembers.length === 0) {
            console.warn('0 active MPs returned — Parliament appears dissolved for a General Election.');

            await supabase
                .from('mps')
                .update({ is_current_member: false, updated_at: new Date().toISOString() })
                .eq('is_current_member', true);

            await supabase
                .from('system_status')
                .update({
                    is_parliament_dissolved: true,
                    active_mp_count: 0,
                    last_roster_sync: new Date().toISOString()
                })
                .eq('id', 1);

            return;
        }

        // 2. Prepare Constituency & MP records
        const constituencyMap = new Map();
        const mpRecords = [];
        const activeMemberIds = [];

        for (const item of rawMembers) {
            const val = item.value;
            if (!val || !val.id) continue;

            const membership = val.latestHouseMembership;
            const constituencyId = membership?.membershipFromId ?? null;
            const constituencyName = membership?.membershipFrom ?? 'Unknown Constituency';

            if (constituencyId) {
                constituencyMap.set(constituencyId, {
                    parliament_constituency_id: constituencyId,
                    name: constituencyName,
                    updated_at: new Date().toISOString()
                });
            }

            const partyName = val.latestParty?.name ?? 'Independent';
            const partyColor = val.latestParty?.backgroundColour
                ? `#${val.latestParty.backgroundColour.replace('#', '')}`
                : '#555555';

            activeMemberIds.push(val.id);
            mpRecords.push({
                parliament_member_id: val.id,
                full_name: val.nameDisplayAs || val.nameFullTitle || 'Member of Parliament',
                short_name: val.nameListAs
                    ? val.nameListAs.split(',').reverse().join(' ').trim()
                    : (val.nameDisplayAs || 'MP'),
                party: partyName,
                party_color: partyColor,
                role_title: membership?.membershipStatus?.statusDescription || 'Member of Parliament',
                constituency_id: constituencyId,
                thumbnail_url: val.thumbnailUrl || null,
                is_current_member: true,
                updated_at: new Date().toISOString()
            });
        }

        // 3. Upsert Constituencies first (foreign key parent) — enriched with ONS GSS codes
        const constituenciesToUpsert = [];
        const rawConstituencies = Array.from(constituencyMap.values());

        // Fetch GSS codes in small batches to stay polite to Parliament's API
        const BATCH_SIZE = 25;
        for (let i = 0; i < rawConstituencies.length; i += BATCH_SIZE) {
            const batch = rawConstituencies.slice(i, i + BATCH_SIZE);
            const enrichedBatch = await Promise.all(
                batch.map(async (c) => {
                    const meta = await fetchConstituencyMetadata(c.parliament_constituency_id);
                    return {
                        ...c,
                        gss_code: meta.gssCode,
                        region: meta.region
                    };
                })
            );
            constituenciesToUpsert.push(...enrichedBatch);
        }

        const { error: constError } = await supabase
            .from('constituencies')
            .upsert(constituenciesToUpsert, { onConflict: 'parliament_constituency_id' });

        if (constError) {
            throw new Error(`Failed to upsert constituencies: ${constError.message}`);
        }

        // 4. Upsert Active MPs
        const { error: mpError } = await supabase
            .from('mps')
            .upsert(mpRecords, { onConflict: 'parliament_member_id' });

        if (mpError) {
            throw new Error(`Failed to upsert MPs: ${mpError.message}`);
        }

        // 5. Mark any MP not in today's active list as former/inactive (handles resignations & by-elections)
        const { error: deactivateError } = await supabase
            .from('mps')
            .update({ is_current_member: false, updated_at: new Date().toISOString() })
            .not('parliament_member_id', 'in', `(${activeMemberIds.join(',')})`);

        if (deactivateError) {
            console.warn(`Warning deactivating former MPs: ${deactivateError.message}`);
        }

        // 6. Update System Status
        await supabase
            .from('system_status')
            .update({
                is_parliament_dissolved: false,
                active_mp_count: mpRecords.length,
                last_roster_sync: new Date().toISOString()
            })
            .eq('id', 1);

        console.log(`Successfully synced ${mpRecords.length} MPs across ${constituenciesToUpsert.length} constituencies.`);
    } catch (error) {
        console.error('Roster sync failed:', error);
        process.exitCode = 1;
    }
}

// Run directly when executed via CLI / cron
syncRoster();
