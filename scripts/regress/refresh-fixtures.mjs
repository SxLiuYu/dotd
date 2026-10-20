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

// **2026-10-20 第 108 轮补：把配套的 .log 一起对到新的 proc_start 上。**
// 原来只挪 .jsonl，于是 `nr.jsonl` 的 proc_start 到了 10-17 11:18，
// 而它的 `wd1.log` 还停在 10-17 09:52 —— 早了 1 小时 26 分，超出归因窗口
// `born-900 .. born+300`，用例 `重启有daemon记录` 就红了。
// 同一个坑还有 `oneboot-boot.log`（配 `oneboot.jsonl`）。
//
// 规律：**这些 .log 记录的是「每个 proc_start 处发生了一次自愈」**。
// 所以不去平移旧文本，而是按当前 proc_start 重新生成 —— 文本里的时间才好控制。
// 注意时间必须写成 **CST 本地时间**（soak.sh 的 parseLog 用无时区后缀解析 = 本地时区）。
const LOGFIX = {
  "wd1.log":            { jsonl: "nr.jsonl",      kind: "daemon", skipFirst: true  },
  "oneboot-boot.log":   { jsonl: "oneboot.jsonl", kind: "boot",   skipFirst: true  },
};
const cst = (t) => new Date((t + 8 * 3600) * 1000).toISOString().slice(0, 19).replace("T", " ");
for (const [logName, cfg] of Object.entries(LOGFIX)) {
  const jp = DIR + "/" + cfg.jsonl;
  let recs;
  try {
    recs = fs.readFileSync(jp, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) { continue; }
  const obs = recs.filter((r) => r.kind !== "probe" && typeof r.ts === "number");
  if (!obs.length) continue;
  const bounds = [...new Set(obs.map((r) => r.proc_start).filter((x) => typeof x === "number"))].sort((a, b) => a - b);
  const use = cfg.skipFirst ? bounds.slice(1) : bounds;
  if (!use.length) continue;
  const out = use.map((b) =>
    cfg.kind === "boot" ? cst(b + 4) + " daemon 就绪（4s）" : cst(b + 4) + " 自愈:daemon 已恢复(4s)",
  );
  fs.writeFileSync(DIR + "/" + logName, out.join("\n") + "\n");
  console.log("  重建 " + logName + "（" + out.length + " 条，对齐 " + cfg.jsonl + "）");
}

// `oneboot-nolog.log` 必须**保持空**（用例「重启无boot记录=人工」要求它空）
try {
  if (fs.existsSync(DIR + "/oneboot-nolog.log") && fs.readFileSync(DIR + "/oneboot-nolog.log", "utf8").trim() !== "") {
    fs.writeFileSync(DIR + "/oneboot-nolog.log", "");
    console.log("  清空 oneboot-nolog.log（用例要求它为空）");
  }
} catch (e) {}
try {
  if (fs.existsSync(DIR + "/nowd.log") && fs.readFileSync(DIR + "/nowd.log", "utf8").trim() !== "") {
    fs.writeFileSync(DIR + "/nowd.log", "");
    console.log("  清空 nowd.log");
  }
} catch (e) {}
try {
  if (fs.existsSync(DIR + "/noboot.log") && fs.readFileSync(DIR + "/noboot.log", "utf8").trim() !== "") {
    fs.writeFileSync(DIR + "/noboot.log", "");
    console.log("  清空 noboot.log");
  }
} catch (e) {}
