import {SDK_NATIVE_TOOLS,nativeToolRejection} from '../agent/native-tools.js';
import {createMcpExtension,createToolSearchExtension,type ExtensionAPI,type ExtensionFactory,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {toolIdentity,toolAllowedInSession} from '../agent/tool-registry.js';
import {discoverTools,discoveryReceipt,type DiscoveryArgs} from './tool-discovery.js';
import {createServerTransport} from './mcpTransport.js';
import type {AgentRunnerOptions} from './runner.js';

export const MCP_RESOURCE_TOOLS=['list_mcp_resources','list_mcp_resource_templates','read_mcp_resource'];
export const TOOL_SEARCH_HINT=' 已知完整工具名用 mode=exact 直接加载；已加载会明确返回。关键词用 mode=keyword，默认只加载 1 个，自动补充候选目录；按 next 翻页或用候选完整名称精确加载。mode=catalog 可枚举全部获授权工具，不加载 Schema。未授权、不存在和服务未就绪分别返回，不能把关键词未命中当作能力不存在。';
export const loadedToolReceipt=(names:string[])=>'已加载：'+names.join(', ')+'。参数与约束见下一轮工具声明。';

/** Catalog and execution share the same small discovery default. Search receipts
 * carry names only; full help already arrives in the next tool declaration. */
export function toolSearchDefinition(execute:ToolDefinition['execute']=async()=>{throw new Error('工具目录预览不能执行搜索');}):ToolDefinition {
  let definition!:ToolDefinition;
  createToolSearchExtension()({registerTool:(tool:ToolDefinition)=>{definition=tool;}} as ExtensionAPI);
  const parameters=structuredClone(definition.parameters) as any;
  parameters.properties.limit={type:'integer',minimum:1,maximum:20,default:1,description:'本页最多加载的工具数，默认 1；候选目录不加载 Schema。'};
  parameters.properties.mode={type:'string',enum:['auto','exact','keyword','catalog'],default:'auto',description:'exact 按完整名称查表加载；keyword 关键词加目录兜底；catalog 只列目录；auto 自动识别。'};
  parameters.properties.offset={type:'integer',minimum:0,description:'候选目录分页偏移；将 next 原样传入。'};
  parameters.properties.catalog_version={type:'string',description:'候选目录版本；翻页沿用 next，变化时按回执从首页重读。'};
  return {...definition,parameters,description:definition.description+TOOL_SEARCH_HINT,
    prepareArguments(input){
      const args=definition.prepareArguments?definition.prepareArguments(input):input;
      if(args&&typeof args==='object')for(const field of ['limit','offset'] as const){
        const value=(args as Record<string,unknown>)[field];
        if(value!==undefined&&(!Number.isSafeInteger(value)||Number(value)<(field==='limit'?1:0)||field==='limit'&&Number(value)>20))
          throw new Error(`tool_search.${field} 必须为${field==='limit'?' 1–20 的':'非负'}整数；不能使用小数或字符串`);
      }
      return args;
    },
    executionMode:'sequential',
    execute,
  };
}

/** Stable per-session instructions for custom system prompts, which bypass pi's
 * default tool guidance. Names come only from the permitted registration set. */
export function toolDiscoveryInstructions(opts:Pick<AgentRunnerOptions,'toolLoading'|'mcpEntries'>){
  const mcpGuidance=opts.mcpEntries?.length?'\n<mcp_authorization>管理员已显式启用并绑定本会话的 MCP。这些 MCP 是当前角色获授权可直接调用的能力：按用户目标及角色职责发现和使用，不能仅因工具来自 MCP 就转交给其他 Agent。规划所需的资料查询、本地辅助或用户明确要求的 MCP 调用可自行完成；任务范围、工具权限与关闭/解绑检查仍然适用。Skill 中提及但未绑定的 MCP 不因此获得权限。</mcp_authorization>\n':'';
  if(!opts.toolLoading?.deferred.length&&!hasDeferredMcp(opts))return mcpGuidance;
  const names=[...opts.toolLoading?.deferred??[]].sort();
  return '\n<tool_loading>\n以本轮工具声明为当前可调用集合；提示词、Skill、黑板或旧会话提到工具名不代表已激活。'+TOOL_SEARCH_HINT+' 禁用或撤销的能力不能恢复。'+(opts.toolLoading?.idleToolRequests?' 平台按需工具闲置后会退出声明；再次需要时精确检索，连续调用无需重新加载。':'')+(names.length?' 本会话获准的平台按需工具：'+names.join(', ')+'。':'')+'\n</tool_loading>'+mcpGuidance;
}

export function hasDeferredMcp(opts:Pick<AgentRunnerOptions,'mcpEntries'>) {
  return opts.mcpEntries?.some(e=>e.config.exposure==='deferred'||Object.values(e.config.toolExposure??{}).includes('deferred'))??false;
}

export function declaredToolNames(opts:Pick<AgentRunnerOptions,'toolAllowlist'|'mcpEntries'|'toolLoading'|'mcpResourceTools'>){
  return [...new Set([...(opts.toolAllowlist??[]),...(hasDeferredMcp(opts)||opts.toolLoading?.deferred.length?['tool_search']:[]),
    ...(opts.mcpEntries?.length&&opts.toolAllowlist?.includes('mcp__*')?(opts.mcpResourceTools??MCP_RESOURCE_TOOLS):[])])];
}

/** PI owns MCP registration and execution; discovery adds exact lookup and bounded fallback. */
export function platformMcpExtension(opts:AgentRunnerOptions):ExtensionFactory {
  return async pi=>{
    const declared=declaredToolNames(opts);
    const states=new Map<string,string>((opts.mcpEntries??[]).map(e=>[e.name,'connecting']));
    const owners=new Map<string,{server:string;tool:string}>();
    const native=createMcpExtension({
      createTransport:(entry,cwd,auth)=>{
        const transport=createServerTransport(entry.config as unknown as Record<string,unknown>,cwd,auth);
        const pending=new Map<string,string>(),send=transport.send.bind(transport),start=transport.start.bind(transport);
        states.set(entry.name,'connecting');
        transport.start=async()=>{try{await opts.mcpGuard?.(entry.name,'initialize');await start();}catch(error){states.set(entry.name,'failed');throw error;}};
        transport.onError(()=>states.set(entry.name,'failed'));
        transport.onClose(()=>states.set(entry.name,'disconnected'));
        transport.onMessage(message=>{
          if(!('id' in message)||message.id==null)return;
          const method=pending.get(String(message.id));pending.delete(String(message.id));
          if(method==='tools/list')states.set(entry.name,'error' in message?'failed':'ready');
          if(method==='initialize'){
            if('error' in message)states.set(entry.name,'failed');
            else if('result' in message){
              const result=message.result as {capabilities?:{tools?:unknown}};
              // Resource-only MCP servers never send tools/list; initialization completes readiness.
              if(!result?.capabilities?.tools)states.set(entry.name,'ready');
            }
          }
        });
        transport.send=async(message,options)=>{
          if('method' in message){
            const m=message as {method:string;params?:{name?:string};id?:unknown};
            await opts.mcpGuard?.(entry.name,m.method,m.params?.name);
            if(m.id!=null)pending.set(String(m.id),m.method);
          }
          try{return await send(message,options);}catch(error){states.set(entry.name,'failed');throw error;}
        };
        return transport;
      },
      loadConfig:()=>({servers:(opts.mcpEntries??[]).map(e=>({name:e.name,config:e.config as never,source:'series-db',scope:'extension' as const})),errors:[]}),
    });
    await native(new Proxy(pi,{
      get(target,key){
        if(key==='registerTool')return ((definition:Parameters<ExtensionAPI['registerTool']>[0])=>{
          const server=definition.namespace?.aliases?.[0];
          if(server&&definition.name.startsWith('mcp__')&&definition.label.startsWith(server+'/')){
            const owner={server,tool:definition.label.slice(server.length+1)};
            owners.set(definition.name,owner);opts.resourceOwners?.set(definition.name,owner);
          }
          target.registerTool(definition);
        });
        return Reflect.get(target,key);
      },
    }));
    pi.on('tool_call',async event=>{
      const owner=owners.get(event.toolName);
      if(owner)await opts.mcpGuard?.(owner.server,'tools/call',owner.tool);
    });
    if(!hasDeferredMcp(opts)&&!opts.toolLoading?.deferred.length)return;
    pi.registerTool(toolSearchDefinition(async(...args)=>{
      args[2]?.throwIfAborted();
      // The native MCP tool_call readiness hook has run before execute.
      const unavailable=[...states].filter(([,state])=>state!=='ready').map(([name])=>name);
      const next=new Set<string>(),denied=new Set<string>(),notReady=new Set<string>();
      const tools=pi.getAllTools();
      for(const t of tools){
        if(opts.toolAllowlist&&!toolAllowedInSession(t.name,declared,opts.platform?.role,opts.platform?opts.platform.taskID>0:true)){denied.add(t.name);continue;}
        const owner=owners.get(t.name);
        try{
          if(owner){await opts.mcpGuard?.(owner.server,'tools/call',owner.tool);if(states.get(owner.server)!=='ready'){notReady.add(t.name);continue;}}
          else await opts.discoveryGuard?.(t.name);
          next.add(t.name);
        }catch{denied.add(t.name);}
      }
      // Loaded tools can outlive their binding in the transcript; remove current declarations too.
      pi.setActiveTools(pi.getActiveTools().filter(name=>next.has(name)));
      const found=await discoverTools(args[1] as DiscoveryArgs,{tools,active:pi.getActiveTools(),denied,unavailable:notReady,
        known:name=>SDK_NATIVE_TOOLS.includes(name)||toolIdentity(name).implementation_status!=='unsupported'||(opts.toolAllowlist??[]).includes(name),
        reason:name=>nativeToolRejection(opts.platform?.role,name,opts.platform?opts.platform.taskID>0:true),unavailableServers:unavailable});
      args[2]?.throwIfAborted();
      if(found.loaded.length)pi.setActiveTools([...new Set([...pi.getActiveTools(),...found.loaded])]);
      const result=discoveryReceipt(found);
      return unavailable.length?{...result,content:[...result.content,{type:'text' as const,text:`MCP 发现未完成（服务不可用或仍连接中）：${unavailable.join(', ')}。以上匹配仅涵盖当前可用工具，不能据此认定这些 MCP 没有工具；稍后重试。`}]}:result;
    }));
  };
}
