import fs from "node:fs";
// 夹具目录可覆盖：DOTD_FIXTURES=/path node rebuild-heal-logs.mjs
const DIR=process.env.DOTD_FIXTURES||"/tmp";
const p2=n=>String(n).padStart(2,"0");
const fmt=ts=>{const d=new Date(ts*1000);return d.getFullYear()+"-"+p2(d.getMonth()+1)+"-"+p2(d.getDate())+" "+p2(d.getHours())+":"+p2(d.getMinutes())+":"+p2(d.getSeconds());};

// 对每个夹具，若身边有 .wd/.log 且含"自愈"，按它的段起点**重新生成**日志
for(const f of fs.readdirSync(DIR)){
  if(!f.endsWith(".jsonl") || f==="soak.jsonl") continue;
  const base=f.replace(/\.jsonl$/,"");
  const cands=[DIR+"/"+f+".wd",DIR+"/"+base+".wd",DIR+"/"+base+".log",DIR+"/"+base+"wd.log"];
  const lg=cands.find(c=>fs.existsSync(c));
  if(!lg) continue;
  const txt=fs.readFileSync(lg,"utf8");
  if(!/自愈/.test(txt)) continue;
  let recs; try{ recs=fs.readFileSync(DIR+"/"+f,"utf8").split("\n").filter(Boolean).map(JSON.parse); }catch(e){ continue; }
  const obs=recs.filter(r=>r.kind!=="probe"&&typeof r.proc_start==="number"&&r.alive===true).sort((a,b)=>a.ts-b.ts);
  if(!obs.length) continue;
  // 段起点（按出现顺序去重）
  const ps=[]; const seen=new Set();
  for(const s of obs){ if(!seen.has(s.proc_start)){ seen.add(s.proc_start); ps.push(s.proc_start); } }
  // 容器的自愈行单独保留（容器掉线用）
  const contHeal=txt.split("\n").filter(l=>/自愈/.test(l)&&!/daemon/.test(l));
  // 段 1..n 各写一条 daemon 自愈
  const lines=[];
  for(let i=1;i<ps.length;i++) lines.push(fmt(ps[i])+" 自愈:daemon 已恢复(30s)");
  if(lines.length || contHeal.length){
    fs.writeFileSync(lg, lines.concat(contHeal).join("\n")+"\n");
    console.log("  重写 "+lg+"  "+lines.length+" 条 daemon 自愈（段 "+ps.length+"）");
  }
}
