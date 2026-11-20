/**
 * Whip — Step 1: 6:00 AM Daily MP Roster Sync
 *
 * Fetches all currently sitting House of Commons MPs from the official UK Parliament
 * Members API and upserts them into Supabase (`constituencies`, `mps`, `system_status`).
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const PARLIAMENT_MEMBERS_API = 'https://members-api.parliament.uk/api/Members/Search';
const PARLIAMENT_CONSTITUENCY_API = 'https://members-api.parliament.uk/api/Location/Constituency';
const PAGE_SIZE = 20;

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
    console.error('Missing SUPABASE_SERVICE_ROLE_KEY in GitHub Repository Secrets.');
    process.exit(1);
}

console.log(`Connecting to Supabase at: ${supabaseUrl}`);
const supabase = createClient(supabaseUrl, supabaseKey);

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

export async function syncRoster() {
    console.log(`[${new Date().toISOString()}] Starting Whip 6:00 AM MP roster sync...`);

    try {
        const rawMembers = await fetchAllSittingMPs();
        console.log(`Fetched ${rawMembers.length} active House of Commons MPs from Parliament API.`);

        // 1. Detect General Election Dissolution
        if (rawMembers.length === 0) {
            console.warn('0 active MPs returned — Parliament appears dissolved for a General Election.');

            await supabase
                .from('mps')
                .update({ is_current_member: false, updated_at: new Date().toISOString() })
                .eq('is_current_member', true);

            await supabase
                .from('system_status')
                .upsert({
                    id: 1,
                    is_parliament_dissolved: true,
                    active_mp_count: 0,
                    last_roster_sync: new Date().toISOString()
                });

            console.log('Dissolution Mode enabled in system_status.');
            return;
        }

        // 2. Build Constituency & MP records matching exact schema columns
        const constituencyMap = new Map();
        const mpRecords = [];
        const activeMpIds = [];

        for (const item of rawMembers) {
            const v = item?.value;
            if (!v || !v.id) continue;

            const membership = v.latestHouseMembership || {};
            const constituencyId = membership.membershipFromId || null;
            const constituencyName = membership.membershipFrom || 'Unknown Constituency';

            if (constituencyId && !constituencyMap.has(constituencyId)) {
                const meta = await fetchConstituencyMetadata(constituencyId);
                constituencyMap.set(constituencyId, {
                    parliament_constituency_id: constituencyId,
                    name: constituencyName,
                    gss_code: meta.gssCode,
                    region: meta.region,
                    updated_at: new Date().toISOString()
                });
            }

            const fullName = v.nameFullTitle || v.nameDisplayAs || `MP #${v.id}`;
            const shortName = v.nameDisplayAs || fullName;

            activeMpIds.push(v.id);
            mpRecords.push({
                parliament_member_id: v.id,
                full_name: fullName,
                short_name: shortName,
                party: v.latestParty?.name || 'Independent',
                party_color: v.latestParty?.backgroundColour
                    ? `#${v.latestParty.backgroundColour.replace(/^#/, '')}`
                    : '#64748b',
                role_title: `MP for ${constituencyName}`,
                constituency_id: constituencyId,
                thumbnail_url: v.thumbnailUrl || `https://members-api.parliament.uk/api/Members/${v.id}/Thumbnail`,
                is_current_member: true,
                updated_at: new Date().toISOString()
            });
        }

        // 3. Upsert Constituencies first (foreign key dependency)
        const constituencies = Array.from(constituencyMap.values());
        if (constituencies.length > 0) {
            const { error: constError } = await supabase
                .from('constituencies')
                .upsert(constituencies, { onConflict: 'parliament_constituency_id' });

            if (constError) {
                throw new Error(`Failed upserting constituencies: ${constError.message}`);
            }
            console.log(`Upserted ${constituencies.length} constituencies.`);
        }

        // 4. Upsert Active MPs in batches of 100
        const BATCH_SIZE = 100;
        for (let i = 0; i < mpRecords.length; i += BATCH_SIZE) {
            const batch = mpRecords.slice(i, i + BATCH_SIZE);
            const { error: mpError } = await supabase
                .from('mps')
                .upsert(batch, { onConflict: 'parliament_member_id' });

            if (mpError) {
                throw new Error(`Failed upserting MP batch ${i}: ${mpError.message}`);
            }
        }
        console.log(`Upserted ${mpRecords.length} active MPs.`);

        // 5. Mark any departed MPs (resignations / by-elections) as inactive
        if (activeMpIds.length > 0) {
            const { error: deactivateError } = await supabase
                .from('mps')
                .update({ is_current_member: false, updated_at: new Date().toISOString() })
                .eq('is_current_member', true)
                .not('parliament_member_id', 'in', `(${activeMpIds.join(',')})`);

            if (deactivateError) {
                console.warn(`Warning marking departed MPs inactive: ${deactivateError.message}`);
            }
        }

        // 6. Update system_status
        await supabase
            .from('system_status')
            .upsert({
                id: 1,
                is_parliament_dissolved: false,
                active_mp_count: mpRecords.length,
                last_roster_sync: new Date().toISOString()
            });

        console.log(`[${new Date().toISOString()}] Roster sync completed successfully!`);
    } catch (err) {
        console.error('Fatal error during roster sync:', err);
        process.exit(1);
    }
}

syncRoster();
