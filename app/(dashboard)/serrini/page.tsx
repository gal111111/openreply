"use client";
import { useState } from "react";
export default function SerriniReplies() {
 const [account,setAccount]=useState("serrini666");
 const [manifest,setManifest]=useState("");
 const [result,setResult]=useState("");
 const [busy,setBusy]=useState(false);
 async function act(action:string) {
  setBusy(true);
  try {
   const res=await fetch("/api/instagram/serrini/reconcile",action==="status"?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({account,action,...(action==="prepare"?{resources:JSON.parse(manifest)}:{})})});
   setResult(JSON.stringify(await res.json(),null,2));
  } catch {setResult("檢查未完成，沒有確認送達；請查正式紀錄。");}
  finally {setBusy(false);}
 }
 return <div className="mx-auto max-w-4xl space-y-4 p-6"><h1 className="text-2xl font-semibold">Serrini 留言 → 私訊</h1><p>兩個帳號共用工作區；每支影片綁定自己的資源。先核對歷史，再啟用。私訊成功核實後才公開回覆「發給你啦／私信你啦」。</p><label>指定帳號 <select aria-label="指定帳號" value={account} onChange={e=>setAccount(e.target.value)}><option>serrini666</option><option>serrinion</option></select></label><label className="block">已核對的資源與歷史排除 JSON<textarea aria-label="資源及歷史排除 JSON" className="block h-40 w-full rounded border p-3" value={manifest} onChange={e=>setManifest(e.target.value)}/></label><div className="flex flex-wrap gap-3">{[["prepare","1 核對來源與匯入去重"],["activate","2 啟用對應活動"],["backfill","3 補發最多十則"],["status","查看實際紀錄"]].map(([a,label])=><button className="rounded border px-3 py-2" disabled={busy} key={a} onClick={()=>act(a)}>{label}</button>)}</div><pre aria-label="核對結果" className="max-h-[650px] overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-4 text-xs text-white">{busy?"核對中…":result}</pre></div>;
}
