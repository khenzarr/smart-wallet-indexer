import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const ETHERSCAN_CHAIN_ID = '1';

const WATCHLIST_FILE = 'watchlist.csv';
const SEEN_FILE = 'seen-transfers.json';
const SIGNALS_FILE = 'signals.csv';

const MAX_RESULTS_PER_WALLET = Number(process.env.MONITOR_MAX_RESULTS_PER_WALLET || 10);

const IGNORE_KNOWN_QUOTES =
  String(process.env.MONITOR_IGNORE_QUOTES || 'true').toLowerCase() !== 'false';

const IGNORE_UNKNOWN_TOKENS =
  String(process.env.MONITOR_IGNORE_UNKNOWN || 'true').toLowerCase() !== 'false';

const IGNORE_SPAM_TOKENS =
  String(process.env.MONITOR_IGNORE_SPAM || 'true').toLowerCase() !== 'false';

const VERBOSE_IGNORES =
  String(process.env.MONITOR_VERBOSE_IGNORES || 'false').toLowerCase() === 'true';

if (!ETHERSCAN_API_KEY) {
  throw new Error('Missing ETHERSCAN_API_KEY in .env');
}

const QUOTE_TOKEN_ADDRESSES = new Set([
  // Ethereum WETH
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',

  // Ethereum USDC
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',

  // Ethereum USDT
  '0xdac17f958d2ee523a2206206994597c13d831ec7',

  // Ethereum DAI
  '0x6b175474e89094c44da98b954eedeac495271d0f',

  // Ethereum WBTC
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
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

function loadWatchlist() {
  const rows = parseCsvSimple(WATCHLIST_FILE);

  const wallets = rows
    .map((row) => ({
      wallet: norm(row.wallet),
      score: row.score || '',
      tokenSymbols: row.tokenSymbols || '',
      chains: row.chains || '',
    }))
    .filter((row) => isLikelyAddress(row.wallet));

  const dedup = new Map();

  for (const row of wallets) {
    dedup.set(row.wallet, row);
  }

  return [...dedup.values()];
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

function ensureSignalsCsv() {
  const abs = path.resolve(SIGNALS_FILE);

  if (fs.existsSync(abs)) {
    return;
  }

  const header = [
    'detectedAt',
    'chain',
    'wallet',
    'walletScore',
    'knownTags',
    'tokenSymbol',
    'tokenName',
    'tokenAddress',
    'txHash',
    'blockNumber',
    'transferTime',
    'txUrl',
    'walletUrl',
  ].join(',');

  fs.writeFileSync(abs, header + '\n');
}

function appendSignalCsv({ transfer, walletMeta }) {
  ensureSignalsCsv();

  const detectedAt = new Date().toISOString();
  const transferTime = transfer.timeStamp
    ? new Date(transfer.timeStamp * 1000).toISOString()
    : '';

  const row = [
    detectedAt,
    transfer.chain,
    transfer.wallet,
    walletMeta.score,
    walletMeta.tokenSymbols,
    transfer.tokenSymbol || '',
    transfer.tokenName || '',
    transfer.tokenAddress,
    transfer.txHash,
    transfer.blockNumber,
    transferTime,
    explorerTxUrl(transfer.chain, transfer.txHash),
    explorerAddressUrl(transfer.chain, transfer.wallet),
  ].map(csvEscape).join(',');

  fs.appendFileSync(path.resolve(SIGNALS_FILE), row + '\n');
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

function shouldIgnoreTransfer(transfer) {
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

function formatSignal({ transfer, walletMeta }) {
  const date = transfer.timeStamp
    ? new Date(transfer.timeStamp * 1000).toISOString()
    : '';

  return [
    '',
    '============================================================',
    '🚨 WATCHLIST NEW TOKEN ACTIVITY',
    '============================================================',
    `Chain:        ${transfer.chain}`,
    `Wallet:       ${transfer.wallet}`,
    `Token:        ${transfer.tokenSymbol || '?'} (${transfer.tokenName || '?'})`,
    `Token Addr:   ${transfer.tokenAddress}`,
    `Tx:           ${transfer.txHash}`,
    `Block:        ${transfer.blockNumber}`,
    `Time:         ${date}`,
    `Wallet Score: ${walletMeta.score}`,
    `Known Tags:   ${walletMeta.tokenSymbols}`,
    '',
    `Wallet URL:   ${explorerAddressUrl(transfer.chain, transfer.wallet)}`,
    `Tx URL:       ${explorerTxUrl(transfer.chain, transfer.txHash)}`,
    '============================================================',
    '',
  ].join('\n');
}

async function main() {
  console.log('Watchlist Monitor v0.6.2');
  console.log(`WATCHLIST_FILE=${WATCHLIST_FILE}`);
  console.log(`SEEN_FILE=${SEEN_FILE}`);
  console.log(`SIGNALS_FILE=${SIGNALS_FILE}`);
  console.log(`MAX_RESULTS_PER_WALLET=${MAX_RESULTS_PER_WALLET}`);
  console.log(`IGNORE_KNOWN_QUOTES=${IGNORE_KNOWN_QUOTES}`);
  console.log(`IGNORE_UNKNOWN_TOKENS=${IGNORE_UNKNOWN_TOKENS}`);
  console.log(`IGNORE_SPAM_TOKENS=${IGNORE_SPAM_TOKENS}`);
  console.log(`VERBOSE_IGNORES=${VERBOSE_IGNORES}`);

  ensureSignalsCsv();

  const watchlist = loadWatchlist();

  console.log(`Loaded watchlist wallets: ${watchlist.length}`);

  if (!watchlist.length) {
    console.log('watchlist.csv is empty or missing.');
    return;
  }

  const seen = loadSeen();

  console.log(`Loaded seen transfer ids: ${seen.size}`);

  let newSignals = 0;
  let ignoredSignals = 0;

  const emittedWalletTokenKeys = new Set();

  for (const walletMeta of watchlist) {
    console.log('');
    console.log(`Scanning ${walletMeta.wallet}`);

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

      const ignoreCheck = shouldIgnoreTransfer(transfer);

      if (ignoreCheck.ignore) {
        ignoredSignals += 1;

        if (VERBOSE_IGNORES) {
          console.log(
            `  ignored ${transfer.tokenSymbol || '?'} ${transfer.tokenAddress}: ${ignoreCheck.reason}`
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

      emittedWalletTokenKeys.add(walletTokenKey);

      newSignals += 1;

      console.log(formatSignal({ transfer, walletMeta }));

      appendSignalCsv({
        transfer,
        walletMeta,
      });
    }
  }

  saveSeen(seen);

  console.log('');
  console.log('Done.');
  console.log(`New signals: ${newSignals}`);
  console.log(`Ignored new transfers: ${ignoredSignals}`);
  console.log(`Seen transfer ids saved: ${seen.size}`);
  console.log(`Signals file: ${SIGNALS_FILE}`);

  if (newSignals === 0) {
    console.log('No new high-quality incoming token transfers detected.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});