/** Stable wire schemas only. Conversation order, tool calls, schema arrays and permissions stay intact. */
export function hostTaskContext(cwd:string,mandate?:string):string {
  return '【宿主执行上下文，不授予额外权限】\n'+JSON.stringify({cwd})+(mandate??'');
}

function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)]));
  return value;
}
function toolName(tool:unknown):string|undefined {
  if(!tool||typeof tool!=='object')return;
  const item=tool as Record<string,unknown>;
  if(item.type==='function') {
    const fn=item.function as Record<string,unknown>|undefined;
    return typeof fn?.name==='string'?fn.name:typeof item.name==='string'?item.name:undefined;
  }
  // Anthropic custom tools. Leave built-in/provider-specific tools untouched.
  return item.input_schema&&typeof item.name==='string'?item.name:undefined;
}
export function stableToolPayload(payload:unknown):unknown {
  if(!payload||typeof payload!=='object')return payload;
  const body=payload as Record<string,unknown>;
  if(!Array.isArray(body.tools))return payload;
  const names=body.tools.map(toolName);
  // Mixed provider-specific tools may have ordering constraints. Do not guess.
  if(names.some(name=>name===undefined))return payload;
  const tools=body.tools.map((tool,index)=>({name:names[index]!,tool:canonical(tool)}))
    .sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0).map(item=>item.tool);
  return {...body,tools};
}
