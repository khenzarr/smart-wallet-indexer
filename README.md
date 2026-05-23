# Smart Wallet Indexer

Smart Wallet Indexer is a market-wide smart-money discovery pipeline for Ethereum and Base.

The goal is not simply to generate token signals. The main goal is to discover, rank, and review addresses that repeatedly behave early across degen markets and appear to capture strong upside.

In this project, "smart wallet" is treated broadly as a **smart-money actor**. That can include:

- EOAs
- smart accounts
- contract wallets
- executor contracts
- sniper contracts
- wallet clusters
- contract-based trading actors

The pipeline separates real smart-money candidates from infrastructure noise such as routers, settlers, pools, hooks, and aggregation contracts.

---

## What this project does

The pipeline:

1. Collects a market-wide token universe from DEX Screener.
2. Extracts early token receivers / actors.
3. Classifies actors as EOA, contract, infra contract, or unknown.
4. Scores repeat early behavior.
5. Audits infra and cluster risk.
6. Enriches actors with token quality and momentum data.
7. Exports a final local smart-money watchlist.

The main final output is:

```txt
final-smart-money-list.csv
```

This file is generated locally and should not be committed to GitHub.

---

## Supported chains

Current focus:

```txt
Ethereum Mainnet
Base Mainnet
```

---

## Requirements

- Node.js 20+
- npm
- Etherscan API key

BaseScan data is accessed through Etherscan API V2 where available. For Base fallback coverage, the project also uses public Blockscout endpoints.

---

## Setup

Clone the repo:

```powershell
git clone https://github.com/khenzarr/smart-wallet-indexer.git
cd smart-wallet-indexer
```

Install dependencies:

```powershell
npm install
```

Create a local environment file:

```powershell
copy .env.example .env
notepad .env
```

Add your own API key:

```env
ETHERSCAN_API_KEY=your_etherscan_api_key_here
```

Never commit `.env`.

---

## Main pipeline

Run the full discovery pipeline in this order:

```powershell
npm run market
npm run actors
npm run audit:actors
npm run profit:actors
npm run export:final
```

After this, open:

```txt
final-smart-money-list.csv
```

---

## Script overview

### `npm run market`

Collects a broader token universe from DEX Screener.

Script:

```txt
collect-market-tokens.mjs
```

Typical local output:

```txt
market-tokens.csv
```

This is generated data and should not be committed.

---

### `npm run actors`

Runs actor-aware early participant indexing.

It does not only track EOAs. It also captures contract-like actors and separates infrastructure.

Script:

```txt
index-smart-actors.mjs
```

Typical local outputs:

```txt
all-early-actors.csv
eoa-early-actors.csv
contract-early-actors.csv
infra-early-actors.csv
unknown-early-actors.csv
smart-actor-score.csv
smart-actor-candidates.csv
```

---

### `npm run audit:actors`

Audits scored actors and separates them into usable categories.

Script:

```txt
audit-smart-actors.mjs
```

Typical local outputs:

```txt
tier1-smart-money-actors.csv
tier2-smart-money-watch.csv
smart-contract-actors.csv
infra-actors-filtered.csv
cluster-risk-actors.csv
audited-smart-actors.csv
```

Important categories:

```txt
TIER_1_EOA_SMART_MONEY
TIER_2_EOA_WATCH
SMART_CONTRACT_ACTOR
INFRA
CLUSTER_RISK
LOW_PRIORITY
```

---

### `npm run profit:actors`

Adds token-quality and momentum data using DEX Screener.

This produces a profit proxy, not realized PnL.

Script:

```txt
enrich-actor-profit.mjs
```

Typical local outputs:

```txt
actor-profit-report.csv
tier1-profitable-smart-money.csv
contract-profit-review.csv
```

---

### `npm run export:final`

Exports the final combined address list.

Script:

```txt
export-final-smart-money-list.mjs
```

Main local output:

```txt
final-smart-money-list.csv
```

---

## Final output interpretation

`final-smart-money-list.csv` includes fields such as:

```txt
address
actorCategory
actorType
rankTier
profitTier
profitProxyScore
auditTier
uniqueTokenCount
strongProfitProxyCount
avgEarlyIndex
tokenSymbols
riskLabel
reviewStatus
recommendedAction
```

Recommended review statuses:

```txt
READY_FOR_WATCHLIST
WATCHLIST_CANDIDATE
NEEDS_CONTRACT_MANUAL_REVIEW
OBSERVE_ONLY
```

### `READY_FOR_WATCHLIST`

Cleanest EOA smart-money candidates. These can be added to active monitoring.

### `WATCHLIST_CANDIDATE`

Promising but lower confidence. Needs additional validation before acting.

### `NEEDS_CONTRACT_MANUAL_REVIEW`

Potentially valuable contract/executor actors, but must be inspected manually before being treated as smart money.

### `OBSERVE_ONLY`

Keep for historical reference. Do not treat as direct signal.

---

## Monitoring

There are monitor scripts in the repo, but the primary project goal is smart-money discovery and ranking.

Monitoring is a secondary feature.

Available monitor commands:

```powershell
npm run monitor:whales
npm run monitor:whales:loop
```

Use these only after generating or preparing the local watchlist.

---

## Generated files

Generated CSV, JSON, Excel, and signal files are ignored by Git.

Do not commit:

```txt
.env
*.csv
*.xlsx
seen*.json
signals.csv
smart-whale-signals.csv
node_modules/
```

If you generate valuable local outputs, keep them private unless intentionally shared.

---

## Development workflow

Create a branch:

```powershell
git checkout -b feature/my-change
```

Make changes, then test:

```powershell
npm run market
npm run actors
npm run audit:actors
npm run profit:actors
npm run export:final
```

Check Git status:

```powershell
git status --ignored
```

Only code and documentation should be committed.

Commit:

```powershell
git add .
git commit -m "Describe the change"
git push -u origin feature/my-change
```

Then open a Pull Request.

---

## Security

Never commit:

```txt
.env
API keys
private notes
generated alpha lists
raw output CSVs
signal logs
```

If a real API key is ever pushed to a public repo, rotate it immediately.

---

## Project status

This is an experimental research pipeline.

Current focus:

```txt
Ethereum + Base smart-money actor discovery
early behavior detection
contract-aware actor classification
infra/noise filtering
profit proxy ranking
final watchlist export
```

Future improvements may include:

```txt
realized PnL estimation
swap entry/exit reconstruction
funding source clustering
contract creator analysis
wallet cluster graphing
automated manual review reports
```