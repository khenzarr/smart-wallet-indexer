import axios from 'axios';
import fs from 'fs';
import path from 'path';

const OUTPUT_FILE = 'manual-tokens.csv';

const CHAINS = new Set(['ethereum', 'base']);

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

function isLikelyAddress(addr) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(addr || '').trim());
}

function parseCsvSimple(filePath) {
  const abs = path.resolve(filePath);

  if (!fs.existsSync(abs)) {
    return [];
  }

  const raw = fs.readFileSync(abs, 'utf8').trim();

  if (!raw) {
    return [];
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= 1) {
    return [];
  }

  const headers = lines[0].split(',').map((h) => h.trim());

  return lines.slice(1).map((line) => {
    const cols = line.split(',').map((c) => c.trim());
    const row = {};

    headers.forEach((header, index) => {
      row[header] = cols[index] || '';
    });

    return row;
  });
}

function csvEscape(value) {
  const str = String(value || '');

  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replaceAll('"', '""')}"`;
  }

  return str;
}

function writeManualTokensCsv(rows) {
  const header = 'chain,tokenAddress,note\n';

  const body = rows
    .map((row) =>
      [
        csvEscape(row.chain),
        csvEscape(row.tokenAddress),
        csvEscape(row.note),
      ].join(',')
    )
    .join('\n');

  fs.writeFileSync(path.resolve(OUTPUT_FILE), header + body + '\n');
}

async function getDexScreenerLatestProfiles() {
  const url = 'https://api.dexscreener.com/token-profiles/latest/v1';
  const { data } = await axios.get(url, { timeout: 20000 });

  return Array.isArray(data) ? data : [];
}

async function getDexScreenerLatestBoosts() {
  const url = 'https://api.dexscreener.com/token-boosts/latest/v1';
  const { data } = await axios.get(url, { timeout: 20000 });

  return Array.isArray(data) ? data : [];
}

async function getDexScreenerTopBoosts() {
  const url = 'https://api.dexscreener.com/token-boosts/top/v1';
  const { data } = await axios.get(url, { timeout: 20000 });

  return Array.isArray(data) ? data : [];
}

function tokenFromDexItem(item, source) {
  const chain = norm(item.chainId);
  const tokenAddress = norm(item.tokenAddress);

  if (!CHAINS.has(chain)) return null;
  if (!isLikelyAddress(tokenAddress)) return null;

  const symbolOrDesc =
    item.description ||
    item.header ||
    item.url ||
    '';

  return {
    chain,
    tokenAddress,
    note: `${source} ${symbolOrDesc}`.trim(),
  };
}

function dedupeTokens(rows) {
  const map = new Map();

  for (const row of rows) {
    const chain = norm(row.chain);
    const tokenAddress = norm(row.tokenAddress);

    if (!CHAINS.has(chain)) continue;
    if (!isLikelyAddress(tokenAddress)) continue;

    const key = `${chain}:${tokenAddress}`;

    if (!map.has(key)) {
      map.set(key, {
        chain,
        tokenAddress,
        note: row.note || '',
      });
    }
  }

  return [...map.values()].sort((a, b) => {
    if (a.chain !== b.chain) return a.chain.localeCompare(b.chain);
    return a.tokenAddress.localeCompare(b.tokenAddress);
  });
}

async function main() {
  console.log('Collecting token universe from DEX Screener...');
  console.log(`Output file: ${OUTPUT_FILE}`);

  const existingRows = parseCsvSimple(OUTPUT_FILE);

  console.log(`Existing manual tokens: ${existingRows.length}`);

  const [profiles, latestBoosts, topBoosts] = await Promise.all([
    getDexScreenerLatestProfiles(),
    getDexScreenerLatestBoosts(),
    getDexScreenerTopBoosts(),
  ]);

  const discovered = [
    ...profiles.map((item) => tokenFromDexItem(item, 'dex_profiles_latest')),
    ...latestBoosts.map((item) => tokenFromDexItem(item, 'dex_boosts_latest')),
    ...topBoosts.map((item) => tokenFromDexItem(item, 'dex_boosts_top')),
  ].filter(Boolean);

  console.log(`Discovered tokens this run: ${discovered.length}`);

  const merged = dedupeTokens([...existingRows, ...discovered]);

  writeManualTokensCsv(merged);

  console.log(`Updated manual tokens: ${merged.length}`);
  console.log('');
  console.log('Done.');
  console.log('Next step: run npm start to scan the enlarged token universe.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});