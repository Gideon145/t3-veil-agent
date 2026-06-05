# VEIL Protocol — Autonomous CDS Agent with T3N Verifiable Identity

**On-chain Credit Default Swap settlement agent proving every action via Terminal 3 TEE-attested identity**

> _"Autonomous finance. Verifiable identity. Zero trust required."_

🎥 **Demo Video:** https://youtu.be/tWEz6LLVpcA

[![T3N](https://img.shields.io/badge/Terminal%203-T3N%20Verified-6366f1)](https://terminal3.io) [![Chain](https://img.shields.io/badge/Chain-Arbitrum%20Sepolia%20421421-blue)](https://sepolia.arbiscan.io) [![Agent](https://img.shields.io/badge/Agent-Autonomous%2024%2F7-brightgreen)]() [![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org/) [![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

---

## What Is VEIL Protocol?

VEIL Protocol is a **confidential Credit Default Swap (CDS) protocol on Arbitrum Sepolia**. It lets any Ethereum address buy protection against ETH price drops — like insurance for your ETH holdings. A buyer locks a premium, a seller locks a notional, and if the Chainlink ETH/USD oracle dips below the trigger price, the buyer gets paid instantly.

This repo is the **autonomous settlement agent** that keeps the protocol running 24/7. It monitors every CDS position on-chain, triggers settlements when price conditions are met, expires matured contracts, and — critically — **proves its identity through Terminal 3's T3N network** so every action is cryptographically verifiable.

---

## The Problem VEIL Solves

DeFi insurance has two fundamental trust problems:

1. **The Settlement Problem** — Someone must watch the oracle and trigger payouts. If that "someone" is a centralized bot, it can be bribed, DDoSed, or coerced into ignoring legitimate claims. If it's the buyer themselves, they must stay online 24/7 or risk missing a payout window.

2. **The Identity Problem** — When a settlement happens and funds move, how do you prove the agent that triggered it was the real agent, not an attacker who stole the private key? Without verifiable identity, every settlement is a potential rug.

VEIL solves both: the agent is autonomous and permissionless (anyone can call `checkAndSettle`), and every action is attested with a **did:t3n:...** identity that's hardware-verified inside a TEE.

---

## The Solution

VEIL runs an autonomous agent loop every **30 seconds** that:

1. **Reads** the Chainlink ETH/USD oracle via `getLatestPrice()`
2. **Scans** all active CDS positions via `totalContracts()` + `getCDS(id)`
3. **Settles** any position where `price <= triggerPrice` via `checkAndSettle(id)`
4. **Expires** any position past its `maturityTimestamp` via `expireContract(id)`
5. **Attests** every settlement, expiration, and scan iteration with the agent's `did:t3n:...` identity
6. **Exposes** GET `/status` for real-time health checks

The agent is **stateless and permissionless** — anyone can call `checkAndSettle` and `expireContract`. The contract reads the oracle itself, so no encrypted handles or off-chain state is needed. The agent just needs to stay awake and scan.

---

## Live Deployment

| Service | URL | Status |
|---|---|---|
| 🎥 Demo Video | https://youtu.be/tWEz6LLVpcA | YouTube |
| Agent Dashboard | `http://localhost:3001` | Local (4-tab UI with live metrics, CDS positions, event log) |
| Status API | `http://localhost:3001/status` | Local (JSON) |
| CDS Positions API | `http://localhost:3001/cds` | Local (JSON) |
| CDS Contract | [0xB2326A7A...](https://sepolia.arbiscan.io/address/0xB2326A7A1EA88054906b16783B12E451d1Af0791) | Arbitrum Sepolia |
| T3N Identity | `did:t3n:eth:...` | T3N Testnet |

---

## Architecture

```
                    ┌─────────────────────────────┐
                    │    Terminal 3 T3N Network    │
                    │   (Hardware TEE Attestation) │
                    └─────────────┬───────────────┘
                                  │ did:t3n:...
                                  │ attest(SETTLE/EXPIRE/SCAN)
                                  ▼
┌──────────┐    ┌──────────────┐    ┌────────────────┐    ┌──────────────┐
│ Chainlink │───▶│  VEIL Agent  │───▶│  CDS Contract   │◀───│ Status API   │
│  Oracle   │    │  (30s loop)  │    │  (Arbitrum      │    │ GET /status  │
│ ETH/USD   │    │              │    │   Sepolia)       │    │ :3001        │
└──────────┘    └──────┬───────┘    └───────┬────────┘    └──────────────┘
                       │                    │
                       │    src/t3n.ts      │   src/index.ts
                       │  - WASM handshake  │  - checkAndSettle()
                       │  - Eth wallet auth │  - expireContract()
                       │  - Action attest   │  - getLatestPrice()
                       └────────────────────┘
```

---

## Terminal 3 T3N Integration

This is the core differentiator. The agent uses `@terminal3/t3n-sdk` to:

### 1. Load WASM Component
All cryptographic operations (handshake, signing, attestation) run inside **WASM**, not Node.js. This isolates the trust boundary and ensures the crypto can't be monkey-patched.

### 2. Handshake — Encrypted Channel
```typescript
await client.handshake();
// Opens an end-to-end encrypted session with a T3N TEE node.
// Node operators cannot read the session — enforced by hardware.
```

### 3. Authenticate — Verifiable Identity
```typescript
const didObj = await client.authenticate(createEthAuthInput(address));
// agentDid = did:t3n:eth:0x...
// This DID is bound to the wallet + the TEE session.
// Any action signed by this session is provably from this agent.
```

### 4. Attest Every Action
```typescript
await attestAction("SETTLE", {
  cdsId: "5",
  txHash: "0xabc...",
  priceUSD: "1847.32"
});
// Logged with timestamp + DID. Verifiable audit trail.
```

**Why this matters for the hackathon:** Without T3N, anyone with the agent's private key can spoof settlements. With T3N, every action is bound to a hardware-attested session — even if the key leaks, the attacker can't forge attestations from the TEE node.

---

## The Math

### CDS Settlement Condition

A CDS position `i` triggers settlement when:

```
Chainlink ETH/USD price <= triggerPrice_i
```

The contract reads the oracle directly:

```solidity
function checkAndSettle(uint256 cdsId) external {
    (int256 price,) = chainlinkOracle.latestRoundData();
    require(uint256(price) <= cds.triggerPrice, "Not triggered");
    // Release escrow to buyer
}
```

### Expiration Condition

```
block.timestamp >= maturityTimestamp_i
```

When a position expires (price never hit the trigger before maturity), the notional returns to the seller and the premium stays with the agent.

---

## Codebase Structure

```
t3-veil-agent/
├── src/
│   ├── index.ts          # Agent loop — scan, settle, expire, status server
│   └── t3n.ts            # T3N client — WASM load, handshake, authenticate, attest
├── package.json
├── tsconfig.json
├── .env.example          # Template — copy to .env and fill keys
├── .gitignore            # Blocks .env from commits
└── README.md
```

**Zero configuration needed beyond `.env`.** No database, no Redis, no external services. The contract is the source of truth.

---

## Agent Loop Deep Dive

Every 30 seconds (configurable via `INTERVAL_MS`):

```typescript
// Step 1: Read oracle
const [price] = await contract.getLatestPrice();
const priceUSD = (Number(price) / 1e8).toFixed(2);
// ETH/USD: $1,847.32

// Step 2: Enumerate all positions
const total = await contract.totalContracts();
for (let id = 0n; id < total; id++) {
  const cds = await contract.getCDS(id);
  if (cds.status !== 0) continue; // skip settled/expired/cancelled

  // Step 3: Try settlement
  try {
    const tx = await contract.checkAndSettle(id);
    await tx.wait();
    if (T3N_ENABLED) await attestAction("SETTLE", {
      cdsId: String(id),
      txHash: tx.hash,
      priceUSD
    });
    stats.settledCount++;
  } catch { /* not triggered — normal */ }

  // Step 4: Try expiration
  if (cds.maturityTimestamp <= now) {
    const tx = await contract.expireContract(id);
    await tx.wait();
    if (T3N_ENABLED) await attestAction("EXPIRE", {
      cdsId: String(id),
      txHash: tx.hash
    });
    stats.expiredCount++;
  }
}

// Step 5: Attest the scan itself
if (T3N_ENABLED) await attestAction("SCAN", {
  total: String(total),
  active: String(active),
  priceUSD
});
```

The agent is **idempotent** — calling `checkAndSettle` on an already-settled position just reverts silently. No harm in running it constantly.

---

## Running Locally

### Prerequisites

- Node.js >= 16
- An Arbitrum Sepolia wallet with test ETH
- A Terminal 3 API key (claim at https://www.terminal3.io/claim-page)

### 1. Clone & Install

```bash
git clone https://github.com/Gideon145/t3-veil-agent.git
cd t3-veil-agent
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
T3N_API_KEY=0x...           # from terminal3.io/claim-page
VEIL_PRIVATE_KEY=0x...       # agent wallet private key
```

### 3. Start

```bash
npm start
```

You should see:

```
[T3N] Setting environment to testnet
[T3N] Loading WASM component...
[T3N] Agent wallet address: 0x...
[T3N] Handshaking...
[T3N] Authenticating...
[T3N] ✅ Agent identity: did:t3n:eth:0x...
[T3N] Credits available: 20000
```

### 4. Open Dashboard

Open **http://localhost:3001** in your browser. The dashboard has four tabs:

| Tab | Shows |
|---|---|
| **Overview** | Live ETH/USD price, active CDS count, settlements, expirations, agent uptime, recent event log |
| **CDS Positions** | Every CDS position on-chain — buyer, seller, trigger price, status (Active/Settled/Expired) |
| **Event Log** | Full scrollable event log with filters (Settlements / Expirations / Errors), color-coded, auto-refresh |
| **About** | Protocol description, agent wallet address, T3N identity, contract address |

### 5. Check API

```bash
curl http://localhost:3001/status     # JSON: all metrics
curl http://localhost:3001/cds        # JSON: individual CDS positions

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `T3N_API_KEY` | Yes (for T3N) | — | Terminal 3 API key from claim page |
| `VEIL_PRIVATE_KEY` | Yes | — | Agent wallet private key (Arbitrum Sepolia) |
| `ARB_RPC_URL` | No | `https://sepolia-rollup.arbitrum.io/rpc` | Arbitrum Sepolia RPC endpoint |
| `CDS_ADDRESS` | No | `0xB2326A7A...` | Deployed CDS contract address |
| `INTERVAL_MS` | No | `30000` | Agent scan interval in milliseconds |
| `STATUS_PORT` | No | `3001` | Health check HTTP port |

---

## Hackathon

Built for the **Terminal 3 Agent Dev Kit Bounty Challenge (beta)** on DoraHacks.

| Detail | Value |
|---|---|
| **Prize** | $500 USD |
| **Tracks** | Best Agent Auth SDK Implementation ($300) + Documentation Gaps ($200) |
| **Deadline** | June 7, 2026 |
| **DoraHacks** | [t3adkdevchallengebeta](https://dorahacks.io/hackathon/t3adkdevchallengebeta) |

### T3N SDK Usage Summary

| SDK Feature | Where Used |
|---|---|
| `T3nClient` (WASM session) | `src/t3n.ts` — encrypted channel to T3N TEE node |
| `loadWasmComponent()` | `src/t3n.ts` — loads crypto WASM binary |
| `setEnvironment("testnet")` | `src/t3n.ts` — targets T3N test network |
| `client.handshake()` | `src/t3n.ts` — opens end-to-end encrypted session |
| `client.authenticate()` | `src/t3n.ts` — proves wallet ownership → `did:t3n:...` |
| `client.getUsage()` | `src/t3n.ts` — checks credit balance |
| `attestAction()` (custom wrapper) | `src/index.ts` — attests every SETTLE / EXPIRE / SCAN |

---

## License

MIT — see [LICENSE](LICENSE)
