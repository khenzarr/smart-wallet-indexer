import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const ETHERSCAN_CHAIN_ID = '1';

const PRIMARY_FILE = 'tier1-smart-whales.csv';
const SECONDARY_FILE = 'tier2-watch-wallets.csv';
const TERTIARY_FILE = 'smart-whales.csv';
const FALLBACK_FILE = 'watchlist.csv';

const SEEN_FILE = 'seen-smart-whale-transfers.json';
const SIGNALS_FILE = 'smart-whale-signals.csv';

const MAX_RESULTS_PER_WALLET = Number(
  process.env.SMART_WHALE_MONITOR_MAX_RESULTS_PER_WALLET || 10
);

const IGNORE_KNOWN_QUOTES =
  String(process.env.SMART_WHALE_MONITOR_IGNORE_QUOTES || 'true').toLowerCase() !== 'false';

const IGNORE_UNKNOWN_TOKENS =
  String(process.env.SMART_WHALE_MONITOR_IGNORE_UNKNOWN || 'true').toLowerCase() !== 'false';

const IGNORE_SPAM_TOKENS =
  String(process.env.SMART_WHALE_MONITOR_IGNORE_SPAM || 'true').toLowerCase() !== 'false';

const VERBOSE_IGNORES =
  String(process.env.SMART_WHALE_MONITOR_VERBOSE_IGNORES || 'false').toLowerCase() === 'true';

const IGNORE_ESTABLISHED =
  String(process.env.SMART_WHALE_IGNORE_ESTABLISHED || 'true').toLowerCase() !== 'false';

const DEGEN_ONLY =
  String(process.env.SMART_WHALE_DEGEN_ONLY || 'true').toLowerCase() !== 'false';

const ENRICH_DEX =
  String(process.env.SMART_WHALE_SIGNAL_ENRICH_DEX || 'true').toLowerCase() !== 'false';

const MIN_SIGNAL_LIQUIDITY = Number(process.env.SMART_WHALE_MIN_SIGNAL_LIQUIDITY || 5000);
const MAX_SIGNAL_LIQUIDITY = Number(process.env.SMART_WHALE_MAX_SIGNAL_LIQUIDITY || 2000000);
const MIN_SIGNAL_VOLUME_24H = Number(process.env.SMART_WHALE_MIN_SIGNAL_VOLUME_24H || 5000);
const MAX_SIGNAL_FDV = Number(process.env.SMART_WHALE_MAX_SIGNAL_FDV || 50000000);
const MAX_DISTINCT_TOKENS_PER_RUN = Number(process.env.SMART_WHALE_MAX_DISTINCT_TOKENS_PER_RUN || 4);

if (!ETHERSCAN_API_KEY) {
  throw new Error('Missing ETHERSCAN_API_KEY in .env');
}

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

const ESTABLISHED_TOKEN_ADDRESSES = new Set([
  // Ethereum established / non-fresh signal tokens
  '0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c', // SPX
  '0x467bccd9d29f223bce8043b84e8c8b282827790f', // TEL
  '0xf629cbd94d3791c9250152bd8dfbdf380e2a3b9c', // ENJ
  '0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b', // CVX
  '0xacd2c239012d17beb128b0944d49015104113650', // KARRAT
]);

const ESTABLISHED_SYMBOLS = new Set([
  'SPX',
  'TEL',
  'ENJ',
  'CVX',
  'KARRAT',
  'NEAR',
  'AAVE',
  'UNI',
  'LINK',
  'MKR',
  'LDO',
  'PEPE',
  'SHIB',
  'SHIBA',
  'FLOKI',
  'MOG',
  'ONDO',
  'ENA',
  'ARB',
  'OP',
  'ENS',
  'CRV',
  'COMP',
  'SNX',
  'BAL',
  'YFI',
  'APE',
  'SAND',
  'MANA',
  'GALA',
  'FET',
  'RNDR',
  'IMX',
  'BLUR',
  'PENDLE',
  'LQTY',
  'FXS',
  'CVX',
  'DYDX',
  '1INCH',
  'SUSHI',
  'CAKE',
  'RPL',
  'LRC',
  'ZRX',
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
  'reward',
  'voucher',
  'bonus',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

function isLikelyAddress(addr) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(addr || '').trim());
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
    return [];
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

function normalizeWalletRow(row, sourceFile) {
  return {
    sourceFile,
    wallet: norm(row.wallet),

    auditTier: row.auditTier || '',
    auditScore: row.auditScore || '',
    auditReason: row.auditReason || '',
    clusterRisk: row.clusterRisk || '',
    clusterReason: row.clusterReason || '',

    score: row.auditScore || row.finalScore || row.score || '',
    class: row.auditTier || row.finalClass || row.classification || 'UNKNOWN',

    tokenSymbols: row.tokenSymbols || '',
    chains: row.chains || '',
    highQualityTokenCount: row.highQualityTokenCount || '',
    lowQualityTokenCount: row.lowQualityTokenCount || '',
    avgEarlyIndex: row.avgEarlyIndex || '',
    bestEarlyIndex: row.bestEarlyIndex || '',
    avgLiquidityUsd: row.avgLiquidityUsd || '',
    avgVolume24h: row.avgVolume24h || '',
    uniqueTokenCount: row.uniqueTokenCount || '',
    topSymbol: row.topSymbol || '',
    topSymbolDominance: row.topSymbolDominance || '',
  };
}

function loadWalletsFromFile(filePath) {
  const rows = parseCsv(filePath);

  const wallets = rows
    .map((row) => normalizeWalletRow(row, filePath))
    .filter((row) => isLikelyAddress(row.wallet))
    .filter((row) => row.clusterRisk !== 'yes')
    .filter((row) => row.auditTier !== 'CLUSTER_RISK');

  const dedup = new Map();

  for (const row of wallets) {
    dedup.set(row.wallet, row);
  }

  return [...dedup.values()];
}

function loadSmartWhales() {
  const sources = [
    PRIMARY_FILE,
    SECONDARY_FILE,
    TERTIARY_FILE,
    FALLBACK_FILE,
  ];

  for (const source of sources) {
    const wallets = loadWalletsFromFile(source);

    if (wallets.length > 0) {
      return {
        sourceFile: source,
        wallets,
      };
    }
  }

  return {
    sourceFile: '',
    wallets: [],
  };
}

function loadSeen() {
  const abs = path.resolve(SEEN_FILE);

  if (!fs.existsSync(abs)) {
    return new Set();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveSeen(seen) {
  fs.writeFileSync(
    path.resolve(SEEN_FILE),
    JSON.stringify([...seen].sort(), null, 2)
  );
}

function explorerTxUrl(chain, txHash) {
  if (chain === 'ethereum') {
    return `https://etherscan.io/tx/${txHash}`;
  }

  if (chain === 'base') {
    return `https://base.blockscout.com/tx/${txHash}`;
  }

  return txHash;
}

function explorerAddressUrl(chain, address) {
  if (chain === 'ethereum') {
    return `https://etherscan.io/address/${address}`;
  }

  if (chain === 'base') {
    return `https://base.blockscout.com/address/${address}`;
  }

  return address;
}

function ensureSignalsCsv() {
  const abs = path.resolve(SIGNALS_FILE);

  if (fs.existsSync(abs)) {
    return;
  }

  const header = [
    'detectedAt',
    'chain',
    'wallet',
    'sourceFile',
    'walletClass',
    'walletScore',
    'auditTier',
    'auditScore',
    'auditReason',
    'knownTags',
    'uniqueTokenCount',
    'highQualityTokenCount',
    'lowQualityTokenCount',
    'avgEarlyIndex',
    'bestEarlyIndex',
    'avgLiquidityUsd',
    'avgVolume24h',
    'topSymbol',
    'topSymbolDominance',
    'tokenSymbol',
    'tokenName',
    'tokenAddress',
    'txHash',
    'blockNumber',
    'transferTime',
    'signalQuality',
    'dexPairFound',
    'dexLiquidityUsd',
    'dexVolume24h',
    'dexFdv',
    'dexPriceChange24h',
    'dexUrl',
    'txUrl',
    'walletUrl',
  ].join(',');

  fs.writeFileSync(abs, header + '\n');
}

function appendSignalCsv({ transfer, walletMeta, dexInfo, signalQuality }) {
  ensureSignalsCsv();

  const detectedAt = new Date().toISOString();
  const transferTime = transfer.timeStamp
    ? new Date(transfer.timeStamp * 1000).toISOString()
    : '';

  const row = [
    detectedAt,
    transfer.chain,
    transfer.wallet,
    walletMeta.sourceFile,
    walletMeta.class,
    walletMeta.score,
    walletMeta.auditTier,
    walletMeta.auditScore,
    walletMeta.auditReason,
    walletMeta.tokenSymbols,
    walletMeta.uniqueTokenCount,
    walletMeta.highQualityTokenCount,
    walletMeta.lowQualityTokenCount,
    walletMeta.avgEarlyIndex,
    walletMeta.bestEarlyIndex,
    walletMeta.avgLiquidityUsd,
    walletMeta.avgVolume24h,
    walletMeta.topSymbol,
    walletMeta.topSymbolDominance,
    transfer.tokenSymbol || '',
    transfer.tokenName || '',
    transfer.tokenAddress,
    transfer.txHash,
    transfer.blockNumber,
    transferTime,
    signalQuality,
    dexInfo?.pairFound ? 'yes' : 'no',
    dexInfo?.liquidityUsd ?? '',
    dexInfo?.volume24h ?? '',
    dexInfo?.fdv ?? '',
    dexInfo?.priceChange24h ?? '',
    dexInfo?.url ?? '',
    explorerTxUrl(transfer.chain, transfer.txHash),
    explorerAddressUrl(transfer.chain, transfer.wallet),
  ].map(csvEscape).join(',');

  fs.appendFileSync(path.resolve(SIGNALS_FILE), row + '\n');
}

function baseIgnoreCheck(transfer) {
  const symbol = String(transfer.tokenSymbol || '').trim();
  const name = String(transfer.tokenName || '').trim();
  const tokenAddress = norm(transfer.tokenAddress);

  if (transfer.direction !== 'IN') {
    return {
      ignore: true,
      reason: 'not incoming',
    };
  }

  if (IGNORE_KNOWN_QUOTES) {
    if (QUOTE_TOKEN_ADDRESSES.has(tokenAddress)) {
      return {
        ignore: true,
        reason: 'known quote token address',
      };
    }

    if (QUOTE_SYMBOLS.has(symbol.toUpperCase())) {
      return {
        ignore: true,
        reason: 'known quote token symbol',
      };
    }
  }

  if (IGNORE_ESTABLISHED) {
    if (ESTABLISHED_TOKEN_ADDRESSES.has(tokenAddress)) {
      return {
        ignore: true,
        reason: 'established token address',
      };
    }

    if (ESTABLISHED_SYMBOLS.has(symbol.toUpperCase())) {
      return {
        ignore: true,
        reason: 'established token symbol',
      };
    }
  }

  if (IGNORE_UNKNOWN_TOKENS) {
    if (!symbol || symbol === '?' || !name || name === '?') {
      return {
        ignore: true,
        reason: 'unknown token metadata',
      };
    }
  }

  if (IGNORE_SPAM_TOKENS) {
    const combined = `${symbol} ${name}`.toLowerCase();

    for (const pattern of SPAM_PATTERNS) {
      if (combined.includes(pattern)) {
        return {
          ignore: true,
          reason: `spam pattern: ${pattern}`,
        };
      }
    }
  }

  return {
    ignore: false,
    reason: '',
  };
}

async function getEthereumTokenTransfersForWallet(wallet) {
  const url = 'https://api.etherscan.io/v2/api';

  const params = {
    chainid: ETHERSCAN_CHAIN_ID,
    module: 'account',
    action: 'tokentx',
    address: wallet,
    page: 1,
    offset: MAX_RESULTS_PER_WALLET,
    sort: 'desc',
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
        message: `${data.message || 'NO_MESSAGE'} | ${data.result || 'NO_RESULT'}`,
        transfers: [],
      };
    }

    return {
      ok: true,
      message: data.message,
      transfers: data.result.map((tx) => ({
        chain: 'ethereum',
        wallet,
        direction: norm(tx.to) === wallet ? 'IN' : 'OUT',
        from: norm(tx.from),
        to: norm(tx.to),
        tokenAddress: norm(tx.contractAddress),
        tokenSymbol: tx.tokenSymbol || '',
        tokenName: tx.tokenName || '',
        tokenDecimal: tx.tokenDecimal || '',
        valueRaw: tx.value || '',
        txHash: tx.hash,
        blockNumber: Number(tx.blockNumber || 0),
        timeStamp: Number(tx.timeStamp || 0),
      })),
    };
  } catch (err) {
    return {
      ok: false,
      message: `HTTP_ERROR | ${err.message}`,
      transfers: [],
    };
  }
}

async function fetchDexInfo(chain, tokenAddress) {
  if (!ENRICH_DEX) {
    return {
      pairFound: false,
      quality: 'NOT_ENRICHED',
      reason: '',
    };
  }

  const url = `https://api.dexscreener.com/token-pairs/v1/${chain}/${tokenAddress}`;

  try {
    const { data } = await axios.get(url, {
      timeout: 30000,
    });

    const pairs = Array.isArray(data) ? data : [];

    if (!pairs.length) {
      return {
        pairFound: false,
        quality: 'NO_PAIR',
        reason: 'no dexscreener pair',
      };
    }

    const bestPair = [...pairs].sort((a, b) => {
      const liqA = Number(a?.liquidity?.usd || 0);
      const liqB = Number(b?.liquidity?.usd || 0);

      if (liqA !== liqB) return liqB - liqA;

      const volA = Number(a?.volume?.h24 || 0);
      const volB = Number(b?.volume?.h24 || 0);

      return volB - volA;
    })[0];

    const liquidityUsd = Number(bestPair?.liquidity?.usd || 0);
    const volume24h = Number(bestPair?.volume?.h24 || 0);
    const fdv = Number(bestPair?.fdv || 0);
    const priceChange24h = Number(bestPair?.priceChange?.h24 || 0);

    return {
      pairFound: true,
      quality: 'DEX_FOUND',
      reason: '',
      liquidityUsd,
      volume24h,
      fdv,
      priceChange24h,
      url: bestPair?.url || '',
      pairAddress: bestPair?.pairAddress || '',
      dexId: bestPair?.dexId || '',
      baseSymbol: bestPair?.baseToken?.symbol || '',
      quoteSymbol: bestPair?.quoteToken?.symbol || '',
    };
  } catch (err) {
    return {
      pairFound: false,
      quality: 'DEX_ERROR',
      reason: err.message,
    };
  }
}

function degenFilterCheck(dexInfo) {
  if (!DEGEN_ONLY) {
    return {
      pass: true,
      quality: 'NOT_DEGEN_FILTERED',
      reason: '',
    };
  }

  if (!dexInfo?.pairFound) {
    return {
      pass: false,
      quality: 'NO_PAIR',
      reason: dexInfo?.reason || 'no pair',
    };
  }

  const liquidityUsd = Number(dexInfo.liquidityUsd || 0);
  const volume24h = Number(dexInfo.volume24h || 0);
  const fdv = Number(dexInfo.fdv || 0);

  if (liquidityUsd < MIN_SIGNAL_LIQUIDITY) {
    return {
      pass: false,
      quality: 'LOW_LIQUIDITY',
      reason: `liquidity ${liquidityUsd} < ${MIN_SIGNAL_LIQUIDITY}`,
    };
  }

  if (liquidityUsd > MAX_SIGNAL_LIQUIDITY) {
    return {
      pass: false,
      quality: 'TOO_LARGE_LIQUIDITY',
      reason: `liquidity ${liquidityUsd} > ${MAX_SIGNAL_LIQUIDITY}`,
    };
  }

  if (volume24h < MIN_SIGNAL_VOLUME_24H) {
    return {
      pass: false,
      quality: 'LOW_VOLUME',
      reason: `volume24h ${volume24h} < ${MIN_SIGNAL_VOLUME_24H}`,
    };
  }

  if (fdv > 0 && fdv > MAX_SIGNAL_FDV) {
    return {
      pass: false,
      quality: 'FDV_TOO_HIGH',
      reason: `fdv ${fdv} > ${MAX_SIGNAL_FDV}`,
    };
  }

  return {
    pass: true,
    quality: 'DEGEN_SIGNAL',
    reason: '',
  };
}

function formatSignal({ transfer, walletMeta, dexInfo, signalQuality }) {
  const date = transfer.timeStamp
    ? new Date(transfer.timeStamp * 1000).toISOString()
    : '';

  return [
    '',
    '============================================================',
    '🚨 DEGEN TIER SMART WHALE SIGNAL',
    '============================================================',
    `Source:         ${walletMeta.sourceFile}`,
    `Chain:          ${transfer.chain}`,
    `Wallet:         ${transfer.wallet}`,
    `Class:          ${walletMeta.class}`,
    `Score:          ${walletMeta.score}`,
    `Audit Tier:     ${walletMeta.auditTier || '?'}`,
    `Audit Reason:   ${walletMeta.auditReason || '?'}`,
    `Known Tags:     ${walletMeta.tokenSymbols}`,
    `Tokens:         ${walletMeta.uniqueTokenCount || '?'}`,
    `HighQ / LowQ:   ${walletMeta.highQualityTokenCount || '?'} / ${walletMeta.lowQualityTokenCount || '?'}`,
    `Avg Early:      ${walletMeta.avgEarlyIndex || '?'}`,
    `Avg Liq / Vol:  $${walletMeta.avgLiquidityUsd || '?'} / $${walletMeta.avgVolume24h || '?'}`,
    '',
    `Signal Quality: ${signalQuality}`,
    `Token:          ${transfer.tokenSymbol || '?'} (${transfer.tokenName || '?'})`,
    `Token Addr:     ${transfer.tokenAddress}`,
    `Tx:             ${transfer.txHash}`,
    `Block:          ${transfer.blockNumber}`,
    `Time:           ${date}`,
    '',
    `DEX Liquidity:  $${dexInfo?.liquidityUsd ?? '?'}`,
    `DEX Vol 24h:    $${dexInfo?.volume24h ?? '?'}`,
    `DEX FDV:        $${dexInfo?.fdv ?? '?'}`,
    `DEX 24h Chg:    ${dexInfo?.priceChange24h ?? '?'}%`,
    `DEX URL:        ${dexInfo?.url || '?'}`,
    '',
    `Wallet URL:     ${explorerAddressUrl(transfer.chain, transfer.wallet)}`,
    `Tx URL:         ${explorerTxUrl(transfer.chain, transfer.txHash)}`,
    '============================================================',
    '',
  ].join('\n');
}

async function main() {
  console.log('Degen Tier Smart Whale Monitor v1.3');
  console.log(`PRIMARY_FILE=${PRIMARY_FILE}`);
  console.log(`SECONDARY_FILE=${SECONDARY_FILE}`);
  console.log(`TERTIARY_FILE=${TERTIARY_FILE}`);
  console.log(`FALLBACK_FILE=${FALLBACK_FILE}`);
  console.log(`SEEN_FILE=${SEEN_FILE}`);
  console.log(`SIGNALS_FILE=${SIGNALS_FILE}`);
  console.log(`MAX_RESULTS_PER_WALLET=${MAX_RESULTS_PER_WALLET}`);
  console.log(`IGNORE_KNOWN_QUOTES=${IGNORE_KNOWN_QUOTES}`);
  console.log(`IGNORE_UNKNOWN_TOKENS=${IGNORE_UNKNOWN_TOKENS}`);
  console.log(`IGNORE_SPAM_TOKENS=${IGNORE_SPAM_TOKENS}`);
  console.log(`IGNORE_ESTABLISHED=${IGNORE_ESTABLISHED}`);
  console.log(`DEGEN_ONLY=${DEGEN_ONLY}`);
  console.log(`ENRICH_DEX=${ENRICH_DEX}`);
  console.log(`MIN_SIGNAL_LIQUIDITY=${MIN_SIGNAL_LIQUIDITY}`);
  console.log(`MAX_SIGNAL_LIQUIDITY=${MAX_SIGNAL_LIQUIDITY}`);
  console.log(`MIN_SIGNAL_VOLUME_24H=${MIN_SIGNAL_VOLUME_24H}`);
  console.log(`MAX_SIGNAL_FDV=${MAX_SIGNAL_FDV}`);
  console.log(`MAX_DISTINCT_TOKENS_PER_RUN=${MAX_DISTINCT_TOKENS_PER_RUN}`);
  console.log(`VERBOSE_IGNORES=${VERBOSE_IGNORES}`);

  ensureSignalsCsv();

  const loaded = loadSmartWhales();
  const wallets = loaded.wallets;

  console.log(`Loaded source file: ${loaded.sourceFile || 'none'}`);
  console.log(`Loaded monitor wallets: ${wallets.length}`);

  if (!wallets.length) {
    console.log('No monitor wallets found.');
    return;
  }

  const seen = loadSeen();

  console.log(`Loaded seen transfer ids: ${seen.size}`);

  let newSignals = 0;
  let ignoredSignals = 0;

  const emittedWalletTokenKeys = new Set();
  const walletDistinctNewTokens = new Map();

  for (const walletMeta of wallets) {
    console.log('');
    console.log(
      `Scanning ${walletMeta.wallet} | class=${walletMeta.class} | score=${walletMeta.score} | source=${walletMeta.sourceFile}`
    );

    const res = await getEthereumTokenTransfersForWallet(walletMeta.wallet);

    if (!res.ok) {
      console.log(`  skipped: ${res.message}`);
      continue;
    }

    console.log(`  transfers fetched: ${res.transfers.length}`);

    for (const transfer of res.transfers) {
      const transferId = `${transfer.chain}:${transfer.txHash}:${transfer.tokenAddress}:${transfer.direction}`;

      if (seen.has(transferId)) {
        continue;
      }

      seen.add(transferId);

      const baseCheck = baseIgnoreCheck(transfer);

      if (baseCheck.ignore) {
        ignoredSignals += 1;

        if (VERBOSE_IGNORES) {
          console.log(
            `  ignored ${transfer.tokenSymbol || '?'} ${transfer.tokenAddress}: ${baseCheck.reason}`
          );
        }

        continue;
      }

      const walletTokenSet = walletDistinctNewTokens.get(transfer.wallet) || new Set();
      walletTokenSet.add(transfer.tokenAddress);
      walletDistinctNewTokens.set(transfer.wallet, walletTokenSet);

      if (walletTokenSet.size > MAX_DISTINCT_TOKENS_PER_RUN) {
        ignoredSignals += 1;

        if (VERBOSE_IGNORES) {
          console.log(
            `  ignored ${transfer.tokenSymbol || '?'} ${transfer.tokenAddress}: batch-transfer guard ${walletTokenSet.size} > ${MAX_DISTINCT_TOKENS_PER_RUN}`
          );
        }

        continue;
      }

      const walletTokenKey = `${transfer.chain}:${transfer.wallet}:${transfer.tokenAddress}`;

      if (emittedWalletTokenKeys.has(walletTokenKey)) {
        ignoredSignals += 1;

        if (VERBOSE_IGNORES) {
          console.log(
            `  ignored duplicate token this run: ${transfer.tokenSymbol || '?'} ${transfer.tokenAddress}`
          );
        }

        continue;
      }

      const dexInfo = await fetchDexInfo(transfer.chain, transfer.tokenAddress);
      await sleep(250);

      const degenCheck = degenFilterCheck(dexInfo);

      if (!degenCheck.pass) {
        ignoredSignals += 1;

        if (VERBOSE_IGNORES) {
          console.log(
            `  ignored ${transfer.tokenSymbol || '?'} ${transfer.tokenAddress}: ${degenCheck.quality} | ${degenCheck.reason}`
          );
        }

        continue;
      }

      emittedWalletTokenKeys.add(walletTokenKey);

      newSignals += 1;

      console.log(formatSignal({
        transfer,
        walletMeta,
        dexInfo,
        signalQuality: degenCheck.quality,
      }));

      appendSignalCsv({
        transfer,
        walletMeta,
        dexInfo,
        signalQuality: degenCheck.quality,
      });
    }
  }

  saveSeen(seen);

  console.log('');
  console.log('Done.');
  console.log(`New degen tier smart whale signals: ${newSignals}`);
  console.log(`Ignored new transfers: ${ignoredSignals}`);
  console.log(`Seen transfer ids saved: ${seen.size}`);
  console.log(`Signals file: ${SIGNALS_FILE}`);

  if (newSignals === 0) {
    console.log('No new degen-quality tier smart whale token activity detected.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});