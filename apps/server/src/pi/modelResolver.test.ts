import { describe,it,expect } from "vitest";
import { makeModelResolver } from "./modelResolver.js";
import { buildModelSource } from "./providerFromProfile.js";
import type { Database } from "../db/index.js";
import type { ModelSource } from "../agent/roles.js";
describe("model profiles",()=>{
 it.each([["openai","openai-completions"],["anthropic","anthropic-messages"],["openai-responses","openai-responses"]])("uses native %s adapter",async(format,api)=>{
  const source=await buildModelSource({id:1,name:"fixture",model:"fixture",baseURL:"http://127.0.0.1:1",apiKey:"test",contextWindowK:128,maxTokens:1024,format});
  expect(source.model.api).toBe(api);expect(source.thinkingLevel).toBe("off");
 });
});
