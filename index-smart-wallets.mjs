import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { createObjectCsvWriter } from 'csv-writer';

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

const EARLY_TRANSFER_LIMIT = Number(process.env.EARLY_TRANSFER_LIMIT || 250);

const DISCOVERY_MAX_AVG_EARLY_INDEX = Number(
  process.env.DISCOVERY_MAX_AVG_EARLY_INDEX || 120
);
const DISCOVERY_MAX_BEST_EARLY_INDEX = Number(
  process.env.DISCOVERY_MAX_BEST_EARLY_INDEX || 120
);

const REPEAT_MIN_TOKENS = Number(process.env.REPEAT_MIN_TOKENS || 2);
const REPEAT_MAX_AVG_EARLY_INDEX = Number(
  process.env.REPEAT_MAX_AVG_EARLY_INDEX || 200
);
const REPEAT_MAX_BEST_EARLY_INDEX = Number(
  process.env.REPEAT_MAX_BEST_EARLY_INDEX || 175
);

const WATCHLIST_MIN_TOKENS = Number(process.env.WATCHLIST_MIN_TOKENS || 2);
const WATCHLIST_MAX_AVG_EARLY_INDEX = Number(
  process.env.WATCHLIST_MAX_AVG_EARLY_INDEX || 150
);
const WATCHLIST_MAX_BEST_EARLY_INDEX = Number(
  process.env.WATCHLIST_MAX_BEST_EARLY_INDEX || 125
);

if (!ETHERSCAN_API_KEY) {
  throw new Error('Missing ETHERSCAN_API_KEY in .env');
}

const CHAINS = [
  {
    name: 'ethereum',
    dexscreenerChainId: 'ethereum',
    etherscanChainId: '1',
    explorer: 'etherscan',
  },
  {
    name: 'base',
    dexscreenerChainId: 'base',
    etherscanChainId: '8453',
    explorer: 'etherscan_with_blockscout_fallback',
    blockscoutBaseUrl: 'https://base.blockscout.com',
  },
];

const ZERO = '0x0000000000000000000000000000000000000000';

const KNOWN_NOISE = new Set([
  ZERO.toLowerCase(),
  '0x000000000000000000000000000000000000dead',
]);

const DEFAULT_BLACKLIST = new Set([
  '0x7f54f05635d15cde17a49502fedb9d1803a3be8a',
]);

const runtimeBlacklist = new Set([...DEFAULT_BLACKLIST]);
const contractCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function norm(addr) {
  return String(addr || '').trim().toLowerCase();
}

function isLikelyAddress(addr) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(addr || '').trim());
}

function fileExists(filePath) {
  return fs.existsSync(path.resolve(filePath));
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

function loadBlacklistCsv() {
  const rows = parseCsvSimple('blacklist.csv');

  for (const row of rows) {
    const address = norm(row.address);

    if (isLikelyAddress(address)) {
      runtimeBlacklist.add(address);
    }
  }

  return rows.length;
}

function tokenFromCsvRow(row, sourceName) {
  const chainName = String(row.chain || '').trim().toLowerCase();
  const tokenAddress = norm(row.tokenAddress);

  const chain = CHAINS.find((c) => c.name === chainName);

  if (!chain) return null;
  if (!isLikelyAddress(tokenAddress)) return null;

  return {
    chain: chain.name,
    dexscreenerChainId: chain.dexscreenerChainId,
    etherscanChainId: chain.etherscanChainId,
    explorer: chain.explorer,
    blockscoutBaseUrl: chain.blockscoutBaseUrl || null,
    tokenAddress,
    sourceUrl: row.dexUrl || '',
    source: sourceName,
    description: row.note || row.symbol || '',
  };
}

function loadManualTokensCsv() {
  const rows = parseCsvSimple('manual-tokens.csv');
  return rows.map((row) => tokenFromCsvRow(row, 'manual')).filter(Boolean);
}

function loadMarketTokensCsv() {
  const rows = parseCsvSimple('market-tokens.csv');
  return rows.map((row) => tokenFromCsvRow(row, 'market')).filter(Boolean);
}

function isNoiseAddress(addr) {
  const a = norm(addr);

  if (!isLikelyAddress(a)) return true;
  if (KNOWN_NOISE.has(a)) return true;
  if (runtimeBlacklist.has(a)) return true;

  return false;
}

function formatExplorerError(data) {
  const status = data?.status ?? 'NO_STATUS';
  const message = data?.message ?? 'NO_MESSAGE';

  let result = data?.result;

  if (Array.isArray(result)) {
    result = JSON.stringify(result.slice(0, 3));
  } else if (typeof result === 'object' && result !== null) {
    result = JSON.stringify(result);
  } else if (typeof result === 'undefined') {
    result = 'NO_RESULT';
  }

  return `status=${status} | message=${message} | result=${result}`;
}

function isEtherscanFreeChainCoverageError(message) {
  return String(message || '')
    .toLowerCase()
    .includes('free api access is not supported for this chain');
}

async function isContractAddressWithEtherscan({ chainId, address }) {
  const a = norm(address);
  const cacheKey = `etherscan:${chainId}:${a}`;

  if (contractCache.has(cacheKey)) {
    return contractCache.get(cacheKey);
  }

  const url = 'https://api.etherscan.io/v2/api';

  const params = {
    chainid: chainId,
    module: 'contract',
    action: 'getsourcecode',
    address: a,
    apikey: ETHERSCAN_API_KEY,
  };

  try {
    const { data } = await axios.get(url, {
      params,
      timeout: 30000,
    });

    const result = Array.isArray(data.result) ? data.result[0] : null;

    const hasContractSignal =
      result &&
      (result.ContractName ||
        result.SourceCode ||
        result.ABI ||
        result.Proxy === '1' ||
        result.Implementation);

    const isContract = Boolean(hasContractSignal);

    contractCache.set(cacheKey, isContract);
    return isContract;
  } catch (err) {
    console.log(`    etherscan contract check failed for ${a}: ${err.message}`);
    contractCache.set(cacheKey, false);
    return false;
  }
}

async function isContractAddressWithBlockscout({ baseUrl, address }) {
  const a = norm(address);
  const cacheKey = `blockscout:${baseUrl}:${a}`;

  if (contractCache.has(cacheKey)) {
    return contractCache.get(cacheKey);
  }

  const url = `${baseUrl}/api/v2/addresses/${a}`;

  try {
    const { data } = await axios.get(url, {
      timeout: 30000,
    });

    const isContract = Boolean(data?.is_contract);

    contractCache.set(cacheKey, isContract);
    return isContract;
  } catch (err) {
    console.log(`    blockscout contract check failed for ${a}: ${err.message}`);
    contractCache.set(cacheKey, false);
    return false;
  }
}

async function isContractAddress({ token, address }) {
  if (token.chain === 'base') {
    return isContractAddressWithBlockscout({
      baseUrl: token.blockscoutBaseUrl,
      address,
    });
  }

  return isContractAddressWithEtherscan({
    chainId: token.etherscanChainId,
    address,
  });
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

function tokenFromDexScreenerItem(item, sourceLabel) {
  const chainId = item.chainId;
  const tokenAddress = item.tokenAddress;

  if (!chainId || !tokenAddress) return null;
  if (!isLikelyAddress(tokenAddress)) return null;

  const chain = CHAINS.find((c) => c.dexscreenerChainId === chainId);

  if (!chain) return null;

  return {
    chain: chain.name,
    dexscreenerChainId: chain.dexscreenerChainId,
    etherscanChainId: chain.etherscanChainId,
    explorer: chain.explorer,
    blockscoutBaseUrl: chain.blockscoutBaseUrl || null,
    tokenAddress: tokenAddress.toLowerCase(),
    sourceUrl: item.url || '',
    source: sourceLabel,
    description: item.description || '',
  };
}

function dedupeTokens(tokens) {
  const dedup = new Map();

  for (const token of tokens) {
    if (!token) continue;
    dedup.set(`${token.chain}:${token.tokenAddress}`, token);
  }

  return [...dedup.values()];
}

async function collectCandidateTokens() {
  console.log('Fetching DEX Screener token sources...');

  const [profiles, latestBoosts, topBoosts] = await Promise.all([
    getDexScreenerLatestProfiles(),
    getDexScreenerLatestBoosts(),
    getDexScreenerTopBoosts(),
  ]);

  const dexTokens = [
    ...profiles.map((item) => tokenFromDexScreenerItem(item, 'dex_profiles_latest')),
    ...latestBoosts.map((item) => tokenFromDexScreenerItem(item, 'dex_boosts_latest')),
    ...topBoosts.map((item) => tokenFromDexScreenerItem(item, 'dex_boosts_top')),
  ].filter(Boolean);

  const manualTokens = loadManualTokensCsv();
  const marketTokens = loadMarketTokensCsv();

  console.log(`  dex tokens: ${dexTokens.length}`);
  console.log(`  manual tokens: ${manualTokens.length}`);
  console.log(`  market tokens: ${marketTokens.length}`);

  return dedupeTokens([...dexTokens, ...manualTokens, ...marketTokens]);
}

async function etherscanTokenTransfers({ chainId, tokenAddress }) {
  const url = 'https://api.etherscan.io/v2/api';

  const params = {
    chainid: chainId,
    module: 'account',
    action: 'tokentx',
    contractaddress: tokenAddress,
    page: 1,
    offset: EARLY_TRANSFER_LIMIT,
    sort: 'asc',
    apikey: ETHERSCAN_API_KEY,
  };

  try {
    const { data } = await axios.get(url, {
      params,
      timeout: 30000,
    });

    if (data.status !== '1' || !Array.isArray(data.result)) {
      return {
        ok: false,
        source: 'etherscan',
        message: formatExplorerError(data),
        result: [],
      };
    }

    return {
      ok: true,
      source: 'etherscan',
      message: data.message,
      result: data.result.map((tx) => ({
        from: tx.from,
        to: tx.to,
        hash: tx.hash,
        blockNumber: Number(tx.blockNumber || 0),
        timeStamp: Number(tx.timeStamp || 0),
        value: tx.value || '0',
        tokenDecimal: tx.tokenDecimal || '18',
        tokenSymbol: tx.tokenSymbol || '',
        tokenName: tx.tokenName || '',
      })),
    };
  } catch (err) {
    return {
      ok: false,
      source: 'etherscan',
      message: `HTTP_ERROR | ${err.message}`,
      result: [],
    };
  }
}

async function blockscoutTokenTransfers({ baseUrl, tokenAddress }) {
  const url = `${baseUrl}/api/v2/tokens/${tokenAddress}/transfers`;

  try {
    const { data } = await axios.get(url, {
      timeout: 30000,
    });

    const items = Array.isArray(data?.items) ? data.items : [];

    if (!items.length) {
      return {
        ok: false,
        source: 'blockscout',
        message: `NO_ITEMS | ${JSON.stringify(data).slice(0, 300)}`,
        result: [],
      };
    }

    const normalized = items.slice(0, EARLY_TRANSFER_LIMIT).map((item) => {
      const token = item.token || {};
      const total = item.total || {};

      return {
        from: item.from?.hash || item.from_hash || '',
        to: item.to?.hash || item.to_hash || '',
        hash: item.transaction_hash || '',
        blockNumber: Number(item.block_number || 0),
        timeStamp: item.timestamp
          ? Math.floor(new Date(item.timestamp).getTime() / 1000)
          : 0,
        value: total.value || item.value || '0',
        tokenDecimal: total.decimals || token.decimals || '18',
        tokenSymbol: token.symbol || '',
        tokenName: token.name || '',
      };
    });

    return {
      ok: true,
      source: 'blockscout',
      message: `OK | items=${items.length}`,
      result: normalized,
    };
  } catch (err) {
    return {
      ok: false,
      source: 'blockscout',
      message: `HTTP_ERROR | ${err.message}`,
      result: [],
    };
  }
}

async function getTokenTransfersForToken(token) {
  const ethRes = await etherscanTokenTransfers({
    chainId: token.etherscanChainId,
    tokenAddress: token.tokenAddress,
  });

  if (ethRes.ok) {
    return ethRes;
  }

  if (
    token.chain === 'base' &&
    token.blockscoutBaseUrl &&
    isEtherscanFreeChainCoverageError(ethRes.message)
  ) {
    console.log(`  etherscan skipped: ${ethRes.message}`);
    console.log('  trying Base Blockscout fallback...');

    return blockscoutTokenTransfers({
      baseUrl: token.blockscoutBaseUrl,
      tokenAddress: token.tokenAddress,
    });
  }

  return ethRes;
}

async function scoreTransfers({ token, transfers }) {
  const buyers = new Map();

  let index = 0;
  let skippedContracts = 0;
  let skippedNoise = 0;
  let skippedMints = 0;
  let skippedBlacklist = 0;

  for (const tx of transfers) {
    index += 1;

    const from = norm(tx.from);
    const to = norm(tx.to);
    const hash = tx.hash;
    const blockNumber = Number(tx.blockNumber || 0);
    const timeStamp = Number(tx.timeStamp || 0);
    const valueRaw = tx.value || '0';
    const tokenDecimal = Number(tx.tokenDecimal || 18);
    const tokenSymbol = tx.tokenSymbol || '';
    const tokenName = tx.tokenName || '';

    if (runtimeBlacklist.has(to)) {
      skippedBlacklist += 1;
      continue;
    }

    if (isNoiseAddress(to)) {
      skippedNoise += 1;
      continue;
    }

    if (from === ZERO.toLowerCase()) {
      skippedMints += 1;
      continue;
    }

    const toIsContract = await isContractAddress({
      token,
      address: to,
    });

    if (toIsContract) {
      skippedContracts += 1;
      continue;
    }

    if (!buyers.has(to)) {
      buyers.set(to, {
        wallet: to,
        chain: token.chain,
        tokenAddress: token.tokenAddress,
        tokenSource: token.source,
        tokenSourceUrl: token.sourceUrl,
        tokenNote: token.description,
        firstSeenTransferIndex: index,
        firstSeenBlock: blockNumber,
        firstSeenTimestamp: timeStamp,
        tokenAmountRaw: valueRaw,
        tokenDecimal,
        tokenSymbol,
        tokenName,
        txHash: hash,
      });
    }
  }

  console.log(`  skipped noise: ${skippedNoise}`);
  console.log(`  skipped mints: ${skippedMints}`);
  console.log(`  skipped contracts: ${skippedContracts}`);
  console.log(`  skipped blacklist: ${skippedBlacklist}`);

  return [...buyers.values()];
}

function aggregateWallets(earlyRows) {
  const wallets = new Map();

  for (const row of earlyRows) {
    const wallet = row.wallet;

    if (!wallets.has(wallet)) {
      wallets.set(wallet, {
        wallet,
        chains: new Set(),
        uniqueTokens: new Set(),
        tokenSymbols: new Set(),
        earlyHits: 0,
        bestEarlyIndex: Number.MAX_SAFE_INTEGER,
        totalEarlyIndex: 0,
        firstSeenBlock: Number.MAX_SAFE_INTEGER,
        latestSeenTimestamp: 0,
        examples: [],
      });
    }

    const walletData = wallets.get(wallet);

    walletData.chains.add(row.chain);
    walletData.uniqueTokens.add(`${row.chain}:${row.tokenAddress}`);
    if (row.tokenSymbol) walletData.tokenSymbols.add(row.tokenSymbol);

    walletData.earlyHits += 1;
    walletData.bestEarlyIndex = Math.min(
      walletData.bestEarlyIndex,
      row.firstSeenTransferIndex
    );
    walletData.totalEarlyIndex += row.firstSeenTransferIndex;

    if (row.firstSeenBlock > 0) {
      walletData.firstSeenBlock = Math.min(walletData.firstSeenBlock, row.firstSeenBlock);
    }

    if (row.firstSeenTimestamp > 0) {
      walletData.latestSeenTimestamp = Math.max(
        walletData.latestSeenTimestamp,
        row.firstSeenTimestamp
      );
    }

    if (walletData.examples.length < 12) {
      walletData.examples.push({
        chain: row.chain,
        token: row.tokenAddress,
        symbol: row.tokenSymbol,
        index: row.firstSeenTransferIndex,
        tx: row.txHash,
        source: row.tokenSource,
      });
    }
  }

  const result = [];

  for (const [, walletData] of wallets.entries()) {
    const uniqueTokenCount = walletData.uniqueTokens.size;
    const avgEarlyIndex =
      walletData.totalEarlyIndex / Math.max(walletData.earlyHits, 1);

    const repeatScore = uniqueTokenCount * 100;
    const earlyScore = Math.max(0, 150 - avgEarlyIndex);
    const bestIndexBonus = Math.max(0, 125 - walletData.bestEarlyIndex);
    const chainScore = walletData.chains.size > 1 ? 50 : 0;

    const score = repeatScore + earlyScore + bestIndexBonus + chainScore;

    result.push({
      wallet: walletData.wallet,
      score: Number(score.toFixed(2)),
      uniqueTokenCount,
      earlyHits: walletData.earlyHits,
      chains: [...walletData.chains].join('|'),
      tokenSymbols: [...walletData.tokenSymbols].join('|'),
      bestEarlyIndex: walletData.bestEarlyIndex,
      avgEarlyIndex: Number(avgEarlyIndex.toFixed(2)),
      firstSeenBlock:
        walletData.firstSeenBlock === Number.MAX_SAFE_INTEGER
          ? ''
          : walletData.firstSeenBlock,
      latestSeenTimestamp: walletData.latestSeenTimestamp || '',
      examples: JSON.stringify(walletData.examples),
    });
  }

  result.sort((a, b) => b.score - a.score);
  return result;
}

function filterDiscoveryCandidates(walletRows) {
  return walletRows.filter((row) => {
    return (
      row.uniqueTokenCount >= 1 &&
      row.avgEarlyIndex <= DISCOVERY_MAX_AVG_EARLY_INDEX &&
      row.bestEarlyIndex <= DISCOVERY_MAX_BEST_EARLY_INDEX &&
      !runtimeBlacklist.has(norm(row.wallet))
    );
  });
}

function filterRepeatCandidates(walletRows) {
  return walletRows.filter((row) => {
    return (
      row.uniqueTokenCount >= REPEAT_MIN_TOKENS &&
      row.avgEarlyIndex <= REPEAT_MAX_AVG_EARLY_INDEX &&
      row.bestEarlyIndex <= REPEAT_MAX_BEST_EARLY_INDEX &&
      !runtimeBlacklist.has(norm(row.wallet))
    );
  });
}

function filterWatchlistCandidates(walletRows) {
  return walletRows.filter((row) => {
    return (
      row.uniqueTokenCount >= WATCHLIST_MIN_TOKENS &&
      row.avgEarlyIndex <= WATCHLIST_MAX_AVG_EARLY_INDEX &&
      row.bestEarlyIndex <= WATCHLIST_MAX_BEST_EARLY_INDEX &&
      !runtimeBlacklist.has(norm(row.wallet))
    );
  });
}

async function writeCsv(filename, rows) {
  if (!rows.length) {
    fs.writeFileSync(path.resolve(filename), '');
    console.log(`No rows for ${filename}`);
    return;
  }

  const headers = Object.keys(rows[0]).map((key) => ({
    id: key,
    title: key,
  }));

  const writer = createObjectCsvWriter({
    path: filename,
    header: headers,
  });

  await writer.writeRecords(rows);
}

async function main() {
  console.log('Smart Wallet Indexer v1.2.1');
  console.log('');
  console.log(`EARLY_TRANSFER_LIMIT=${EARLY_TRANSFER_LIMIT}`);
  console.log(`DISCOVERY_MAX_AVG_EARLY_INDEX=${DISCOVERY_MAX_AVG_EARLY_INDEX}`);
  console.log(`DISCOVERY_MAX_BEST_EARLY_INDEX=${DISCOVERY_MAX_BEST_EARLY_INDEX}`);
  console.log(`REPEAT_MIN_TOKENS=${REPEAT_MIN_TOKENS}`);
  console.log(`REPEAT_MAX_AVG_EARLY_INDEX=${REPEAT_MAX_AVG_EARLY_INDEX}`);
  console.log(`REPEAT_MAX_BEST_EARLY_INDEX=${REPEAT_MAX_BEST_EARLY_INDEX}`);
  console.log(`WATCHLIST_MIN_TOKENS=${WATCHLIST_MIN_TOKENS}`);
  console.log(`WATCHLIST_MAX_AVG_EARLY_INDEX=${WATCHLIST_MAX_AVG_EARLY_INDEX}`);
  console.log(`WATCHLIST_MAX_BEST_EARLY_INDEX=${WATCHLIST_MAX_BEST_EARLY_INDEX}`);

  const blacklistRowsLoaded = loadBlacklistCsv();

  console.log(`blacklist.csv loaded rows: ${blacklistRowsLoaded}`);
  console.log(`runtime blacklist size: ${runtimeBlacklist.size}`);
  console.log(`manual-tokens.csv exists: ${fileExists('manual-tokens.csv')}`);
  console.log(`market-tokens.csv exists: ${fileExists('market-tokens.csv')}`);

  const tokens = await collectCandidateTokens();

  console.log(`Candidate tokens after dedupe: ${tokens.length}`);

  const earlyRows = [];

  for (const token of tokens) {
    console.log('');
    console.log(`Scanning ${token.chain} ${token.tokenAddress}`);
    console.log(`  source: ${token.source}`);
    console.log(`  explorer mode: ${token.explorer}`);

    try {
      const res = await getTokenTransfersForToken(token);

      if (!res.ok) {
        console.log(`  skipped: source=${res.source} | ${res.message}`);
        await sleep(750);
        continue;
      }

      console.log(`  explorer source: ${res.source}`);
      console.log(`  explorer result: ${res.message}`);
      console.log(`  raw transfers: ${res.result.length}`);

      const buyers = await scoreTransfers({
        token,
        transfers: res.result,
      });

      console.log(`  early candidate receivers: ${buyers.length}`);

      earlyRows.push(...buyers);

      await sleep(750);
    } catch (err) {
      console.log(`  error: ${err.message}`);
      await sleep(1000);
    }
  }

  const allWalletRows = aggregateWallets(earlyRows);

  const discoveryRows = filterDiscoveryCandidates(allWalletRows);
  const repeatRows = filterRepeatCandidates(allWalletRows);
  const watchlistRows = filterWatchlistCandidates(allWalletRows);

  await writeCsv('early-token-receivers.csv', earlyRows);
  await writeCsv('all-wallet-candidates.csv', allWalletRows);
  await writeCsv('discovery-candidates.csv', discoveryRows);
  await writeCsv('repeat-candidates.csv', repeatRows);
  await writeCsv('watchlist.csv', watchlistRows);

  console.log('');
  console.log('Done.');
  console.log(`Early rows: ${earlyRows.length}`);
  console.log(`All wallet candidates: ${allWalletRows.length}`);
  console.log(`Discovery candidates: ${discoveryRows.length}`);
  console.log(`Repeat candidates: ${repeatRows.length}`);
  console.log(`Watchlist candidates: ${watchlistRows.length}`);
  console.log('');
  console.log('Outputs:');
  console.log('  early-token-receivers.csv');
  console.log('  all-wallet-candidates.csv');
  console.log('  discovery-candidates.csv');
  console.log('  repeat-candidates.csv');
  console.log('  watchlist.csv');

  if (watchlistRows.length > 0) {
    console.log('');
    console.log('Top watchlist candidates:');

    for (const wallet of watchlistRows.slice(0, 10)) {
      console.log(
        `  ${wallet.wallet} | score=${wallet.score} | tokens=${wallet.uniqueTokenCount} | chains=${wallet.chains} | bestIndex=${wallet.bestEarlyIndex} | avgIndex=${wallet.avgEarlyIndex} | symbols=${wallet.tokenSymbols}`
      );
    }
  } else if (repeatRows.length > 0) {
    console.log('');
    console.log('No watchlist candidates, but repeat candidates exist:');

    for (const wallet of repeatRows.slice(0, 10)) {
      console.log(
        `  ${wallet.wallet} | score=${wallet.score} | tokens=${wallet.uniqueTokenCount} | chains=${wallet.chains} | bestIndex=${wallet.bestEarlyIndex} | avgIndex=${wallet.avgEarlyIndex} | symbols=${wallet.tokenSymbols}`
      );
    }
  } else {
    console.log('');
    console.log('No repeat candidates found yet.');
    console.log('Increase market-tokens.csv / manual-tokens.csv universe.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});