import fs from "node:fs";
// 7 天夹具必须是 337 个点（336 个 30 分钟间隔 = 168.00h）
// 这个教训已经踩过两次（R45、R73），这次直接做成工具。
export function mk7d(file, opts={}){
  const now=Math.floor(Date.now()/1000);
  const N=337, last=now-(opts.tailSec||300), first=last-(N-1)*1800;
  const WANT={0:"OK",1:"-55",2:"350",3:"2176782336"};
  const out=[];
  for(let i=0;i<N;i++){
    const r={ts:first+i*1800, alive:true,
      rss_kb:(opts.rss?opts.rss(i,N):200*1024),
      fd:(opts.fd?opts.fd(i,N):27),
      threads:11,
      container_up:(opts.contUp?opts.contUp(i,N):1),
      container_ok:(opts.contOk?opts.contOk(i,N):1),
      relay_up:(opts.relayUp?opts.relayUp(i,N):1),
      http_ok:(opts.httpOk?opts.httpOk(i,N):1),
      db_kb:17000, pid:opts.pid||999,
      proc_start:(opts.procStart?opts.procStart(i,N,first):first),
      // 采集这批数据的脚本指纹。默认全程同一版本（=「这 7 天用同一把尺子」）。
      // 要模拟「中途换了判据」就传 opts.sv=(i,N)=> i<100?"aaaaaaaa":"bbbbbbbb"。
      sv:(opts.sv?opts.sv(i,N):"aaaaaaaa")};
    if(opts.extra) Object.assign(r, opts.extra(i,N));
    out.push(r);
  }
  let k=0;
  for(let t=first+900;t<=last-900;t+=21600){
    out.push({ts:t,kind:"probe",ok:opts.probeOk?opts.probeOk(k):true,
      taskId:"tk_"+k,status:"done",secs:opts.probeSecs?opts.probeSecs(k):8,
      slot:String(k%4),want:WANT[k%4],
      out:opts.probeOk&&!opts.probeOk(k)?"0":"1",
      ws:opts.probeOk&&!opts.probeOk(k)?"0":"1"});
    k++;
  }
  out.sort((a,b)=>a.ts-b.ts);
  fs.writeFileSync(file, out.map(x=>JSON.stringify(x)).join("\n")+"\n");
  return {n:N, probes:k, first, last, days:((last-first)/86400).toFixed(3)};
}
