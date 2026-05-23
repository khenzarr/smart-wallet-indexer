import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { createObjectCsvWriter } from 'csv-writer';

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

const EARLY_TRANSFER_LIMIT = Number(process.env.ACTOR_EARLY_TRANSFER_LIMIT || process.env.EARLY_TRANSFER_LIMIT || 250);
const CONTRACT_CHECK_DELAY_MS = Number(process.env.ACTOR_CONTRACT_CHECK_DELAY_MS || 60);

const MIN_REPEAT_TOKENS = Number(process.env.ACTOR_MIN_REPEAT_TOKENS || 2);
const MAX_AVG_EARLY_INDEX = Number(process.env.ACTOR_MAX_AVG_EARLY_INDEX || 200);
const MAX_BEST_EARLY_INDEX = Number(process.env.ACTOR_MAX_BEST_EARLY_INDEX || 175);

if (!ETHERSCAN_API_KEY) {
  throw new Error('Missing ETHERSCAN_API_KEY in .env');
}

const CHAINS = [
  {
    name: 'ethereum',
    dexscreenerChainId: 'ethereum',
    etherscanChainId: '1',
    blockscoutBaseUrl: null,
  },
  {
    name: 'base',
    dexscreenerChainId: 'base',
    etherscanChainId: '8453',
    blockscoutBaseUrl: 'https://base.blockscout.com',
  },
];

const ZERO = '0x0000000000000000000000000000000000000000';

const KNOWN_NOISE_ADDRESSES = new Set([
  ZERO,
  '0x000000000000000000000000000000000000dead',
]);

const DEFAULT_BLACKLIST = new Set([
  '0x7f54f05635d15cde17a49502fedb9d1803a3be8a',
]);

const INFRA_NAME_PATTERNS = [
  'router',
  'pair',
  'pool',
  'factory',
  'vault',
  'staking',
  'farm',
  'proxyadmin',
  'multicall',
  'positionmanager',
  'position manager',
  'uniswap',
  'sushiswap',
  'curve',
  'balancer',
  'aerodrome',
  'pancake',
  'swaprouter',
  'quoter',
  'lp',
];

const runtimeBlacklist = new Set([...DEFAULT_BLACKLIST]);
const actorCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

function isLikelyAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(address || '').trim());
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

function parseCsv(filePath) {
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
  const rows = parseCsv('blacklist.csv');

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

  const chain = CHAINS.find((item) => item.name === chainName);

  if (!chain) return null;
  if (!isLikelyAddress(tokenAddress)) return null;
  if (tokenAddress === ZERO) return null;

  return {
    chain: chain.name,
    dexscreenerChainId: chain.dexscreenerChainId,
    etherscanChainId: chain.etherscanChainId,
    blockscoutBaseUrl: chain.blockscoutBaseUrl,
    tokenAddress,
    source: sourceName,
    sourceUrl: row.dexUrl || '',
    description: row.note || row.symbol || row.name || '',
  };
}

function loadManualTokensCsv() {
  return parseCsv('manual-tokens.csv')
    .map((row) => tokenFromCsvRow(row, 'manual'))
    .filter(Boolean);
}

function loadMarketTokensCsv() {
  return parseCsv('market-tokens.csv')
    .map((row) => tokenFromCsvRow(row, 'market'))
    .filter(Boolean);
}

function tokenFromDexScreenerItem(item, sourceName) {
  const chainId = String(item.chainId || '').trim();
  const tokenAddress = norm(item.tokenAddress);

  if (!chainId || !isLikelyAddress(tokenAddress)) return null;
  if (tokenAddress === ZERO) return null;

  const chain = CHAINS.find((itemChain) => itemChain.dexscreenerChainId === chainId);

  if (!chain) return null;

  return {
    chain: chain.name,
    dexscreenerChainId: chain.dexscreenerChainId,
    etherscanChainId: chain.etherscanChainId,
    blockscoutBaseUrl: chain.blockscoutBaseUrl,
    tokenAddress,
    source: sourceName,
    sourceUrl: item.url || '',
    description: item.description || '',
  };
}

function dedupeTokens(tokens) {
  const map = new Map();

  for (const token of tokens) {
    if (!token) continue;
    map.set(`${token.chain}:${token.tokenAddress}`, token);
  }

  return [...map.values()];
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

  return dedupeTokens([
    ...dexTokens,
    ...manualTokens,
    ...marketTokens,
  ]);
}

function isEtherscanFreeChainCoverageError(message) {
  return String(message || '')
    .toLowerCase()
    .includes('free api access is not supported for this chain');
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
    const { data } = await axios.get(url, { params, timeout: 30000 });

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
        from: norm(tx.from),
        to: norm(tx.to),
        hash: tx.hash || '',
        blockNumber: Number(tx.blockNumber || 0),
        timeStamp: Number(tx.timeStamp || 0),
        value: tx.value || '0',
        tokenDecimal: Number(tx.tokenDecimal || 18),
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
    const { data } = await axios.get(url, { timeout: 30000 });
    const items = Array.isArray(data?.items) ? data.items : [];

    if (!items.length) {
      return {
        ok: false,
        source: 'blockscout',
        message: `NO_ITEMS | ${JSON.stringify(data).slice(0, 300)}`,
        result: [],
      };
    }

    return {
      ok: true,
      source: 'blockscout',
      message: `OK | items=${items.length}`,
      result: items.slice(0, EARLY_TRANSFER_LIMIT).map((item) => {
        const token = item.token || {};
        const total = item.total || {};

        return {
          from: norm(item.from?.hash || item.from_hash || ''),
          to: norm(item.to?.hash || item.to_hash || ''),
          hash: item.transaction_hash || '',
          blockNumber: Number(item.block_number || 0),
          timeStamp: item.timestamp ? Math.floor(new Date(item.timestamp).getTime() / 1000) : 0,
          value: total.value || item.value || '0',
          tokenDecimal: Number(total.decimals || token.decimals || 18),
          tokenSymbol: token.symbol || '',
          tokenName: token.name || '',
        };
      }),
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
  const etherscanRes = await etherscanTokenTransfers({
    chainId: token.etherscanChainId,
    tokenAddress: token.tokenAddress,
  });

  if (etherscanRes.ok) {
    return etherscanRes;
  }

  if (
    token.chain === 'base' &&
    token.blockscoutBaseUrl &&
    isEtherscanFreeChainCoverageError(etherscanRes.message)
  ) {
    console.log(`  etherscan skipped: ${etherscanRes.message}`);
    console.log('  trying Base Blockscout fallback...');

    return blockscoutTokenTransfers({
      baseUrl: token.blockscoutBaseUrl,
      tokenAddress: token.tokenAddress,
    });
  }

  return etherscanRes;
}

function looksLikeInfraContractName(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;

  return INFRA_NAME_PATTERNS.some((pattern) => n.includes(pattern));
}

async function getEthereumActorInfo(address, chainId) {
  const a = norm(address);
  const cacheKey = `etherscan:${chainId}:${a}`;

  if (actorCache.has(cacheKey)) {
    return actorCache.get(cacheKey);
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
    const { data } = await axios.get(url, { params, timeout: 30000 });
    const result = Array.isArray(data.result) ? data.result[0] : null;

    const contractName = result?.ContractName || '';
    const sourceCode = result?.SourceCode || '';
    const abi = result?.ABI || '';
    const proxy = result?.Proxy || '';
    const implementation = result?.Implementation || '';

    const isContract = Boolean(
      contractName ||
      sourceCode ||
      (abi && abi !== 'Contract source code not verified') ||
      proxy === '1' ||
      implementation
    );

    let actorType = isContract ? 'CONTRACT' : 'EOA_OR_UNVERIFIED';
    let actorSubtype = '';

    if (isContract && looksLikeInfraContractName(contractName)) {
      actorType = 'INFRA_CONTRACT';
      actorSubtype = 'name-pattern';
    } else if (isContract && proxy === '1') {
      actorSubtype = 'proxy-contract';
    } else if (isContract && !contractName) {
      actorSubtype = 'unverified-contract';
    } else if (isContract) {
      actorSubtype = 'verified-contract';
    }

    const info = {
      actorType,
      actorSubtype,
      isContract,
      contractName,
      proxy,
      implementation,
    };

    actorCache.set(cacheKey, info);
    await sleep(CONTRACT_CHECK_DELAY_MS);
    return info;
  } catch (err) {
    const info = {
      actorType: 'UNKNOWN',
      actorSubtype: `etherscan-error:${err.message}`,
      isContract: false,
      contractName: '',
      proxy: '',
      implementation: '',
    };

    actorCache.set(cacheKey, info);
    return info;
  }
}

async function getBaseActorInfo(address, baseUrl) {
  const a = norm(address);
  const cacheKey = `blockscout:${baseUrl}:${a}`;

  if (actorCache.has(cacheKey)) {
    return actorCache.get(cacheKey);
  }

  const url = `${baseUrl}/api/v2/addresses/${a}`;

  try {
    const { data } = await axios.get(url, { timeout: 30000 });

    const isContract = Boolean(data?.is_contract);
    const contractName =
      data?.name ||
      data?.contract_name ||
      data?.smart_contract?.name ||
      '';

    let actorType = isContract ? 'CONTRACT' : 'EOA';
    let actorSubtype = '';

    if (isContract && looksLikeInfraContractName(contractName)) {
      actorType = 'INFRA_CONTRACT';
      actorSubtype = 'name-pattern';
    } else if (isContract && !contractName) {
      actorSubtype = 'unverified-contract';
    } else if (isContract) {
      actorSubtype = 'verified-contract';
    }

    const info = {
      actorType,
      actorSubtype,
      isContract,
      contractName,
      proxy: '',
      implementation: '',
    };

    actorCache.set(cacheKey, info);
    await sleep(CONTRACT_CHECK_DELAY_MS);
    return info;
  } catch (err) {
    const info = {
      actorType: 'UNKNOWN',
      actorSubtype: `blockscout-error:${err.message}`,
      isContract: false,
      contractName: '',
      proxy: '',
      implementation: '',
    };

    actorCache.set(cacheKey, info);
    return info;
  }
}

async function getActorInfo(token, address) {
  if (token.chain === 'base' && token.blockscoutBaseUrl) {
    return getBaseActorInfo(address, token.blockscoutBaseUrl);
  }

  return getEthereumActorInfo(address, token.etherscanChainId);
}

function isNoiseAddress(address) {
  const a = norm(address);

  if (!isLikelyAddress(a)) return true;
  if (KNOWN_NOISE_ADDRESSES.has(a)) return true;
  if (runtimeBlacklist.has(a)) return true;

  return false;
}

async function classifyTransfers({ token, transfers }) {
  const actors = [];
  const seenActorForToken = new Set();

  let transferIndex = 0;
  let skippedNoise = 0;
  let skippedMints = 0;
  let skippedBlacklist = 0;
  let eoaCount = 0;
  let contractCount = 0;
  let infraCount = 0;
  let unknownCount = 0;

  for (const tx of transfers) {
    transferIndex += 1;

    const from = norm(tx.from);
    const to = norm(tx.to);

    if (runtimeBlacklist.has(to)) {
      skippedBlacklist += 1;
      continue;
    }

    if (isNoiseAddress(to)) {
      skippedNoise += 1;
      continue;
    }

    if (from === ZERO) {
      skippedMints += 1;
      continue;
    }

    const actorKey = `${token.chain}:${token.tokenAddress}:${to}`;

    if (seenActorForToken.has(actorKey)) {
      continue;
    }

    seenActorForToken.add(actorKey);

    const actorInfo = await getActorInfo(token, to);

    if (actorInfo.actorType === 'EOA' || actorInfo.actorType === 'EOA_OR_UNVERIFIED') {
      eoaCount += 1;
    } else if (actorInfo.actorType === 'CONTRACT') {
      contractCount += 1;
    } else if (actorInfo.actorType === 'INFRA_CONTRACT') {
      infraCount += 1;
    } else {
      unknownCount += 1;
    }

    actors.push({
      actor: to,
      actorType: actorInfo.actorType,
      actorSubtype: actorInfo.actorSubtype,
      isContract: actorInfo.isContract ? 'yes' : 'no',
      contractName: actorInfo.contractName,
      proxy: actorInfo.proxy,
      implementation: actorInfo.implementation,

      chain: token.chain,
      tokenAddress: token.tokenAddress,
      tokenSource: token.source,
      tokenSourceUrl: token.sourceUrl,
      tokenNote: token.description,

      firstSeenTransferIndex: transferIndex,
      firstSeenBlock: tx.blockNumber,
      firstSeenTimestamp: tx.timeStamp,
      tokenAmountRaw: tx.value,
      tokenDecimal: tx.tokenDecimal,
      tokenSymbol: tx.tokenSymbol,
      tokenName: tx.tokenName,
      txHash: tx.hash,
      from,
      to,
    });
  }

  console.log(`  skipped noise: ${skippedNoise}`);
  console.log(`  skipped mints: ${skippedMints}`);
  console.log(`  skipped blacklist: ${skippedBlacklist}`);
  console.log(`  eoa actors: ${eoaCount}`);
  console.log(`  contract actors: ${contractCount}`);
  console.log(`  infra actors: ${infraCount}`);
  console.log(`  unknown actors: ${unknownCount}`);

  return actors;
}

function aggregateActors(rows) {
  const actorMap = new Map();

  for (const row of rows) {
    const actor = norm(row.actor);

    if (!actor) continue;

    if (!actorMap.has(actor)) {
      actorMap.set(actor, {
        actor,
        actorTypes: new Set(),
        actorSubtypes: new Set(),
        contractNames: new Set(),
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

    const data = actorMap.get(actor);

    data.actorTypes.add(row.actorType);
    if (row.actorSubtype) data.actorSubtypes.add(row.actorSubtype);
    if (row.contractName) data.contractNames.add(row.contractName);
    if (row.chain) data.chains.add(row.chain);
    if (row.tokenAddress) data.uniqueTokens.add(`${row.chain}:${row.tokenAddress}`);
    if (row.tokenSymbol) data.tokenSymbols.add(row.tokenSymbol);

    data.earlyHits += 1;
    data.bestEarlyIndex = Math.min(data.bestEarlyIndex, Number(row.firstSeenTransferIndex || 999999));
    data.totalEarlyIndex += Number(row.firstSeenTransferIndex || 999999);

    if (Number(row.firstSeenBlock || 0) > 0) {
      data.firstSeenBlock = Math.min(data.firstSeenBlock, Number(row.firstSeenBlock));
    }

    if (Number(row.firstSeenTimestamp || 0) > 0) {
      data.latestSeenTimestamp = Math.max(data.latestSeenTimestamp, Number(row.firstSeenTimestamp));
    }

    if (data.examples.length < 16) {
      data.examples.push({
        chain: row.chain,
        token: row.tokenAddress,
        symbol: row.tokenSymbol,
        actorType: row.actorType,
        contractName: row.contractName,
        index: row.firstSeenTransferIndex,
        tx: row.txHash,
        source: row.tokenSource,
      });
    }
  }

  const output = [];

  for (const [, data] of actorMap.entries()) {
    const uniqueTokenCount = data.uniqueTokens.size;
    const avgEarlyIndex = data.totalEarlyIndex / Math.max(data.earlyHits, 1);
    const chainCount = data.chains.size;

    const hasContractType = [...data.actorTypes].some((type) =>
      ['CONTRACT', 'INFRA_CONTRACT', 'UNKNOWN'].includes(type)
    );

    const repeatScore = uniqueTokenCount * 130;
    const earlyScore = Math.max(0, 220 - avgEarlyIndex);
    const bestIndexScore = Math.max(0, 180 - data.bestEarlyIndex);
    const chainScore = chainCount > 1 ? 80 : 0;
    const contractActorBonus = hasContractType ? 50 : 0;

    const infraPenalty = data.actorTypes.has('INFRA_CONTRACT') ? 400 : 0;

    const score =
      repeatScore +
      earlyScore +
      bestIndexScore +
      chainScore +
      contractActorBonus -
      infraPenalty;

    output.push({
      actor: data.actor,
      actorTypes: [...data.actorTypes].join('|'),
      actorSubtypes: [...data.actorSubtypes].join('|'),
      contractNames: [...data.contractNames].join('|'),
      score: Number(score.toFixed(2)),
      uniqueTokenCount,
      earlyHits: data.earlyHits,
      chains: [...data.chains].join('|'),
      chainCount,
      tokenSymbols: [...data.tokenSymbols].join('|'),
      bestEarlyIndex: data.bestEarlyIndex,
      avgEarlyIndex: Number(avgEarlyIndex.toFixed(2)),
      firstSeenBlock: data.firstSeenBlock === Number.MAX_SAFE_INTEGER ? '' : data.firstSeenBlock,
      latestSeenTimestamp: data.latestSeenTimestamp || '',
      examples: JSON.stringify(data.examples),
    });
  }

  return output.sort((a, b) => b.score - a.score);
}

function filterSmartActorCandidates(actorRows) {
  return actorRows.filter((row) => {
    const isInfra = String(row.actorTypes || '').includes('INFRA_CONTRACT');

    return (
      !isInfra &&
      row.uniqueTokenCount >= MIN_REPEAT_TOKENS &&
      row.avgEarlyIndex <= MAX_AVG_EARLY_INDEX &&
      row.bestEarlyIndex <= MAX_BEST_EARLY_INDEX
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
  console.log(`Wrote ${rows.length} rows to ${filename}`);
}

async function main() {
  console.log('Smart Actor Indexer v1.4');
  console.log('');
  console.log(`EARLY_TRANSFER_LIMIT=${EARLY_TRANSFER_LIMIT}`);
  console.log(`MIN_REPEAT_TOKENS=${MIN_REPEAT_TOKENS}`);
  console.log(`MAX_AVG_EARLY_INDEX=${MAX_AVG_EARLY_INDEX}`);
  console.log(`MAX_BEST_EARLY_INDEX=${MAX_BEST_EARLY_INDEX}`);
  console.log('');

  const blacklistRowsLoaded = loadBlacklistCsv();

  console.log(`blacklist.csv loaded rows: ${blacklistRowsLoaded}`);
  console.log(`runtime blacklist size: ${runtimeBlacklist.size}`);
  console.log(`manual-tokens.csv exists: ${fileExists('manual-tokens.csv')}`);
  console.log(`market-tokens.csv exists: ${fileExists('market-tokens.csv')}`);

  const tokens = await collectCandidateTokens();

  console.log(`Candidate tokens after dedupe: ${tokens.length}`);

  const allEarlyActors = [];

  for (const token of tokens) {
    console.log('');
    console.log(`Scanning ${token.chain} ${token.tokenAddress}`);
    console.log(`  source: ${token.source}`);

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

      const tokenActors = await classifyTransfers({
        token,
        transfers: res.result,
      });

      console.log(`  early actors captured: ${tokenActors.length}`);

      allEarlyActors.push(...tokenActors);

      await sleep(750);
    } catch (err) {
      console.log(`  error: ${err.message}`);
      await sleep(1000);
    }
  }

  const eoaActors = allEarlyActors.filter((row) =>
    ['EOA', 'EOA_OR_UNVERIFIED'].includes(row.actorType)
  );

  const contractActors = allEarlyActors.filter((row) => row.actorType === 'CONTRACT');
  const infraActors = allEarlyActors.filter((row) => row.actorType === 'INFRA_CONTRACT');
  const unknownActors = allEarlyActors.filter((row) => row.actorType === 'UNKNOWN');

  const actorScores = aggregateActors(allEarlyActors);
  const smartActorCandidates = filterSmartActorCandidates(actorScores);

  await writeCsv('all-early-actors.csv', allEarlyActors);
  await writeCsv('eoa-early-actors.csv', eoaActors);
  await writeCsv('contract-early-actors.csv', contractActors);
  await writeCsv('infra-early-actors.csv', infraActors);
  await writeCsv('unknown-early-actors.csv', unknownActors);
  await writeCsv('smart-actor-score.csv', actorScores);
  await writeCsv('smart-actor-candidates.csv', smartActorCandidates);

  console.log('');
  console.log('Done.');
  console.log(`All early actors rows: ${allEarlyActors.length}`);
  console.log(`EOA actor rows: ${eoaActors.length}`);
  console.log(`Contract actor rows: ${contractActors.length}`);
  console.log(`Infra actor rows: ${infraActors.length}`);
  console.log(`Unknown actor rows: ${unknownActors.length}`);
  console.log(`Scored actors: ${actorScores.length}`);
  console.log(`Smart actor candidates: ${smartActorCandidates.length}`);

  if (smartActorCandidates.length > 0) {
    console.log('');
    console.log('Top smart actor candidates:');

    for (const row of smartActorCandidates.slice(0, 20)) {
      console.log(
        `  ${row.actor} | types=${row.actorTypes} | score=${row.score} | tokens=${row.uniqueTokenCount} | best=${row.bestEarlyIndex} | avg=${row.avgEarlyIndex} | symbols=${row.tokenSymbols} | names=${row.contractNames}`
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});