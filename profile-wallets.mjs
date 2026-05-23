import fs from 'fs';
import path from 'path';

const INPUT_FILE = 'early-token-receivers.csv';

const WALLET_PERFORMANCE_FILE = 'wallet-performance.csv';
const SMART_WALLETS_FILE = 'smart-wallets.csv';
const LOW_QUALITY_FILE = 'low-quality-wallets.csv';

const MIN_A_UNIQUE_TOKENS = Number(process.env.PROFILE_MIN_A_UNIQUE_TOKENS || 3);
const MIN_B_UNIQUE_TOKENS = Number(process.env.PROFILE_MIN_B_UNIQUE_TOKENS || 2);

const MAX_A_AVG_EARLY_INDEX = Number(process.env.PROFILE_MAX_A_AVG_EARLY_INDEX || 100);
const MAX_B_AVG_EARLY_INDEX = Number(process.env.PROFILE_MAX_B_AVG_EARLY_INDEX || 175);

const MAX_A_BEST_EARLY_INDEX = Number(process.env.PROFILE_MAX_A_BEST_EARLY_INDEX || 75);
const MAX_B_BEST_EARLY_INDEX = Number(process.env.PROFILE_MAX_B_BEST_EARLY_INDEX || 150);

const MIN_DISCOVERY_SCORE = Number(process.env.PROFILE_MIN_DISCOVERY_SCORE || 150);

const QUOTE_TOKEN_ADDRESSES = new Set([
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', // WBTC
]);

const QUOTE_SYMBOLS = new Set([
  'WETH',
  'ETH',
  'USDC',
  'USDT',
  'DAI',
  'WBTC',
]);

const SPAM_PATTERNS = [
  '.com',
  '.net',
  '.org',
  'claim',
  'airdrop',
  'visit',
  'www.',
  'http',
  'https',
];

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

function csvEscape(value) {
  const str = String(value ?? '');

  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replaceAll('"', '""')}"`;
  }

  return str;
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  result.push(current);

  return result;
}

function parseCsv(filePath) {
  const abs = path.resolve(filePath);

  if (!fs.existsSync(abs)) {
    throw new Error(`Missing input file: ${filePath}`);
  }

  const raw = fs.readFileSync(abs, 'utf8').trim();

  if (!raw) {
    return [];
  }

  const lines = raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length <= 1) {
    return [];
  }

  const headers = parseCsvLine(lines[0]).map((h) => h.trim());

  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row = {};

    headers.forEach((header, index) => {
      row[header] = cols[index] || '';
    });

    return row;
  });
}

function writeCsv(filename, rows) {
  if (!rows.length) {
    fs.writeFileSync(path.resolve(filename), '');
    console.log(`No rows for ${filename}`);
    return;
  }

  const headers = Object.keys(rows[0]);

  const body = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ].join('\n');

  fs.writeFileSync(path.resolve(filename), body + '\n');
  console.log(`Wrote ${rows.length} rows to ${filename}`);
}

function isQuoteToken(row) {
  const tokenAddress = norm(row.tokenAddress);
  const symbol = String(row.tokenSymbol || '').trim().toUpperCase();

  return QUOTE_TOKEN_ADDRESSES.has(tokenAddress) || QUOTE_SYMBOLS.has(symbol);
}

function isUnknownToken(row) {
  const symbol = String(row.tokenSymbol || '').trim();
  const name = String(row.tokenName || '').trim();

  return !symbol || symbol === '?' || !name || name === '?';
}

function isSpamToken(row) {
  const symbol = String(row.tokenSymbol || '').trim();
  const name = String(row.tokenName || '').trim();

  const combined = `${symbol} ${name}`.toLowerCase();

  return SPAM_PATTERNS.some((pattern) => combined.includes(pattern));
}

function classifyWallet(profile) {
  const isLowQuality =
    profile.quoteTokenRatio >= 0.5 ||
    profile.unknownTokenRatio >= 0.5 ||
    profile.spamTokenRatio >= 0.25;

  if (isLowQuality) {
    return 'LOW_QUALITY';
  }

  if (
    profile.uniqueTokenCount >= MIN_A_UNIQUE_TOKENS &&
    profile.avgEarlyIndex <= MAX_A_AVG_EARLY_INDEX &&
    profile.bestEarlyIndex <= MAX_A_BEST_EARLY_INDEX
  ) {
    return 'A_CANDIDATE';
  }

  if (
    profile.uniqueTokenCount >= MIN_B_UNIQUE_TOKENS &&
    profile.avgEarlyIndex <= MAX_B_AVG_EARLY_INDEX &&
    profile.bestEarlyIndex <= MAX_B_BEST_EARLY_INDEX
  ) {
    return 'B_CANDIDATE';
  }

  if (profile.score >= MIN_DISCOVERY_SCORE && profile.bestEarlyIndex <= 120) {
    return 'C_DISCOVERY';
  }

  return 'LOW_PRIORITY';
}

function buildWalletProfiles(rows) {
  const wallets = new Map();

  for (const row of rows) {
    const wallet = norm(row.wallet);

    if (!wallet) continue;

    if (!wallets.has(wallet)) {
      wallets.set(wallet, {
        wallet,
        chains: new Set(),
        uniqueTokens: new Set(),
        tokenSymbols: new Set(),
        tokenNames: new Set(),
        tokenRows: [],
        firstSeenBlocks: [],
        timestamps: [],
        earlyIndexes: [],
        examples: [],
        quoteTokenHits: 0,
        unknownTokenHits: 0,
        spamTokenHits: 0,
      });
    }

    const profile = wallets.get(wallet);

    const chain = String(row.chain || '').trim();
    const tokenAddress = norm(row.tokenAddress);
    const tokenSymbol = String(row.tokenSymbol || '').trim();
    const tokenName = String(row.tokenName || '').trim();
    const firstSeenTransferIndex = Number(row.firstSeenTransferIndex || 0);
    const firstSeenBlock = Number(row.firstSeenBlock || 0);
    const firstSeenTimestamp = Number(row.firstSeenTimestamp || 0);

    if (chain) profile.chains.add(chain);
    if (tokenAddress) profile.uniqueTokens.add(`${chain}:${tokenAddress}`);
    if (tokenSymbol) profile.tokenSymbols.add(tokenSymbol);
    if (tokenName) profile.tokenNames.add(tokenName);

    if (firstSeenTransferIndex > 0) profile.earlyIndexes.push(firstSeenTransferIndex);
    if (firstSeenBlock > 0) profile.firstSeenBlocks.push(firstSeenBlock);
    if (firstSeenTimestamp > 0) profile.timestamps.push(firstSeenTimestamp);

    if (isQuoteToken(row)) profile.quoteTokenHits += 1;
    if (isUnknownToken(row)) profile.unknownTokenHits += 1;
    if (isSpamToken(row)) profile.spamTokenHits += 1;

    profile.tokenRows.push(row);

    if (profile.examples.length < 12) {
      profile.examples.push({
        chain,
        token: tokenAddress,
        symbol: tokenSymbol,
        name: tokenName,
        index: firstSeenTransferIndex,
        tx: row.txHash || '',
      });
    }
  }

  const output = [];

  for (const [, profile] of wallets.entries()) {
    const uniqueTokenCount = profile.uniqueTokens.size;
    const earlyHitCount = profile.tokenRows.length;

    const avgEarlyIndex =
      profile.earlyIndexes.length > 0
        ? profile.earlyIndexes.reduce((sum, value) => sum + value, 0) /
          profile.earlyIndexes.length
        : 999999;

    const bestEarlyIndex =
      profile.earlyIndexes.length > 0
        ? Math.min(...profile.earlyIndexes)
        : 999999;

    const chainCount = profile.chains.size;

    const quoteTokenRatio = earlyHitCount > 0 ? profile.quoteTokenHits / earlyHitCount : 0;
    const unknownTokenRatio = earlyHitCount > 0 ? profile.unknownTokenHits / earlyHitCount : 0;
    const spamTokenRatio = earlyHitCount > 0 ? profile.spamTokenHits / earlyHitCount : 0;

    const repeatScore = uniqueTokenCount * 120;
    const earlyScore = Math.max(0, 200 - avgEarlyIndex);
    const bestIndexScore = Math.max(0, 150 - bestEarlyIndex);
    const chainScore = chainCount > 1 ? 75 : 0;

    const noisePenalty =
      quoteTokenRatio * 100 +
      unknownTokenRatio * 150 +
      spamTokenRatio * 200;

    const score = repeatScore + earlyScore + bestIndexScore + chainScore - noisePenalty;

    const normalizedProfile = {
      wallet: profile.wallet,
      classification: '',
      score: Number(score.toFixed(2)),
      uniqueTokenCount,
      earlyHitCount,
      chainCount,
      chains: [...profile.chains].join('|'),
      tokenSymbols: [...profile.tokenSymbols].join('|'),
      bestEarlyIndex,
      avgEarlyIndex: Number(avgEarlyIndex.toFixed(2)),
      quoteTokenHits: profile.quoteTokenHits,
      unknownTokenHits: profile.unknownTokenHits,
      spamTokenHits: profile.spamTokenHits,
      quoteTokenRatio: Number(quoteTokenRatio.toFixed(3)),
      unknownTokenRatio: Number(unknownTokenRatio.toFixed(3)),
      spamTokenRatio: Number(spamTokenRatio.toFixed(3)),
      firstSeenBlock:
        profile.firstSeenBlocks.length > 0 ? Math.min(...profile.firstSeenBlocks) : '',
      latestSeenTimestamp:
        profile.timestamps.length > 0 ? Math.max(...profile.timestamps) : '',
      examples: JSON.stringify(profile.examples),
    };

    normalizedProfile.classification = classifyWallet(normalizedProfile);

    output.push(normalizedProfile);
  }

  output.sort((a, b) => b.score - a.score);

  return output;
}

function main() {
  console.log('Wallet Profiler v0.8');
  console.log(`Input: ${INPUT_FILE}`);
  console.log('');
  console.log(`MIN_A_UNIQUE_TOKENS=${MIN_A_UNIQUE_TOKENS}`);
  console.log(`MIN_B_UNIQUE_TOKENS=${MIN_B_UNIQUE_TOKENS}`);
  console.log(`MAX_A_AVG_EARLY_INDEX=${MAX_A_AVG_EARLY_INDEX}`);
  console.log(`MAX_B_AVG_EARLY_INDEX=${MAX_B_AVG_EARLY_INDEX}`);
  console.log(`MAX_A_BEST_EARLY_INDEX=${MAX_A_BEST_EARLY_INDEX}`);
  console.log(`MAX_B_BEST_EARLY_INDEX=${MAX_B_BEST_EARLY_INDEX}`);
  console.log('');

  const rows = parseCsv(INPUT_FILE);

  console.log(`Loaded early token receiver rows: ${rows.length}`);

  const profiles = buildWalletProfiles(rows);

  const smartWallets = profiles.filter((profile) =>
    ['A_CANDIDATE', 'B_CANDIDATE'].includes(profile.classification)
  );

  const lowQuality = profiles.filter((profile) =>
    ['LOW_QUALITY', 'LOW_PRIORITY'].includes(profile.classification)
  );

  writeCsv(WALLET_PERFORMANCE_FILE, profiles);
  writeCsv(SMART_WALLETS_FILE, smartWallets);
  writeCsv(LOW_QUALITY_FILE, lowQuality);

  console.log('');
  console.log('Done.');
  console.log(`Wallet profiles: ${profiles.length}`);
  console.log(`Smart wallet candidates: ${smartWallets.length}`);
  console.log(`Low quality / low priority wallets: ${lowQuality.length}`);

  if (smartWallets.length > 0) {
    console.log('');
    console.log('Top smart wallet candidates:');

    for (const profile of smartWallets.slice(0, 15)) {
      console.log(
        `  ${profile.wallet} | ${profile.classification} | score=${profile.score} | tokens=${profile.uniqueTokenCount} | best=${profile.bestEarlyIndex} | avg=${profile.avgEarlyIndex} | symbols=${profile.tokenSymbols}`
      );
    }
  } else {
    console.log('');
    console.log('No A/B smart wallet candidates yet.');
    console.log('Increase manual-tokens.csv universe and run npm start again.');
  }
}

main();