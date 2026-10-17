import { afterEach, describe, expect, it, vi } from "vitest";
import { Interceptor } from "../db/intercept.js";
import { interceptGate } from "./gate.js";
import type { Database } from "../db/index.js";
afterEach(()=>vi.restoreAllMocks());
describe("approval cancellation",()=>{
 it("cancels the pending approval promptly when its agent is aborted",async()=>{
  vi.spyOn(Interceptor.prototype,"isToolEnabled").mockResolvedValue(true);
  vi.spyOn(Interceptor.prototype,"match").mockResolvedValue({action:"ask",ruleID:1,ruleName:"test",message:"review",timeoutEnabled:false,timeoutSeconds:0,timeoutAction:"deny"} as never);
  let created=false;const decided:unknown[]=[];
  const store={createInterceptPending:async()=>{created=true;return 1;},decideInterceptPending:async(...args:unknown[])=>{decided.push(args);}};
  const db={interceptStore:()=>store} as unknown as Database;
  const controller=new AbortController();
  const pending=interceptGate(db,{taskID:1,agentName:"worker"})({toolCallId:"id",toolName:"bash",args:{command:"echo fixture"},signal:controller.signal});
  while(!created)await new Promise((r)=>setTimeout(r,1));
  controller.abort();
  await expect(pending).resolves.toMatchObject({block:true});
  expect(decided).toEqual([[1,"denied"]]);
 });
});
