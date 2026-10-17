import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openDatabase, type Database } from "../db/index.js";
import { Engine, defaultEngineConfig } from "./engine.js";
import { compactColdGraph } from "../agent/coldgraph.js";
import { roleResources } from "../agent/resources.js";
import type { ModelSource } from "../agent/roles.js";
let db: Database;
const dir = mkdtempSync(path.join(tmpdir(), "fate-regression-"));
const created: Array<{id:number;exploration_id:number}> = [];
const engines: Engine[] = [];
beforeAll(async () => {
  process.env.SERIES_PG_DSN = process.env.SERIES_TEST_PG_DSN ?? "postgres://series:series@127.0.0.1:5433/series_test?sslmode=disable";
  db = await openDatabase();
});
afterAll(async () => {
  for (const e of engines) await e.shutdown();
  for (const t of created) { await db.query("DELETE FROM tasks WHERE id=$1", [t.id]); await db.query("DELETE FROM explorations WHERE id=$1", [t.exploration_id]); }
  await db?.close(); rmSync(dir,{recursive:true,force:true});
});
async function task() { const t = await db.tasks().createTaskWithOptions("queue fixture", "", {}); created.push(t); return t; }
async function model(name: string) {
  const faux = fauxProvider({ provider: name });
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate:false }); await modelRuntime.registerNativeProvider(faux.provider);
  return { faux, source: {modelRuntime, model:faux.getModel() as never} satisfies ModelSource };
}
async function until(fn:()=>Promise<boolean>, ms=5000) {
  const end=Date.now()+ms;
  while(Date.now()<end) { if(await fn()) return; await new Promise((r)=>setTimeout(r,20)); }
  throw new Error("condition timed out");
}
describe("scheduler and graph regressions", () => {
  it("manual dispatch commits before wake; a single worker drains multiple intents without a 30s sleep", async () => {
    const t=await task(), s=db.exploration(t.exploration_id);
    await db.query("UPDATE tasks SET execution_mode='manual' WHERE id=$1",[t.id]);
    const ids=[await s.addIntent({summary:"first"},5,[],"user"),await s.addIntent({summary:"second"},5,[],"user")];
    const w=await model("reg-worker"), m=await model("reg-main");
    const e=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:5}, async(_,role)=>role==="worker"?w.source:m.source,dir); engines.push(e);
    w.faux.setResponses([fauxAssistantMessage("first complete"),fauxAssistantMessage("second complete")]);
    m.faux.setResponses([fauxAssistantMessage([fauxToolCall("dispatch_intents",{intent_ids:ids})]),fauxAssistantMessage("已下发")]);
    await e.mainChat(t.id,"执行队列");
    await until(async()=>(await s.listByKind("intent",10)).every((n)=>n.state==="done"));
    expect(w.faux.state.callCount).toBe(2);
    await e.stop(t.id);
  });
  it("chat on a paused task does not start workers and segments retain independent context", async () => {
    const t=await task(), s=db.exploration(t.exploration_id); await s.addIntent({summary:"must not run"},5,[],"user");
    await db.query("UPDATE tasks SET paused=true,status='paused' WHERE id=$1",[t.id]);
    const main=await model("reg-chat"), roles:string[]=[];
    const e=new Engine(db,defaultEngineConfig(),async(_,role)=>{ roles.push(role);return main.source; },dir); engines.push(e);
    main.faux.setResponses([fauxAssistantMessage("A"), (context)=>{
      expect(JSON.stringify(context.messages)).not.toContain("segment-one-secret");
      expect(JSON.stringify(context)).not.toContain('"name":"bash"');
      return fauxAssistantMessage("B");
    },(context)=>{ expect(JSON.stringify(context.messages)).toContain("segment-one-secret");return fauxAssistantMessage("A again"); }]);
    await e.mainChat(t.id,"segment-one-secret",1); await e.mainChat(t.id,"new segment",2); await e.mainChat(t.id,"remember",1);
    expect(roles).toEqual(["mainagent","mainagent","mainagent"]);
    expect((await s.listByKind("intent",10))[0]!.state).toBe("open");
    const activity=await db.query("SELECT kind,main_seg FROM activity WHERE exploration_id=$1 AND worker='main' ORDER BY id",[t.exploration_id]);
    expect(activity.rows.filter((r)=>r.kind==="user").map((r)=>r.main_seg)).toEqual([1,2,1]);
  });
  it("concurrent run requests start only one worker pool", async () => {
    const t=await task(), s=db.exploration(t.exploration_id); await s.addIntent({summary:"one"},5,[],"user");
    const w=await model("reg-once"); w.faux.setResponses([fauxAssistantMessage("complete")]);
    const e=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:5},async()=>w.source,dir); engines.push(e);
    await Promise.all([e.run(t.id),e.run(t.id),e.run(t.id)]);
    await until(async()=>(await s.listByKind("intent",10))[0]?.state==="done");
    expect(w.faux.state.callCount).toBe(1);await e.stop(t.id);
  });
  it("cold digests preserve original nodes, edges, anchors and invalidate on revival", async () => {
    const t=await task(), s=db.exploration(t.exploration_id);
    const asset=await db.assets().upsertRootDomain({domain:`cold-${t.id}.test`,taskID:t.id});
    const intent=await s.addIntent({summary:"completed evidence"},5,[asset],"user");
    const fact=await s.addNode("fact",{summary:"negative result"},0,"confirmed","worker",[asset]);
    await s.link(intent,"yields",fact);await s.setIntentState(intent,"done");
    for(let i=0;i<7;i++) await compactColdGraph(db,t.exploration_id);
    const digests=await s.listByKind("digest",10);expect(digests.filter((n)=>n.state==="active")).toHaveLength(1);
    const digest=digests.find((n)=>n.state==="active")!;
    expect(digest.payload.member_ids).toEqual([intent,fact]);expect(await s.anchorAssetIDs(digest.id)).toContain(asset);
    expect(await s.getNode(fact)).not.toBeNull();
    await s.setIntentState(intent,"open");
    expect((await s.getNode(digest.id))?.state).toBe("superseded");
    await db.query("DELETE FROM assets WHERE id=$1",[asset]);
  });
  it("MCP visibility is role scoped and refreshed between sessions", async () => {
    const id=await db.platform().saveMCP({id:0,name:"fixture-mcp",transport:"stdio",command:"node",args:[],env:{},url:"",enabled:true,insecure:false});
    try {
      expect((await roleResources(db,"worker")).mcpEntries?.some((e)=>e.name==="fixture-mcp")).toBe(false);
      await db.query("INSERT INTO agent_visibility(agent_id,resource_kind,resource_id,enabled) SELECT id,'mcp',$1,true FROM agents WHERE key='worker'",[id]);
      expect((await roleResources(db,"worker")).mcpEntries?.some((e)=>e.name==="fixture-mcp")).toBe(true);
      expect((await roleResources(db,"mainagent")).mcpEntries).toBeUndefined();
    } finally { await db.platform().deleteMCP(id); }
  });
});
