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

interface CDSInfo {
  id: number;
  buyer: string;
  seller: string;
  triggerPrice: string;
  maturityTimestamp: number;
  status: number;
  notionalDeposited: boolean;
}

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
  cdsPositions: CDSInfo[];
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
  cdsPositions: [],
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
  const positions: CDSInfo[] = [];

  for (let id = 0n; id < total; id++) {
    let cds: any;
    try {
      cds = await contract.getCDS(id);
    } catch {
      continue;
    }

    const status: number = Number(cds.status);
    // Track position for dashboard
    positions.push({
      id: Number(id),
      buyer: cds.buyer,
      seller: cds.seller,
      triggerPrice: `$${(Number(cds.triggerPrice) / 1e8).toFixed(2)}`,
      maturityTimestamp: Number(cds.maturityTimestamp),
      status,
      notionalDeposited: cds.notionalDeposited,
    });
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
  stats.cdsPositions = positions;
  if (T3N_ENABLED) await attestAction("SCAN", { total: String(stats.totalCDS), active: String(active), priceUSD: stats.lastPriceUSD });
  log("INFO", `Iteration ${stats.iterations} done — total: ${stats.totalCDS}, active: ${active}, settled: ${stats.settledCount}, expired: ${stats.expiredCount}, did: ${stats.t3nDid || "disabled"}`);
}

// — Dashboard HTML (JS-driven, fetches /status + /cds, no page reload) —

function dashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VEIL Protocol — Agent Dashboard</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='%23818cf8'/><stop offset='100%' stop-color='%233b82f6'/></linearGradient></defs><rect width='100' height='100' rx='20' fill='url(%23g)'/><text x='50' y='68' font-size='52' text-anchor='middle' fill='white'>V</text></svg>">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#06060e;--surface:#0c0c1d;--border:#1a1a33;--muted:#4b5563;--text:#d1d5db;--white:#f9fafb;
  --green:#10b981;--green-bg:#10b98115;--blue:#3b82f6;--blue-bg:#3b82f615;--amber:#f59e0b;--amber-bg:#f59e0b15;
  --purple:#818cf8;--purple-bg:#6366f115;--red:#ef4444;--red-bg:#ef444415}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;top:-50%;left:-50%;width:200%;height:200%;background:radial-gradient(circle at 30% 20%,#3b82f608 0%,transparent 50%),radial-gradient(circle at 70% 80%,#818cf808 0%,transparent 50%);pointer-events:none;z-index:0;animation:bgShift 20s ease-in-out infinite alternate}
@keyframes bgShift{0%{transform:translate(0,0)}100%{transform:translate(2%,1%)}}
header{position:relative;z-index:1;background:var(--surface);border-bottom:1px solid var(--border);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
.logo{display:flex;align-items:center;gap:10px}
.logo-icon{width:36px;height:36px;border-radius:8px;background:linear-gradient(135deg,#818cf8,#3b82f6);display:flex;align-items:center;justify-content:center;font-size:1.1rem}
.logo-text{font-size:1.1rem;font-weight:700;color:var(--white)}
.logo-text span{color:var(--purple)}
.status-dot{width:8px;height:8px;border-radius:50%;background:var(--green);animation:pulse 2s infinite;display:inline-block;margin-right:6px}
@keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 #10b98140}50%{opacity:.6;box-shadow:0 0 0 6px #10b98100}}
.badges{display:flex;gap:8px;flex-wrap:wrap}
.badge{padding:5px 14px;border-radius:20px;font-size:.72rem;font-weight:600;display:flex;align-items:center;gap:5px}
.badge-live{background:var(--green-bg);color:var(--green);border:1px solid #10b98130}
.badge-t3n{background:var(--purple-bg);color:var(--purple);border:1px solid #6366f130}
.badge-chain{background:var(--blue-bg);color:var(--blue);border:1px solid #3b82f630}
main{position:relative;z-index:1;max-width:1200px;margin:0 auto;padding:20px 24px}
.tabs{display:flex;gap:2px;margin-bottom:20px;background:var(--surface);border-radius:10px;padding:4px;border:1px solid var(--border);width:fit-content}
.tab{padding:8px 20px;border-radius:8px;font-size:.82rem;font-weight:500;cursor:pointer;color:var(--muted);border:none;background:none;transition:all .15s}
.tab:hover{color:var(--text)}
.tab.active{background:var(--blue-bg);color:var(--blue);font-weight:600}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:20px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px 20px;transition:all .3s;position:relative;overflow:hidden}
.card::after{content:'';position:absolute;inset:0;border-radius:12px;opacity:0;transition:opacity .3s;pointer-events:none}
.card:hover{border-color:#ffffff15;transform:translateY(-1px)}
.card:hover::after{opacity:1}
.card:nth-child(1):hover::after{box-shadow:0 0 30px #818cf810}
.card:nth-child(3):hover::after{box-shadow:0 0 30px #10b98110}
.card:nth-child(4):hover::after{box-shadow:0 0 30px #f59e0b10}
.card:nth-child(2):hover::after{box-shadow:0 0 30px #3b82f610}
.card:nth-child(6):hover::after{box-shadow:0 0 30px #ef444410}
.card .label{font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.card .value{font-size:1.5rem;font-weight:700;color:var(--white);transition:transform .2s ease}
.card .value.price{color:var(--purple)}
.card .value.settle{color:var(--green)}
.card .value.expire{color:var(--amber)}
.card .value.active{color:var(--blue)}
.card .value.error{color:var(--red)}
.card .sub{font-size:.72rem;color:var(--muted);margin-top:4px}
.panel{display:none}
.panel.active{display:block}
/* Position table */
.table-wrap{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.table-header{padding:14px 20px;border-bottom:1px solid var(--border);font-size:.8rem;color:var(--muted);display:flex;justify-content:space-between;align-items:center}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:12px 16px;font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:600;border-bottom:1px solid var(--border)}
td{padding:12px 16px;font-size:.8rem;border-bottom:1px solid #ffffff05;white-space:nowrap}
tr:hover td{background:#ffffff03}
.status-tag{padding:3px 10px;border-radius:12px;font-size:.7rem;font-weight:600}
.status-active{background:var(--green-bg);color:var(--green)}
.status-settled{background:var(--purple-bg);color:var(--purple)}
.status-expired{background:var(--amber-bg);color:var(--amber)}
.status-cancelled{background:var(--red-bg);color:var(--red)}
.addr{font-family:'Cascadia Code','Fira Code',monospace;font-size:.75rem;color:var(--text)}
.addr a{color:var(--blue);text-decoration:none}
.addr a:hover{text-decoration:underline}
.empty{text-align:center;padding:40px 20px;color:var(--muted);font-size:.85rem}
/* Event log */
.ev-log{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.ev-header{padding:12px 20px;border-bottom:1px solid var(--border);font-size:.78rem;color:var(--muted);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.ev-filters{display:flex;gap:6px}
.ev-filter{padding:3px 12px;border-radius:12px;font-size:.68rem;cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--muted);transition:all .15s}
.ev-filter:hover,.ev-filter.on{border-color:var(--blue);color:var(--blue)}
.ev-body{max-height:420px;overflow-y:auto;padding:8px 16px;font-family:'Cascadia Code','Fira Code',monospace;font-size:.74rem;line-height:2}
.ev-line{padding:3px 0;color:#9ca3af;display:flex;gap:8px;align-items:flex-start}
.ev-line .ts{color:#4b5563;flex-shrink:0;min-width:75px}
.ev-line.settle{color:var(--green)}
.ev-line.expire{color:var(--amber)}
.ev-line.error{color:var(--red)}
.ev-line.info{color:#9ca3af}
/* Footer */
footer{position:relative;z-index:1;padding:16px 24px;text-align:center;color:var(--muted);font-size:.7rem;border-top:1px solid var(--border)}
/* About panel */
.about-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:700px}
.about-card h3{color:var(--white);margin-bottom:12px;font-size:1.1rem}
.about-card p{color:var(--text);font-size:.85rem;line-height:1.7;margin-bottom:8px}
.about-card code{background:#ffffff08;padding:2px 6px;border-radius:4px;font-size:.8rem;color:var(--purple)}
@media(max-width:640px){.cards{grid-template-columns:repeat(2,1fr)}header{padding:12px 16px}main{padding:16px}}
</style>
</head>
<body>
<header>
<div class="logo">
<div class="logo-icon">⛓</div>
<div class="logo-text">VEIL <span>Protocol</span></div>
</div>
<div class="badges">
<span class="badge badge-live" id="liveBadge"><span class="status-dot"></span>AGENT LIVE</span>
<span class="badge badge-t3n" id="t3nBadge">T3N: ---</span>
<span class="badge badge-chain">Arbitrum Sepolia</span>
</div>
</header>
<main>
<div class="tabs">
<button class="tab active" onclick="switchTab('overview')">Overview</button>
<button class="tab" onclick="switchTab('positions')">CDS Positions</button>
<button class="tab" onclick="switchTab('events')">Event Log</button>
<button class="tab" onclick="switchTab('about')">About</button>
</div>

<div class="panel active" id="panel-overview">
<div class="cards">
<div class="card"><div class="label">💰 ETH / USD</div><div class="value price" id="vPrice">---</div><div class="sub" id="vPriceTime"></div></div>
<div class="card"><div class="label">📊 Active CDS</div><div class="value active" id="vActive">---</div><div class="sub" id="vTotal"></div></div>
<div class="card"><div class="label">✅ Settlements</div><div class="value settle" id="vSettled">---</div></div>
<div class="card"><div class="label">⏰ Expirations</div><div class="value expire" id="vExpired">---</div></div>
<div class="card"><div class="label">🔄 Iterations</div><div class="value" id="vIter">---</div><div class="sub" id="vUptime"></div></div>
<div class="card"><div class="label">⚠️ Errors</div><div class="value error" id="vErrors">---</div></div>
</div>
<div class="ev-log">
<div class="ev-header"><span>Recent Events</span><span style="font-size:.7rem;color:var(--blue)">Auto-refresh 2s</span></div>
<div class="ev-body" id="miniLog"></div>
</div>
</div>

<div class="panel" id="panel-positions">
<div class="table-wrap">
<div class="table-header"><span>CDS Positions</span><span id="posCount"></span></div>
<div style="overflow-x:auto">
<table><thead><tr>
<th>ID</th><th>Buyer</th><th>Seller</th><th>Trigger</th><th>Status</th>
</tr></thead><tbody id="posBody"></tbody></table>
</div>
<div class="empty" id="posEmpty">No positions deployed yet. Deploy a CDS contract to see it here.</div>
</div>
</div>

<div class="panel" id="panel-events">
<div class="ev-log">
<div class="ev-header">
<span>Agent Event Log</span>
<div class="ev-filters">
<button class="ev-filter on" data-filter="all" onclick="setFilter('all',this)">All</button>
<button class="ev-filter" data-filter="SETTLE" onclick="setFilter('SETTLE',this)">Settlements</button>
<button class="ev-filter" data-filter="EXPIRE" onclick="setFilter('EXPIRE',this)">Expirations</button>
<button class="ev-filter" data-filter="ERROR" onclick="setFilter('ERROR',this)">Errors</button>
</div>
</div>
<div class="ev-body" id="fullLog"></div>
</div>
</div>

<div class="panel" id="panel-about">
<div class="about-card">
<h3>VEIL Protocol — T3N Verifiable Agent</h3>
<p>VEIL is an autonomous Credit Default Swap settlement agent on <strong>Arbitrum Sepolia</strong>. It monitors CDS positions every 30 seconds, triggers settlements when Chainlink ETH/USD price hits trigger levels, and expires matured contracts — all with <strong>cryptographically verifiable identity</strong> via Terminal 3's T3N network.</p>
<p>Every settlement and expiration is attested with a <code>did:t3n:...</code> identity that's hardware-verified inside a TEE. This means even if the agent's private key is compromised, an attacker cannot forge attestations.</p>
<p style="margin-top:12px"><strong>Agent Wallet:</strong> <code id="aboutWallet">---</code></p>
<p><strong>T3N Identity:</strong> <code id="aboutDid">---</code></p>
<p><strong>CDS Contract:</strong> <code id="aboutCds">---</code></p>
<p><strong>RPC:</strong> <code id="aboutRpc">---</code></p>
</div>
</div>
</main>
<footer>VEIL Protocol · Autonomous CDS Settlement Agent · T3N Verifiable Identity · Built for Terminal 3 Agent Dev Kit Challenge</footer>
<script>
let currentTab='overview',currentFilter='all';

function switchTab(t){currentTab=t;document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.textContent.toLowerCase().startsWith(t)||(t==='positions'&&b.textContent.includes('CDS'))||(t==='events'&&b.textContent.includes('Event'))||(t==='about'&&b.textContent.includes('About'))));document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='panel-'+t))}

function setFilter(f,btn){currentFilter=f;document.querySelectorAll('.ev-filter').forEach(b=>b.classList.remove('on'));btn.classList.add('on');renderEvents()}

let data=null;

function fmtAddr(a){return a?a.slice(0,6)+'...'+a.slice(-4):'---'}
function fmtTime(ts){if(!ts)return'';const d=new Date(ts);return d.toLocaleTimeString()}
function fmtUptime(s){const m=Math.floor(s/60),h=Math.floor(m/60),d=Math.floor(h/24);if(d>0)return d+'d '+h%24+'h';if(h>0)return h+'h '+m%60+'m';return m+'m '+s%60+'s'}

function statusLabel(s){
  switch(s){case 0:return'<span class="status-tag status-active">Active</span>';case 1:return'<span class="status-tag status-settled">Settled</span>';case 2:return'<span class="status-tag status-expired">Expired</span>';case 3:return'<span class="status-tag status-cancelled">Cancelled</span>';default:return s}
}

function renderEvents(){
  if(!data)return;
  const allEvents=data.events||[];
  const filtered=currentFilter==='all'?allEvents:allEvents.filter(e=>e.includes(currentFilter));
  const html=filtered.slice(0,50).map(e=>{
    let cls='info';
    if(e.includes('SETTLED'))cls='settle';
    else if(e.includes('EXPIRED'))cls='expire';
    else if(e.includes('ERROR'))cls='error';
    return'<div class="ev-line '+cls+'"><span class="ts">'+e.slice(1,20)+'</span><span>'+e.slice(22)+'</span></div>'
  }).join('')||'<div class="ev-line info"><span class="ts">--</span><span>Waiting for events...</span></div>';
  document.getElementById('fullLog').innerHTML=html;
  document.getElementById('miniLog').innerHTML=html;
}

function renderPositions(){
  if(!data||!data.cdsPositions||data.cdsPositions.length===0){
    document.getElementById('posBody').innerHTML='';
    document.getElementById('posEmpty').style.display='block';
    document.getElementById('posCount').textContent='';
    return;
  }
  document.getElementById('posEmpty').style.display='none';
  document.getElementById('posCount').textContent=data.cdsPositions.length+' position'+(data.cdsPositions.length>1?'s':'');
  document.getElementById('posBody').innerHTML=data.cdsPositions.map(p=>'<tr><td>#'+p.id+'</td><td class="addr"><a href="https://sepolia.arbiscan.io/address/'+p.buyer+'" target="_blank">'+fmtAddr(p.buyer)+'</a></td><td class="addr">'+fmtAddr(p.seller)+'</td><td>'+p.triggerPrice+'</td><td>'+statusLabel(p.status)+'</td></tr>').join('');
}

async function refresh(){
  try{
    const[statusRes,cdsRes]=await Promise.all([fetch('/status'),fetch('/cds')]);
    const s=await statusRes.json();
    data=s;
    data.cdsPositions=(await cdsRes.json()).positions||[];
    // Cards with pulse-on-change
    const setVal=(id,val)=>{const el=document.getElementById(id);if(el.textContent!==val){el.textContent=val;el.style.transform='scale(1.08)';setTimeout(()=>el.style.transform='',200)}}
    setVal('vPrice','$'+s.lastPriceUSD);
    el('vPriceTime',s.lastIterationAt?fmtTime(s.lastIterationAt):'');
    setVal('vActive',String(s.activeCDS));
    el('vTotal','of '+s.totalCDS+' total');
    setVal('vSettled',String(s.settledCount));
    setVal('vExpired',String(s.expiredCount));
    el('vIter',String(s.iterations));
    const runningSec=Math.floor((Date.now()-new Date(s.startTime).getTime())/1000);
    el('vUptime','Uptime: '+fmtUptime(Math.max(runningSec,0)));
    el('vErrors',String(s.errors||0));
    // Badges
    el('liveBadge','<span class="status-dot"></span>AGENT LIVE · '+fmtUptime(Math.max(runningSec,0)));
    el('t3nBadge',s.t3nDid?'T3N: '+s.t3nDid.slice(0,24)+'...':'T3N: DISABLED');
    // About
    el('aboutWallet',s.wallet||'---');
    el('aboutDid',s.t3nDid||'---');
    el('aboutCds',s.cdsAddress||'---');
    el('aboutRpc',s.rpcUrl||'---');
    // Render
    renderEvents();
    renderPositions();
  }catch(e){console.error('Dashboard fetch error:',e)}
}
function el(id,h){document.getElementById(id).innerHTML=h}
refresh();
setInterval(refresh,2000);
</script>
</body>
</html>`;
}

// — HTTP Server —

function startStatusServer() {
  const server = http.createServer((req, res) => {
    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
    if (req.url === "/status") {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, ...stats }, null, 2));
    } else if (req.url === "/cds") {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, positions: stats.cdsPositions }, null, 2));
    } else if (req.url === "/" || req.url === "/dashboard") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(dashboardHTML());
    } else {
      res.writeHead(404, headers);
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