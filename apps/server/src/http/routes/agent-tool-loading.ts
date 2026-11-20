import type {FastifyInstance} from 'fastify';
import {builtinDefinitions,previewRoleTools} from '../../agent/tool-catalog.js';
import {isCoreTool,TOOL_ALIASES,toolIdentity} from '../../agent/tool-registry.js';
import {nativeToolRejection} from '../../agent/native-tools.js';
import {parseToolLoadingOverrides,readToolLoadingOverrides,toolLoadingSettingKey} from '../../agent/tool-loading-preferences.js';
import {assertActiveRole} from '../../agent/retired-roles.js';
import {platformPolicy} from '../../pi/platform-policy.js';

export function registerAgentToolLoadingRoutes(app:FastifyInstance) {
  async function read(role:string) {
    const overrides=await readToolLoadingOverrides(app.db,role);
    const preview=await previewRoleTools(app.db,role);
    const definitions=builtinDefinitions(app.db),rows=(await app.db.query('SELECT key,kind FROM tools')).rows;
    const editable_tools=[...new Set([...definitions.keys(),...rows.map(r=>String(r.key))])].filter(name=>
      name!=='tool_search'&&!name.startsWith('mcp__')&&!nativeToolRejection(role,name)&&
      toolIdentity(name,String(rows.find(r=>r.key===name)?.kind??'builtin')).implementation_status==='active');
    return {overrides,resident:preview.resident,deferred:preview.deferred,
      editable_tools,
      default_mode:preview.platform_policy.builtinLoading==='direct'?'resident':'deferred',
      default_resident:[...definitions.keys()].filter(name=>isCoreTool(role,name)||!!TOOL_ALIASES[name]),
      fallback:preview.fallback??null,applies_on:'next_run'};
  }
  app.get('/api/agents/:key/tool-loading',async(req,reply)=>{
    const role=(req.params as {key:string}).key;assertActiveRole(role);
    if(!await app.db.platform().getAgentByKey(role))return reply.code(404).send({error:'Agent 不存在'});
    return read(role);
  });
  app.put('/api/agents/:key/tool-loading',async(req,reply)=>{
    const role=(req.params as {key:string}).key;assertActiveRole(role);
    if(!await app.db.platform().getAgentByKey(role))return reply.code(404).send({error:'Agent 不存在'});
    const body=req.body as {overrides?:unknown}|null;
    let overrides;
    try{overrides=parseToolLoadingOverrides(body?.overrides);}catch(error){return reply.code(400).send({error:(error as Error).message});}
    const definitions=builtinDefinitions(app.db);
    const rows=(await app.db.query('SELECT key,kind FROM tools')).rows;
    const policy=await platformPolicy(app.db,role);
    for(const [name,mode] of Object.entries(overrides)) {
      const row=rows.find(r=>r.key===name),identity=toolIdentity(name,String(row?.kind??'builtin'));
      if(name==='tool_search'||identity.implementation_status==='compatibility')return reply.code(400).send({error:`${name} 使用固定加载规则，请配置规范工具入口`});
      if(name.startsWith('mcp__')||!row&&!definitions.has(name)||['retired','unsupported'].includes(identity.implementation_status))
        return reply.code(400).send({error:`工具 ${name} 不存在或不支持加载配置`});
      const rejection=nativeToolRejection(role,name);
      if(rejection)return reply.code(400).send({error:rejection});
      if(mode==='deferred'&&policy.fallback)
        return reply.code(400).send({error:'请先启用 tool_search 并绑定此 Agent，再设置按需检索工具'});
    }
    await app.db.transaction(async tx=>{
      if(!(await tx.query('SELECT id FROM agents WHERE key=$1 FOR UPDATE',[role])).rowCount)
        throw Object.assign(new Error('Agent 不存在或已删除'),{statusCode:404});
      await tx.platform().setSetting(toolLoadingSettingKey(role),JSON.stringify(overrides));
    });
    return read(role);
  });
}
