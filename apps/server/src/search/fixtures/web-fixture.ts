import type {Database} from '../../db/index.js';
import {WEB_ACCESS_SETTING,type WebAccessConfig} from '../web-access-config.js';
export function webFixture() {
  const config: WebAccessConfig = { sources: ['deepseek'], default_source: 'deepseek', keys: { deepseek: 'synthetic-before' }, searxng_url: '', proxy: '' };
  const settings = new Map([[WEB_ACCESS_SETTING, JSON.stringify(config)], ['web_search_enabled','true']]);
  const agents = [{key:'worker',name:'Worker',webSearch:true,enabled:true},{key:'planner',name:'Planner',webSearch:false,enabled:true}];
  const disabled = new Set<string>();
  const db = {
    platform: () => ({ getSetting: async (key: string) => settings.get(key) ?? '', setSetting: async (key: string,value: string) => { settings.set(key,value); }, getBool: async (key: string) => settings.get(key)==='true', getAgentByKey: async (key:string) => agents.find(a=>a.key===key), listAgents: async()=>agents }),
    query: async (sql: string,args?: unknown[]) => {
      if(sql.startsWith('UPDATE agents SET web_search'))for(const agent of agents)agent.webSearch=(args![0] as string[]).includes(agent.key);
      return {rows: sql.startsWith('SELECT enabled,agents') ? [{enabled:!disabled.has(String(args?.[0])),agents:agents.map(a=>a.key)}] : []};
    },
    transaction: async (fn: (db:Database)=>Promise<unknown>) => fn(db as unknown as Database),
  } as unknown as Database;
  return {db,settings,config,disabled,agents};
}
