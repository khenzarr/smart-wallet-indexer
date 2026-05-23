\# Contributing



Thanks for contributing to Smart Wallet Indexer.



This repo is a smart-money actor discovery pipeline for Ethereum and Base. The project is focused on finding addresses that repeatedly behave early across degen markets and appear to capture strong upside.



The project is not mainly a token signal bot. Token signals are secondary. The main goal is smart-money actor discovery, scoring, and review.



\---



\## Local setup



```powershell

git clone https://github.com/khenzarr/smart-wallet-indexer.git

cd smart-wallet-indexer

npm install

copy .env.example .env

notepad .env

```



Add your own Etherscan API key:



```env

ETHERSCAN\_API\_KEY=your\_etherscan\_api\_key\_here

```



Never commit `.env`.



\---



\## Main workflow



Run the full local pipeline:



```powershell

npm run market

npm run actors

npm run audit:actors

npm run profit:actors

npm run export:final

```



The main local result is:



```txt

final-smart-money-list.csv

```



This output is ignored by Git and should not be committed.



\---



\## Branch workflow



Create a feature branch:



```powershell

git checkout -b feature/short-description

```



Examples:



```powershell

git checkout -b feature/improve-actor-scoring

git checkout -b feature/add-contract-review-report

git checkout -b fix/base-blockscout-parser

```



\---



\## Before committing



Run:



```powershell

git status --ignored

```



Confirm that generated outputs are ignored and not staged.



Do not commit:



```txt

.env

\*.csv

\*.xlsx

seen\*.json

signals.csv

smart-whale-signals.csv

node\_modules/

```



Commit only code, documentation, or config templates.



\---



\## Commit



```powershell

git add .

git commit -m "Improve actor scoring logic"

git push -u origin feature/short-description

```



Then open a Pull Request.



\---



\## Pull Request checklist



Before opening a PR, confirm:



```txt

\- npm install works

\- .env.example is still safe and contains no real key

\- generated CSV/JSON/XLSX outputs are not committed

\- .gitignore still protects local output files

\- pipeline still runs through export:final

\- README / docs updated if behavior changed

```



\---



\## Code guidelines



Prefer clear, maintainable scripts.



Use explicit names:



```txt

actor

actorType

auditTier

profitProxyScore

reviewStatus

recommendedAction

```



Avoid ambiguous names like:



```txt

thing

data

tmp

walletScore2

```



\---



\## Important project concepts



\### Actor



An actor is any address that may represent smart money.



This can be:



```txt

EOA

contract wallet

smart account

executor contract

sniper contract

trading contract

wallet cluster

```



\### Infra actor



Infra actors are not treated as smart money by default.



Examples:



```txt

Router

Settler

PoolManager

UniversalRouter

LiFiDiamond

BaseSettler

Pair

Pool

Factory

Vault

HookAdapter

```



These should be filtered or manually reviewed.



\### Profit proxy



Profit proxy is not realized profit.



It means:



```txt

the actor was early

the token later showed liquidity / volume / momentum

the actor may have captured upside

```



Realized PnL requires deeper swap entry/exit reconstruction and is not fully implemented yet.



\---



\## High-priority improvement areas



Useful areas to work on:



```txt

1\. Realized PnL approximation

2\. Swap entry/exit detection

3\. Contract actor manual review tooling

4\. Funding source clustering

5\. Base actor classification improvements

6\. Better infra contract denylist

7\. Better generated report formatting

8\. README examples and sample outputs

```



\---



\## Safety



Do not push private alpha datasets to public GitHub.



Generated outputs may contain valuable wallet lists and should remain local unless intentionally shared.



If a secret is accidentally pushed, rotate it immediately.

