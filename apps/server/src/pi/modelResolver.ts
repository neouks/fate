import { createHash } from "node:crypto";
import type { Database } from "../db/index.js";
import type { ModelResolver } from "../engine/engine.js";
import type { ModelSource } from "../agent/roles.js";
import { buildModelSource } from "./providerFromProfile.js";

/** Resolve every run; cache only the immutable provider built from the complete profile. */
export function makeModelResolver(db: Database, build = buildModelSource): ModelResolver {
  const cache = new Map<string, Promise<ModelSource>>();
  return async (taskID, role) => {
    const task = await db.tasks().getTask(taskID);
    const agent = await db.query<{ id: number }>(`SELECT llm_profile_id AS id FROM agents WHERE key=$1`, [role]);
    const id = task?.active_llm_profile_id ?? task?.llm_profile_id ?? agent.rows[0]?.id;
    const profile = id ? await db.platform().profileByID(Number(id)) : await db.platform().activeProfile();
    if (!profile) throw new Error(id ? `LLM 配置 #${id} 不存在` : "未配置激活的 LLM profile");
    const key = createHash("sha256").update(JSON.stringify(profile)).digest("hex");
    let source = cache.get(key);
    if (!source) {
      if (cache.size >= 32) cache.clear();
      source = build(profile);
      cache.set(key, source);
      source.catch(() => cache.delete(key));
    }
    return source;
  };
}
