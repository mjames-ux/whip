/**
 * One-time converter: House of Commons Library 1918–2019 CSV -> historical_majorities.json
 */

import fs from 'node:fs';
import path from 'node:path';

const csvPath = process.argv[2] || path.resolve(process.cwd(), '1918-2019election_results.csv');
if (!fs.existsSync(csvPath)) {
    console.log(`CSV not found at ${csvPath} — skipping historical majorities build.`);
    process.exit(0);
}

const YEAR_TO_DATE = {
    '1979': '1979-05-03',
    '1983': '1983-06-09',
    '1987': '1987-06-11',
    '1992': '1992-04-09',
    '1997': '1997-05-01',
    '2001': '2001-06-07',
    '2005': '2005-05-05'
};

function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                cur += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === ',' && !inQuotes) {
            out.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    out.push(cur);
    return out;
}

function normalizeSeat(name) {
    return String(name || '')
        .replace(/\s*\[[^\]]+\]\s*/g, ' ')
        .replace(/&/g, 'and')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

const raw = fs.readFileSync(csvPath, 'utf8');
const lines = raw.split(/\r?\n/).filter(Boolean);
const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());

const colIdx = {
    constituency: headers.findIndex(h => h === 'constituency' || h === 'constituency_name'),
    election: headers.findIndex(h => h === 'election' || h === 'year'),
    voteCols: headers
        .map((h, idx) => (/_votes$/i.test(h) && !/^total/i.test(h) ? idx : -1))
        .filter(idx => idx !== -1)
};

const out = {};

for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    const year = String(row[colIdx.election] || '').trim();
    const isoDate = YEAR_TO_DATE[year];
    if (!isoDate) continue;

    const seat = normalizeSeat(row[colIdx.constituency]);
    if (!seat) continue;

    const votes = colIdx.voteCols
        .map(idx => Number(String(row[idx] || '').replace(/,/g, '')))
        .filter(n => Number.isFinite(n) && n > 0)
        .sort((a, b) => b - a);

    if (votes.length >= 2) {
        out[`${seat}-${isoDate}`] = votes[0] - votes[1];
    } else if (votes.length === 1) {
        out[`${seat}-${isoDate}`] = votes[0];
    }
}

const outPath = path.resolve(process.cwd(), 'historical_majorities.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${Object.keys(out).length} pre-2010 constituency majorities to ${outPath}`);
