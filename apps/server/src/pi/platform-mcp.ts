import {createMcpExtension,createToolSearchExtension,type ExtensionAPI,type ExtensionFactory} from '@earendil-works/pi-coding-agent';
import {createServerTransport} from './mcpTransport.js';
import type {AgentRunnerOptions} from './runner.js';

export const MCP_RESOURCE_TOOLS=['list_mcp_resources','list_mcp_resource_templates','read_mcp_resource'];

export function hasDeferredMcp(opts:Pick<AgentRunnerOptions,'mcpEntries'>) {
  return opts.mcpEntries?.some(e=>e.config.exposure==='deferred'||Object.values(e.config.toolExposure??{}).includes('deferred'))??false;
}

/** Adapt native registration/discovery; pi retains connections, ranking, loading and tool execution. */
export function platformMcpExtension(opts:AgentRunnerOptions):ExtensionFactory {
  return async pi=>{
    const states=new Map<string,string>();
    const owners=new Map<string,{server:string;tool:string}>();
    const native=createMcpExtension({
      createTransport:(entry,cwd,auth)=>{
        const transport=createServerTransport(entry.config as unknown as Record<string,unknown>,cwd,auth);
        const pending=new Map<string,string>(),send=transport.send.bind(transport),start=transport.start.bind(transport);
        states.set(entry.name,'connecting');
        transport.start=async()=>{try{await start();}catch(error){states.set(entry.name,'failed');throw error;}};
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
          if(server&&definition.name.startsWith('mcp__')&&definition.label.startsWith(server+'/'))
            owners.set(definition.name,{server,tool:definition.label.slice(server.length+1)});
          target.registerTool(definition);
        });
        return Reflect.get(target,key);
      },
    }));
    pi.on('tool_call',async event=>{
      const owner=owners.get(event.toolName);
      if(owner)await opts.mcpGuard?.(owner.server,'tools/call',owner.tool);
    });
    if(!hasDeferredMcp(opts))return;
    let permitted=new Set<string>();
    await createToolSearchExtension()(new Proxy(pi,{
      get(target,key){
        if(key==='getAllTools')return ()=>target.getAllTools().filter(t=>!owners.has(t.name)||permitted.has(t.name));
        if(key==='registerTool')return ((definition:Parameters<ExtensionAPI['registerTool']>[0])=>{
          const execute=definition.execute;
          target.registerTool({...definition,description:definition.description+' 使用服务器名、工具名或英文关键词检索；只有获授权的工具会被加载。',
            execute:async(...args)=>{
              args[2]?.throwIfAborted();
              // The native MCP tool_call readiness hook has run before execute.
              const unavailable=[...states].filter(([,state])=>state!=='ready').map(([name])=>name);
              if(unavailable.length)throw new Error(`MCP 服务尚不可用，无法完成工具发现：${unavailable.join(', ')}`);
              const next=new Set<string>();
              for(const [name,owner] of owners){
                try{await opts.mcpGuard?.(owner.server,'tools/call',owner.tool);next.add(name);}catch{/* omit revoked bindings */}
              }
              permitted=next;
              // Loaded tools can outlive their binding in the transcript; remove current declarations too.
              target.setActiveTools(target.getActiveTools().filter(name=>!owners.has(name)||next.has(name)));
              return execute(...args);
            },
          });
        });
        return Reflect.get(target,key);
      },
    }));
  };
}
