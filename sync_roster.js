/**
 * Whip — Step 1: Active Commons MP & Constituency Roster Sync (`sync_roster.js`)
 *
 * Fetches all currently sitting Members of Parliament from the official UK Parliament
 * Members API, upserts constituencies (`constituencies`), resolves each MP's current
 * ministerial/opposition/Speaker title plus their complete career election wins and
 * majorities (`election_wins`), and upserts all active MPs into Supabase (`mps`).
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const MEMBERS_SEARCH_API = 'https://members-api.parliament.uk/api/Members/Search';
const MEMBER_BASE_API = 'https://members-api.parliament.uk/api/Members';
const CONSTITUENCY_BASE_API = 'https://members-api.parliament.uk/api/Location/Constituency';

const SYNC_CONCURRENCY = 8;

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
    'Independent': '#6B7280',
    'Speaker': '#111827'
};

const PRE_2010_GENERAL_ELECTIONS = [
    '1979-05-03',
    '1983-06-09',
    '1987-06-11',
    '1992-04-09',
    '1997-05-01',
    '2001-06-07',
    '2005-05-05'
];

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url, timeoutMs = 20000) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(timeoutMs)
            });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            return await res.json();
        } catch (err) {
            if (attempt === 2) throw err;
            await sleep(750);
        }
    }
    return null;
}

function isCurrentRoleItem(item) {
    if (!item || !item.name) return false;
    if (!item.endDate) return true;
    const endTime = new Date(item.endDate).getTime();
    return Number.isFinite(endTime) && endTime > Date.now();
}

function buildRoleTitle(bio, seatName) {
    const cleanSeat = (seatName || 'UK Constituency').trim();
    if (!bio) return `MP for ${cleanSeat}`;

    const govPosts = (Array.isArray(bio.governmentPosts) ? bio.governmentPosts : []).filter(isCurrentRoleItem);
    if (govPosts.length > 0) {
        return `${govPosts[0].name.trim()} • MP for ${cleanSeat}`;
    }

    const oppPosts = (Array.isArray(bio.oppositionPosts) ? bio.oppositionPosts : []).filter(isCurrentRoleItem);
    if (oppPosts.length > 0) {
        return `${oppPosts[0].name.trim()} • MP for ${cleanSeat}`;
    }

    const otherPosts = (Array.isArray(bio.otherPosts) ? bio.otherPosts : []).filter(isCurrentRoleItem);
    const speakerPost = otherPosts.find(p => /\b(speaker|chairman of ways and means|deputy chairman of ways and means)\b/i.test(p.name));
    if (speakerPost) {
        return `${speakerPost.name.trim()} • MP for ${cleanSeat}`;
    }

    return `MP for ${cleanSeat}`;
}

function getEarliestRepresentationStart(reps, fallbackDate) {
    const starts = (Array.isArray(reps) ? reps : [])
        .map(r => r?.startDate)
        .filter(Boolean)
        .sort();
    return starts[0] ? String(starts[0]).slice(0, 10) : (fallbackDate ? String(fallbackDate).slice(0, 10) : null);
}

function normalizeSeatBaseName(name) {
    return String(name || '')
        .replace(/\s*\[[^\]]+\]\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

const constituencyResultsCache = new Map();
const electionDetailCache = new Map();
const seatSearchCache = new Map();

async function searchConstituencyIdsByName(seatName) {
    const cleanBase = normalizeSeatBaseName(seatName);
    if (!cleanBase || cleanBase === 'uk constituency') return [];
    if (seatSearchCache.has(cleanBase)) return seatSearchCache.get(cleanBase);

    try {
        const url = `${CONSTITUENCY_BASE_API}/Search?searchText=${encodeURIComponent(cleanBase)}&take=25`;
        const json = await fetchJsonWithRetry(url, 15000);
        const items = Array.isArray(json?.items)
            ? json.items.map(it => it?.value || it).filter(Boolean)
            : (Array.isArray(json?.value) ? json.value : []);

        const ids = items
            .filter(s => normalizeSeatBaseName(s?.name) === cleanBase)
            .map(s => Number(s.id))
            .filter(Boolean);

        seatSearchCache.set(cleanBase, ids);
        return ids;
    } catch {
        seatSearchCache.set(cleanBase, []);
        return [];
    }
}

async function getConstituencyElectionResults(constituencyId) {
    const cId = Number(constituencyId);
    if (!cId) return [];
    if (constituencyResultsCache.has(cId)) return constituencyResultsCache.get(cId);

    try {
        const json = await fetchJsonWithRetry(`${CONSTITUENCY_BASE_API}/${cId}/ElectionResults`, 15000);
        const list = Array.isArray(json?.value)
            ? json.value
            : (Array.isArray(json?.items) ? json.items.map(it => it?.value || it) : []);
        constituencyResultsCache.set(cId, list);
        return list;
    } catch {
        constituencyResultsCache.set(cId, []);
        return [];
    }
}

async function getElectionResultDetail(constituencyId, electionId) {
    const key = `${constituencyId}-${electionId}`;
    if (electionDetailCache.has(key)) return electionDetailCache.get(key);

    try {
        const json = await fetchJsonWithRetry(`${CONSTITUENCY_BASE_API}/${constituencyId}/ElectionResult/${electionId}`, 15000);
        const val = json?.value || json || null;
        electionDetailCache.set(key, val);
        return val;
    } catch {
        electionDetailCache.set(key, null);
        return null;
    }
}

async function fetchMemberBioAndWins(memberId, fallbackSeatName) {
    const id = Number(memberId);
    const [bioJson, latestJson] = await Promise.all([
        fetchJsonWithRetry(`${MEMBER_BASE_API}/${id}/Biography`, 15000).catch(() => null),
        fetchJsonWithRetry(`${MEMBER_BASE_API}/${id}/LatestElectionResult`, 15000).catch(() => null)
    ]);

    const bio = bioJson?.value || null;
    const latest = latestJson?.value || null;
    const reps = Array.isArray(bio?.representations) ? bio.representations : [];

    const wins = [];
    const seen = new Set();

    for (const rep of reps) {
        const rawSeatName = (rep?.name || fallbackSeatName || '').trim();
        const displaySeatName = rawSeatName.replace(/\s*\[[^\]]+\]\s*/g, ' ').trim();
        const seatLower = normalizeSeatBaseName(rawSeatName);
        const repStart = rep?.startDate ? new Date(rep.startDate).getTime() : NaN;
        const repEnd = rep?.endDate ? new Date(rep.endDate).getTime() : Date.now();
        if (!Number.isFinite(repStart)) continue;

        const candidateSeatIds = new Set();
        if (Number(rep?.constituencyId)) candidateSeatIds.add(Number(rep.constituencyId));
        const searchedIds = await searchConstituencyIdsByName(displaySeatName);
        for (const sId of searchedIds) candidateSeatIds.add(sId);

        for (const cId of candidateSeatIds) {
            const seatResults = await getConstituencyElectionResults(cId);
            for (const er of seatResults) {
                if (!er?.electionDate) continue;
                const t = new Date(er.electionDate).getTime();
                const isWithinTerm = t >= repStart - 21 * 86400000 && t <= repEnd + 3 * 86400000;
                if (!isWithinTerm) continue;

                const dateKey = String(er.electionDate).slice(0, 10);
                const dedupeKey = `${seatLower}-${dateKey}`;
                if (seen.has(dedupeKey)) continue;

                let detail = null;
                if (cId && er.electionId) {
                    detail = await getElectionResultDetail(cId, er.electionId);
                }

                const candidates = Array.isArray(detail?.candidates) ? detail.candidates : [];
                const winner = candidates.find(c => c?.rank === 1 || c?.isWinner);
                if (winner?.memberId && Number(winner.memberId) !== id) continue;

                seen.add(dedupeKey);
                wins.push({
                    constituencyName: displaySeatName,
                    electionDate: detail?.electionDate || er.electionDate,
                    electionTitle: detail?.electionTitle || er.electionTitle || '',
                    isGeneralElection: typeof detail?.isGeneralElection === 'boolean'
                        ? detail.isGeneralElection
                        : Boolean(er.isGeneralElection),
                    majority: typeof detail?.majority === 'number'
                        ? detail.majority
                        : (typeof er.majority === 'number' ? er.majority : null)
                });
            }
        }

        // Ensure the representation start election is captured even if pre-2010 ElectionResults omits it
        const startDateKey = String(rep.startDate).slice(0, 10);
        if (!seen.has(`${seatLower}-${startDateKey}`)) {
            seen.add(`${seatLower}-${startDateKey}`);
            wins.push({
                constituencyName: displaySeatName,
                electionDate: rep.startDate,
                electionTitle: '',
                isGeneralElection: !/by-?election/i.test(rep.additionalInfo || ''),
                majority: null
            });
        }

        // Expand any pre-2010 general elections won during the same boundary-era representation stint
        for (const geDate of PRE_2010_GENERAL_ELECTIONS) {
            const geTime = new Date(`${geDate}T00:00:00Z`).getTime();
            if (geTime >= repStart - 21 * 86400000 && geTime <= repEnd + 3 * 86400000) {
                const dedupeKey = `${seatLower}-${geDate}`;
                if (!seen.has(dedupeKey)) {
                    seen.add(dedupeKey);
                    wins.push({
                        constituencyName: displaySeatName,
                        electionDate: `${geDate}T00:00:00`,
                        electionTitle: '',
                        isGeneralElection: true,
                        majority: null
                    });
                }
            }
        }
    }

    if (latest?.electionDate) {
        const dateKey = String(latest.electionDate).slice(0, 10);
        const existing = wins.find(w => String(w.electionDate).slice(0, 10) === dateKey);
        if (existing) {
            if (existing.majority === null && typeof latest.majority === 'number') {
                existing.majority = latest.majority;
            }
            existing.electionTitle = latest.electionTitle || existing.electionTitle;
            if (typeof latest.isGeneralElection === 'boolean') {
                existing.isGeneralElection = latest.isGeneralElection;
            }
        } else {
            wins.push({
                constituencyName: (latest.constituencyName || fallbackSeatName || '').replace(/\s*\[[^\]]+\]\s*/g, ' ').trim(),
                electionDate: latest.electionDate,
                electionTitle: latest.electionTitle || '',
                isGeneralElection: Boolean(latest.isGeneralElection),
                majority: typeof latest.majority === 'number' ? latest.majority : null
            });
        }
    }

    wins.sort((a, b) => new Date(b.electionDate || 0) - new Date(a.electionDate || 0));

    return { bio, reps, electionWins: wins };
}

async function fetchAllCurrentCommonsMembers() {
    const members = [];
    let skip = 0;
    const take = 20;

    while (true) {
        const url = new URL(MEMBERS_SEARCH_API);
        url.searchParams.set('House', '1'); // 1 = Commons
        url.searchParams.set('IsCurrentMember', 'true');
        url.searchParams.set('skip', String(skip));
        url.searchParams.set('take', String(take));

        const data = await fetchJsonWithRetry(url.toString(), 25000);
        const items = Array.isArray(data?.items) ? data.items : [];
        if (items.length === 0) break;

        for (const item of items) {
            if (item?.value) members.push(item.value);
        }

        skip += items.length;
        const total = Number(data?.totalResults ?? 0);
        if (skip >= total) break;
    }

    return members;
}

export async function syncRoster() {
    console.log(`[${new Date().toISOString()}] Fetching active House of Commons roster...`);
    const rawMembers = await fetchAllCurrentCommonsMembers();

    if (!rawMembers.length) {
        throw new Error('Parliament Members API returned 0 active Commons members.');
    }

    console.log(`Fetched ${rawMembers.length} active Commons members. Resolving roles & election histories...`);

    const constituencyMap = new Map();
    for (const m of rawMembers) {
        const membership = m?.latestHouseMembership;
        const cId = Number(membership?.membershipFromId);
        const cName = (membership?.membershipFrom || '').trim();
        if (cId && cName) {
            constituencyMap.set(cId, {
                parliament_constituency_id: cId,
                name: cName
            });
        }
    }

    if (constituencyMap.size > 0) {
        const constituenciesToUpsert = Array.from(constituencyMap.values());
        for (let i = 0; i < constituenciesToUpsert.length; i += 100) {
            const chunk = constituenciesToUpsert.slice(i, i + 100);
            const { error: constErr } = await supabase
                .from('constituencies')
                .upsert(chunk, { onConflict: 'parliament_constituency_id' });
            if (constErr) {
                console.warn(`Constituencies upsert warning: ${constErr.message}`);
            }
        }
    }

    const activeIds = rawMembers.map(m => Number(m.id)).filter(Boolean);
    const mpRows = [];

    for (let i = 0; i < rawMembers.length; i += SYNC_CONCURRENCY) {
        const batch = rawMembers.slice(i, i + SYNC_CONCURRENCY);
        const batchRows = await Promise.all(
            batch.map(async (m) => {
                const memberId = Number(m.id);
                const membership = m?.latestHouseMembership || {};
                const seatId = Number(membership?.membershipFromId) || null;
                const seatName = (membership?.membershipFrom || 'UK Constituency').trim();
                const partyName = (m?.latestParty?.name || 'Independent').trim();
                const partyColor = PARTY_COLORS[partyName]
                    || (m?.latestParty?.backgroundColour ? `#${m.latestParty.backgroundColour.replace(/^#/, '')}` : '#6B7280');

                const { bio, reps, electionWins } = await fetchMemberBioAndWins(memberId, seatName);
                const roleTitle = buildRoleTitle(bio, seatName);
                const memberSince = getEarliestRepresentationStart(reps, membership?.membershipStartDate);

                return {
                    parliament_member_id: memberId,
                    full_name: (m.nameDisplayAs || m.nameListAs || `Member ${memberId}`).trim(),
                    short_name: (m.nameDisplayAs || `Member ${memberId}`).replace(/^(Rt Hon|Sir|Dame|Dr|Mr|Mrs|Ms|Mx)\s+/i, '').trim(),
                    party: partyName,
                    party_color: partyColor,
                    role_title: roleTitle,
                    constituency_id: seatId,
                    member_since: memberSince,
                    election_wins: electionWins,
                    is_current_member: true
                };
            })
        );
        mpRows.push(...batchRows);
    }

    for (let i = 0; i < mpRows.length; i += 100) {
        const chunk = mpRows.slice(i, i + 100);
        const { error: mpErr } = await supabase
            .from('mps')
            .upsert(chunk, { onConflict: 'parliament_member_id' });
        if (mpErr) {
            throw new Error(`Failed upserting mps batch ${i}: ${mpErr.message}`);
        }
    }

    // Mark any former MPs no longer in the active Commons roster as inactive
    if (activeIds.length > 0) {
        const { error: deactivateErr } = await supabase
            .from('mps')
            .update({ is_current_member: false })
            .not('parliament_member_id', 'in', `(${activeIds.join(',')})`);

        if (deactivateErr) {
            console.warn(`Former MP deactivation warning: ${deactivateErr.message}`);
        }
    }

    console.log(`[${new Date().toISOString()}] Roster sync complete: ${mpRows.length} active MPs synced with full election histories.`);
}

syncRoster();
