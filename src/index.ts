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
};

// — Logger —

function log(level: "INFO" | "WARN" | "ERROR", msg: string) {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 23);
  console.log(`${ts} [${level.padEnd(5)}] ${msg}`);
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

// — Status HTTP server —

function startStatusServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/status" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...stats }, null, 2));
    } else {
      res.writeHead(404);
      res.end('{"error":"not found"}');
    }
  });
  server.listen(STATUS_PORT, () => log("INFO", `Status server: http://0.0.0.0:${STATUS_PORT}/status`));
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