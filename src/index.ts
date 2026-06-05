/**
 * VEIL Protocol — Autonomous Agent  (Terminal 3 T3N-integrated)
 *
 * Every 30 seconds:
 *   - Reads Chainlink ETH/USD oracle via getLatestPrice()
 *   - Calls checkAndSettle(id) on every active CDS — credit event fires if price <= floor
 *   - Calls expireContract(id) on any matured positions
 *   - Exposes GET /status for health checks
 *   - Every settlement + expiration is attested with T3N agent identity (did:t3n:…)
 */

import { ethers } from "ethers";
import * as http from "http";
import * as dotenv from "dotenv";
import { initT3n, attestAction, getAgentDid } from "./t3n";
dotenv.config();

// T3N agent identity — set T3N_API_KEY in .env to enable verifiable agent identity
const T3N_ENABLED = !!(process.env.T3N_API_KEY || "").trim();

// — Config —

const RPC_URL    = (process.env.ARB_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc").trim();
const PRIVATE_KEY = (process.env.VEIL_PRIVATE_KEY ?? "").trim();
const CDS_ADDRESS = (process.env.CDS_ADDRESS ?? "0xB2326A7A1EA88054906b16783B12E451d1Af0791").trim();
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS ?? "30000");
const STATUS_PORT = parseInt(process.env.STATUS_PORT ?? "3001");

// — ABI —

const ABI = [
  "function totalContracts() view returns (uint256)",
  "function getCDS(uint256 cdsId) view returns (address buyer, address seller, uint256 triggerPrice, uint256 maturityTimestamp, uint256 nextPremiumDue, uint8 status, bool notionalDeposited, bytes32 notionalHandle, bytes32 premiumBalanceHandle)",
  "function checkAndSettle(uint256 cdsId)",
  "function expireContract(uint256 cdsId)",
  "function getLatestPrice() view returns (int256 price, uint256 updatedAt)",
];

// — State —

interface AgentStats {
  startTime: string;
  iterations: number;
  settledCount: number;
  expiredCount: number;
  lastIterationAt: string;
  lastPriceUSD: string;
  totalCDS: number;
  activeCDS: number;
  errors: number;
  wallet: string;
  cdsAddress: string;
  rpcUrl: string;
  t3nDid: string;
  events: string[];
}

const stats: AgentStats = {
  startTime: new Date().toISOString(),
  iterations: 0,
  settledCount: 0,
  expiredCount: 0,
  lastIterationAt: "",
  lastPriceUSD: "0",
  totalCDS: 0,
  activeCDS: 0,
  errors: 0,
  wallet: "",
  cdsAddress: CDS_ADDRESS,
  rpcUrl: RPC_URL,
  t3nDid: "",
  events: [],
};

function pushEvent(kind: string, msg: string) {
  const time = new Date().toISOString().replace("T", " ").substring(0, 19);
  stats.events.unshift(`[${time}] ${kind}: ${msg}`);
  if (stats.events.length > 100) stats.events.pop();
}

// — Logger —

function log(level: "INFO" | "WARN" | "ERROR", msg: string) {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 23);
  console.log(`${ts} [${level.padEnd(5)}] ${msg}`);
  pushEvent(level, msg);
}

// — Agent loop —

async function runIteration(contract: ethers.Contract, wallet: ethers.Wallet) {
  stats.iterations++;
  stats.lastIterationAt = new Date().toISOString();

  try {
    const [price] = await contract.getLatestPrice();
    const priceUSD = (Number(price) / 1e8).toFixed(2);
    stats.lastPriceUSD = priceUSD;
    log("INFO", `ETH/USD: $${priceUSD}`);
  } catch (e: any) {
    log("WARN", `getLatestPrice failed: ${e.message?.slice(0, 80)}`);
  }

  let total = 0n;
  try {
    total = await contract.totalContracts();
    stats.totalCDS = Number(total);
  } catch (e: any) {
    log("ERROR", `totalContracts failed: ${e.message?.slice(0, 80)}`);
    stats.errors++;
    return;
  }

  let active = 0;
  const now = BigInt(Math.floor(Date.now() / 1000));

  for (let id = 0n; id < total; id++) {
    let cds: any;
    try {
      cds = await contract.getCDS(id);
    } catch {
      continue;
    }

    const status: number = Number(cds.status);
    if (status !== 0) continue;

    active++;

    // Try checkAndSettle
    try {
      const tx = await contract.checkAndSettle(id);
      await tx.wait();
      if (T3N_ENABLED) await attestAction("SETTLE", { cdsId: String(id), txHash: tx.hash, priceUSD: stats.lastPriceUSD });
      stats.settledCount++;
      log("INFO", `CDS #${id} — SETTLED via checkAndSettle. Tx: ${tx.hash}`);
      active--;
    } catch {
      // Not triggered yet
    }

    // Try expireContract if past maturity
    if (cds.maturityTimestamp <= now) {
      try {
        const tx = await contract.expireContract(id);
        await tx.wait();
        if (T3N_ENABLED) await attestAction("EXPIRE", { cdsId: String(id), txHash: tx.hash });
        stats.expiredCount++;
        log("INFO", `CDS #${id} — EXPIRED via expireContract. Tx: ${tx.hash}`);
        active--;
      } catch {
        // Already handled
      }
    }
  }

  stats.activeCDS = active;
  if (T3N_ENABLED) await attestAction("SCAN", { total: String(stats.totalCDS), active: String(active), priceUSD: stats.lastPriceUSD });
  log("INFO", `Iteration ${stats.iterations} done — total: ${stats.totalCDS}, active: ${active}, settled: ${stats.settledCount}, expired: ${stats.expiredCount}, did: ${stats.t3nDid || "disabled"}`);
}

// — Dashboard HTML (single-file, no dependencies) —

function dashboardHTML(): string {
  const s = stats;
  const runningSec = Math.floor((Date.now() - new Date(s.startTime).getTime()) / 1000);
  const eventsHTML = s.events.slice(0, 30).map(e => `<div class="ev">${e}</div>`).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VEIL Protocol — Agent Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#e0e0e0;font-family:system-ui,-apple-system,sans-serif;min-height:100vh}
header{background:#0d0d1a;border-bottom:1px solid #1a1a2e;padding:16px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
.logo{display:flex;align-items:center;gap:10px;font-size:1.2rem;font-weight:700;color:#fff}
.logo .dot{width:10px;height:10px;border-radius:50%;background:#10b981;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.badges{display:flex;gap:8px;flex-wrap:wrap}
.badge{padding:4px 12px;border-radius:20px;font-size:.75rem;font-weight:600}
.badge-live{background:#10b98120;color:#10b981;border:1px solid #10b98140}
.badge-t3n{background:#6366f120;color:#818cf8;border:1px solid #6366f140}
.badge-chain{background:#3b82f620;color:#60a5fa;border:1px solid #3b82f640}
main{max-width:1200px;margin:0 auto;padding:24px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.card{background:#0d0d1a;border:1px solid #1a1a2e;border-radius:12px;padding:20px}
.card .label{font-size:.75rem;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.card .value{font-size:1.6rem;font-weight:700;color:#f9fafb}
.card .value.price{color:#818cf8}
.card .value.settle{color:#10b981}
.card .value.expire{color:#f59e0b}
.card .value.active{color:#3b82f6}
.terminal{background:#0d0d1a;border:1px solid #1a1a2e;border-radius:12px;overflow:hidden}
.terminal-header{background:#111122;padding:10px 20px;font-size:.8rem;color:#6b7280;border-bottom:1px solid #1a1a2e;display:flex;justify-content:space-between;align-items:center}
.terminal-body{max-height:400px;overflow-y:auto;padding:12px 20px;font-family:'Cascadia Code','Fira Code',monospace;font-size:.78rem;line-height:1.7}
.ev{color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ev:has(:contains("SETTLE")),.ev:has(:contains("EXPIRE")) {color:#10b981}
.ev:has(:contains("ERROR")) {color:#ef4444}
footer{padding:16px 24px;text-align:center;color:#4b5563;font-size:.75rem}
.refresh{color:#6366f1}
</style>
</head>
<body>
<header>
<div class="logo"><div class="dot"></div>VEIL Protocol — Agent Dashboard</div>
<div class="badges">
<span class="badge badge-live">● AGENT LIVE</span>
<span class="badge badge-t3n">${s.t3nDid ? "T3N: "+s.t3nDid.slice(0,24)+"..." : "T3N: DISABLED"}</span>
<span class="badge badge-chain">Arbitrum Sepolia</span>
</div>
</header>
<main>
<div class="cards">
<div class="card"><div class="label">ETH/USD</div><div class="value price">$${s.lastPriceUSD}</div></div>
<div class="card"><div class="label">Active CDS</div><div class="value active">${s.activeCDS} / ${s.totalCDS}</div></div>
<div class="card"><div class="label">Settlements</div><div class="value settle">${s.settledCount}</div></div>
<div class="card"><div class="label">Expirations</div><div class="value expire">${s.expiredCount}</div></div>
<div class="card"><div class="label">Iterations</div><div class="value">${s.iterations}</div></div>
<div class="card"><div class="label">Running</div><div class="value">${Math.floor(runningSec/60)}m ${runningSec%60}s</div></div>
</div>
<div class="terminal">
<div class="terminal-header"><span>Agent Event Log</span><span class="refresh">Auto-refresh 2s</span></div>
<div class="terminal-body">${eventsHTML || '<div class="ev">Waiting for events...</div>'}</div>
</div>
</main>
<footer>VEIL Protocol · Autonomous CDS Settlement Agent · T3N Verifiable Identity</footer>
<script>setTimeout(()=>location.reload(),2000)</script>
</body>
</html>`;
}

// — HTTP Server —

function startStatusServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, ...stats }, null, 2));
    } else if (req.url === "/" || req.url === "/dashboard") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(dashboardHTML());
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"error":"not found"}');
    }
  });
  server.listen(STATUS_PORT, () => log("INFO", `Dashboard: http://0.0.0.0:${STATUS_PORT}`));
}

// — Banner —

function banner() {
  console.log(`
  VEIL Protocol — Confidential CDS on Arbitrum Sepolia
  Autonomous settlement agent — checks every ${INTERVAL_MS / 1000}s
  T3N Agent Identity: ${T3N_ENABLED ? "ENABLED (did:t3n:...)" : "DISABLED (set T3N_API_KEY)"}`);
}

// — Main —

async function main() {
  banner();

  if (!PRIVATE_KEY) throw new Error("VEIL_PRIVATE_KEY not set in .env");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CDS_ADDRESS, ABI, wallet);

  stats.wallet = wallet.address;

  if (T3N_ENABLED) {
    const did = await initT3n();
    if (did) stats.t3nDid = did;
  }

  log("INFO", `Wallet    : ${wallet.address}`);
  log("INFO", `CDS       : ${CDS_ADDRESS}`);
  log("INFO", `RPC       : ${RPC_URL}`);
  log("INFO", `Interval  : ${INTERVAL_MS / 1000}s`);
  log("INFO", `T3N DID   : ${stats.t3nDid || "disabled"}`);

  startStatusServer();

  await runIteration(contract, wallet).catch(e => {
    log("ERROR", e.message);
    stats.errors++;
  });

  setInterval(async () => {
    await runIteration(contract, wallet).catch(e => {
      log("ERROR", e.message);
      stats.errors++;
    });
  }, INTERVAL_MS);
}

main().catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
})