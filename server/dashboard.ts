// The live /dashboard: a public aggregate view and an admin detail view, over Server-Sent Events.
// Privacy rule: players only ever see plain names. Everything per-player (who, rows, events) is admin-only.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LogEvent } from "../shared/events.ts";
import type { EventLog } from "./log.ts";
import type { ConnInfo, ServerSummary } from "./main.ts";

/** Public streams; a reload storm from viewers can't pile up timers past this. */
export const MAX_STREAMS = 8;
/** Admin streams have their own allowance, so a full public cap never locks the admin out. */
export const MAX_ADMIN_STREAMS = 4;
const SUMMARY_MS = 1000;
const KEEPALIVE_MS = 15_000;
const BACKLOG = 200;

export interface DashboardDeps {
  log: EventLog;
  summary(): ServerSummary;
  connections(): ConnInfo[];
  recentAchievements(): { who: string; achievement: string; world: number | null; tick: number | null; at: number }[];
  /** Short build hash shown in the header. */
  build: string;
  /** Unset or empty disables the admin view. */
  adminToken?: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest();

export function createDashboard(deps: DashboardDeps) {
  const token = deps.adminToken ? sha(deps.adminToken) : null;
  const streams = new Map<ServerResponse, () => void>();
  const adminStreams = new Set<ServerResponse>();

  /** Constant-time check over digests, so a length difference can't throw or leak. Disabled when no token is set. */
  const isAdmin = (req: IncomingMessage): boolean => {
    if (!token) return false;
    const auth = String(req.headers.authorization ?? "");
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : (new URL(req.url ?? "/", "http://x").searchParams.get("token") ?? "");
    if (given === "") return false;
    return timingSafeEqual(sha(given), token);
  };

  function stream(req: IncomingMessage, res: ServerResponse): void {
    const admin = isAdmin(req);
    const full = admin ? adminStreams.size >= MAX_ADMIN_STREAMS : streams.size - adminStreams.size >= MAX_STREAMS;
    if (full) {
      res.writeHead(503, { "retry-after": "5" }).end("too many streams");
      return;
    }
    if (admin) adminStreams.add(res);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no", connection: "keep-alive" });
    const write = (chunk: string) => {
      if (!res.writableEnded) res.write(chunk);
    };
    const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const tick = () => {
      send("summary", deps.summary());
      if (admin) {
        send("conns", deps.connections());
        send("achievements", deps.recentAchievements());
      }
    };
    let unsub: (() => void) | undefined;
    if (admin) {
      send("backlog", deps.log.recent(BACKLOG));
      unsub = deps.log.subscribe((e: LogEvent) => send("log", e));
    }
    tick();
    const iv = setInterval(tick, SUMMARY_MS);
    const ka = setInterval(() => write(": keepalive\n\n"), KEEPALIVE_MS);
    const done = () => {
      clearInterval(iv);
      clearInterval(ka);
      unsub?.();
      streams.delete(res);
      adminStreams.delete(res);
    };
    streams.set(res, done);
    res.on("close", done);
  }

  return {
    isAdmin,
    /** Returns true when it handled the request. */
    handle(req: IncomingMessage, res: ServerResponse, path: string): boolean {
      if (path === "/dashboard") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(dashboardPage(deps.build));
        return true;
      }
      if (path === "/dashboard/stream") {
        stream(req, res);
        return true;
      }
      if (path === "/api/summary") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(deps.summary()));
        return true;
      }
      return false;
    },
    closeAll(): void {
      for (const [r, done] of [...streams]) {
        done();
        r.end();
      }
    },
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const CSS = `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0b0e14;color:#e6e9f0;font:14px/1.5 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px 16px 64px}a{color:#6ea8ff}h1{font-size:20px;margin:0}h2{font-size:15px;margin:22px 0 8px;border-top:1px solid #2a3142;padding-top:12px}
header{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline}.muted{color:#8b93a7}.ok{color:#5ad18a}.warn{color:#f0b429}.bad{color:#ff6b6b}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}.card{background:#151a24;border:1px solid #2a3142;border-radius:8px;padding:10px 12px}
.card h3{margin:0 0 6px;font-size:14px}dl{margin:0;display:grid;grid-template-columns:1fr auto;gap:2px 10px}dt{color:#8b93a7}dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}
.box{overflow-x:auto;border:1px solid #2a3142;border-radius:8px}table{border-collapse:collapse;width:100%;white-space:nowrap}th,td{padding:4px 8px;text-align:left;border-bottom:1px solid #1d2331}th{color:#8b93a7;font-weight:500}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}button{background:#3a1d22;color:#ffb3b3;border:1px solid #6b2a33;border-radius:6px;padding:4px 12px;font:inherit;cursor:pointer}select,input{background:#151a24;color:#e6e9f0;border:1px solid #2a3142;border-radius:6px;padding:4px 8px;font:inherit;max-width:100%}
#feed{font:12px/1.45 ui-monospace,monospace;max-height:420px;overflow:auto;border:1px solid #2a3142;border-radius:8px;padding:6px 8px}#feed div{white-space:pre-wrap;word-break:break-all}
.lvl-warn{color:#f0b429}.lvl-error{color:#ff6b6b}.lvl-debug{color:#8b93a7}[hidden]{display:none!important}`;

const JS = `
const $=(id)=>document.getElementById(id);
const token=new URLSearchParams(location.search).get("token")||"";
const MB=1048576,fmtMb=(n)=>n==null?"-":(n/MB).toFixed(1)+" MB";
function row(dl,k,v,cls){const dt=document.createElement("dt");dt.textContent=k;const dd=document.createElement("dd");dd.textContent=v;if(cls)dd.className=cls;dl.append(dt,dd)}
function meter(v,max,warn){return v>=max?"bad":v>=warn?"warn":"ok"}
function renderSummary(s){
  const w=$("worlds");w.replaceChildren();
  for(const x of s.worlds){const c=document.createElement("div");c.className="card";const h=document.createElement("h3");h.textContent=x.world===0?"Sandbox (world 0)":"Game (world "+x.world+")";const dl=document.createElement("dl");
    row(dl,"online",x.online);row(dl,"tick",x.lastTick);row(dl,"ticks/s",x.ticksPerSec);row(dl,"hash passed",x.hashPasses,"ok");row(dl,"hash failed",x.hashFails,x.hashFails?"bad":"");
    row(dl,"resyncs",x.resyncs);row(dl,"snapshots ok / rejected",x.snapshotsAccepted+" / "+x.snapshotsRejected,x.snapshotsRejected?"warn":"");
    row(dl,"last snapshot",(x.snapshotBytes/1024).toFixed(1)+" KB @ "+x.snapshotTick);row(dl,"last verify",x.lastVerifyMs+" ms");row(dl,"log since snapshot",x.ticksSinceSnapshot+" ticks",x.ticksSinceSnapshot>20000?"warn":"");c.append(h,dl);w.append(c)}
  const p=s.process,pc=$("proc");pc.replaceChildren();const dl=document.createElement("dl");
  row(dl,"achievements today",s.achievementsToday);row(dl,"RSS / 256 MB",p.rssMb+" MB",meter(p.rssMb,256,200));row(dl,"heap",p.heapMb+" MB");row(dl,"event-loop lag p99",p.lagP99Ms+" ms",p.lagP99Ms>50?"warn":"");
  if(p.dbBytes!=null){const t=p.dbBytes+(p.walBytes||0);row(dl,"db + wal / 1 GB",fmtMb(t),meter(t,1024*MB,700*MB))}
  pc.append(dl);$("uptime").textContent="up "+Math.floor(p.uptimeS/3600)+"h "+Math.floor(p.uptimeS/60)%60+"m "+p.uptimeS%60+"s";
}
function renderConns(list){
  $("admin").hidden=false;const tb=$("conns");tb.replaceChildren();
  for(const c of list){const tr=document.createElement("tr");
    const cells=[c.who,c.achievements,c.world,c.role,c.connectedS+"s",c.rttP95Ms==null?"-":c.rttP95Ms+" ms",c.tickLag==null?"-":c.tickLag,c.stepP95Ms==null?"-":c.stepP95Ms+" ms",c.buffered==null?"-":c.buffered,
      c.window.casts+"c "+c.window.paints+"p "+c.window.pos+"pos "+c.window.rejected+"rej",
      c.total.casts+"c "+c.total.paints+"p "+c.total.pos+"pos "+c.total.rejected+"rej "+c.total.resyncs+"rs"];
    for(const v of cells){const td=document.createElement("td");td.textContent=String(v);tr.append(td)}tb.append(tr)}
  $("nconns").textContent=list.length;
}
function renderAch(list){
  const tb=$("ach");tb.replaceChildren();
  for(const a of list){const tr=document.createElement("tr");
    for(const v of [a.who,a.achievement,a.world==null?"-":a.world,a.tick==null?"-":a.tick,new Date(a.at).toLocaleString()]){const td=document.createElement("td");td.textContent=String(v);tr.append(td)}tb.append(tr)}
  if(!list.length){const tr=document.createElement("tr");const td=document.createElement("td");td.colSpan=5;td.className="muted";td.textContent="none yet";tr.append(td);tb.append(tr)}
}
const feed=$("feed"),MAXROWS=300;
function passes(e){
  const w=$("fworld").value;if(w!=="all"&&String(e.world)!==w)return false;
  if($("fwarn").checked&&e.lvl!=="warn"&&e.lvl!=="error")return false;
  const q=$("fwho").value.trim().toLowerCase();if(q&&!String(e.who??"").toLowerCase().includes(q))return false;return true;
}
function line(e){
  const d=document.createElement("div");d.className="lvl-"+e.lvl;d._e=e;
  const rest=Object.entries(e).filter(([k])=>k!=="t"&&k!=="lvl"&&k!=="ev").map(([k,v])=>k+"="+v).join(" ");
  d.textContent=String(e.t).slice(11,23)+" "+String(e.lvl).padEnd(5)+" "+e.ev+" "+rest;d.hidden=!passes(e);return d;
}
function addLog(e){feed.prepend(line(e));while(feed.children.length>MAXROWS)feed.lastChild.remove()}
function refilter(){for(const d of feed.children)d.hidden=!passes(d._e)}
for(const id of ["fworld","fwarn","fwho"])$(id).addEventListener("input",refilter);
function connect(){
  const es=new EventSource("/dashboard/stream"+(token?"?token="+encodeURIComponent(token):""));
  es.onopen=()=>{$("conn").textContent="connected";$("conn").className="ok"};
  es.onerror=()=>{$("conn").textContent="reconnecting...";$("conn").className="warn"};
  es.addEventListener("summary",(m)=>renderSummary(JSON.parse(m.data)));
  es.addEventListener("conns",(m)=>renderConns(JSON.parse(m.data)));
  es.addEventListener("achievements",(m)=>renderAch(JSON.parse(m.data)));
  es.addEventListener("backlog",(m)=>{feed.replaceChildren();for(const e of JSON.parse(m.data))addLog(e)});
  es.addEventListener("log",(m)=>addLog(JSON.parse(m.data)));
}
function status(msg,cls){const s=$("rstatus");s.textContent=msg;s.className=cls||"muted"}
async function resetWorld(world,name){
  if(!confirm("Reset the "+name+" world to its generated start? Everyone connected is disconnected and the world's history is deleted. Players and stats are kept."))return;
  if(prompt('Type "'+name+'" to confirm the reset.')!==name){status("Reset cancelled.");return}
  status("Resetting "+name+"...","warn");
  try{
    const r=await fetch("/api/admin/reset",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({world})});
    const j=await r.json().catch(()=>({}));
    if(r.ok)status("Reset "+name+" at "+new Date().toLocaleTimeString()+" (was at tick "+j.oldTick+").","ok");else status("Reset refused: HTTP "+r.status+(j.error?" "+j.error:""),"bad");
  }catch(e){status("Reset failed: "+e,"bad")}
}
$("rsand").addEventListener("click",()=>resetWorld(0,"sandbox"));
$("rgame").addEventListener("click",()=>resetWorld(1,"game"));
connect();
`;

function dashboardPage(build: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dashboard</title><style>${CSS}</style></head><body><main>
<header><h1>Dashboard</h1><span class="muted">build ${esc(build)}</span><span id="uptime" class="muted"></span><span id="conn" class="warn">connecting...</span><a href="/">game</a></header>
<h2>Worlds</h2><div id="worlds" class="grid"></div>
<h2>Process</h2><div id="proc" class="card"></div>
<section id="admin" hidden><h2>Connections (<span id="nconns">0</span>)</h2>
<div class="box"><table><thead><tr><th>who</th><th>ach.</th><th>world</th><th>role</th><th>for</th><th>rtt p95</th><th>tick lag</th><th>step p95</th><th>buffered</th><th>window</th><th>session</th></tr></thead><tbody id="conns"></tbody></table></div>
<h2>Recent achievements</h2>
<div class="box"><table><thead><tr><th>who</th><th>achievement</th><th>world</th><th>tick</th><th>when</th></tr></thead><tbody id="ach"></tbody></table></div>
<h2>Reset a world</h2><p class="muted">Returns one world to its generated start and disconnects everyone in it (they reconnect on their own). Players, names and stats are kept.</p>
<div class="filters"><button id="rsand" type="button">Reset sandbox</button><button id="rgame" type="button">Reset game world</button><span id="rstatus" class="muted"></span></div>
<h2>Events</h2><div class="filters"><select id="fworld"><option value="all">all worlds</option><option value="0">world 0</option><option value="1">world 1</option></select>
<label><input type="checkbox" id="fwarn"> warnings and errors</label><input id="fwho" placeholder="who contains" aria-label="who contains"></div><div id="feed"></div></section>
</main><script>${JS}</script></body></html>`;
}
