import fs from "node:fs";
// 夹具目录可覆盖：DOTD_FIXTURES=/path node refresh-fixtures.mjs
const DIR=process.env.DOTD_FIXTURES||"/tmp";
const now=Math.floor(Date.now()/1000);
const SKIP=new Set(["soak.jsonl"]);
let moved=0;
for(const f of fs.readdirSync(DIR)){
  if(!f.endsWith(".jsonl") || SKIP.has(f)) continue;
  const p=DIR+"/"+f;
  let raw; try{ raw=fs.readFileSync(p,"utf8"); }catch(e){ continue; }
  const lines=raw.split("\n").filter(Boolean);
  let recs=[], bad=0;
  for(const l of lines){ try{ recs.push(JSON.parse(l)); }catch(e){ bad++; } }
  if(bad) continue;
  const obs=recs.filter(r=>r.kind!=="probe" && r.alive===true && typeof r.ts==="number");
  if(!obs.length) continue;
  const last=Math.max(...obs.map(r=>r.ts));
  // 特意"过期"的夹具（reallystale 要用 6 小时前）跳过
  if(f==="reallystale.jsonl") continue;
  if(now-last<=5400) continue;
  const delta=now-300-last;
  for(const r of recs){
    if(typeof r.ts==="number") r.ts+=delta;
    if(typeof r.proc_start==="number") r.proc_start+=delta;
  }
  fs.writeFileSync(p, recs.sort((a,b)=>a.ts-b.ts).map(x=>JSON.stringify(x)).join("\n")+"\n");
  moved++;
}
console.log("  平移 "+moved+" 个夹具");
