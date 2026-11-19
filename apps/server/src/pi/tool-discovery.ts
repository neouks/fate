import {createToolSearchExtension,type ExtensionAPI,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {createHash} from 'node:crypto';

export interface DiscoveryArgs {query:string;mode?:'auto'|'exact'|'keyword'|'catalog';limit?:number;offset?:number;catalog_version?:string;}
export interface DiscoveryTool {name:string;description:string;parameters:ToolDefinition['parameters'];exposure?:string;namespace?:ToolDefinition['namespace'];}
export interface DiscoverySnapshot {
  tools:DiscoveryTool[];active:string[];denied:Set<string>;unavailable:Set<string>;
  known:(name:string)=>boolean;reason?:(name:string)=>string|undefined;unavailableServers:string[];
}
export interface DiscoveryResult {
  status:'loaded'|'already_loaded'|'unauthorized'|'not_found'|'unavailable'|'candidates'|'catalog_changed';
  mode:'exact'|'keyword'|'catalog';loaded:string[];already_loaded:string[];
  message:string;name?:string;fallback?:'catalog';match_count?:number;
  candidates?:Array<{name:string;summary:string;active:boolean;matched:boolean}>;
  total_candidates?:number;has_more?:boolean;next?:DiscoveryArgs;unavailable_servers?:string[];catalog_version?:string;
}

/** Rank locally using PI's own metadata index, with activation captured rather
 * than applied. All matches are considered; only the requested count is loaded. */
async function rankTools(tools:DiscoveryTool[],query:string):Promise<string[]> {
  if(!tools.length)return [];
  let search!:ToolDefinition;
  await createToolSearchExtension()({
    registerTool:(tool:ToolDefinition)=>{search=tool;},
    getAllTools:()=>tools.map(tool=>({...tool,exposure:'deferred'})),
    getActiveTools:()=>[],setActiveTools:()=>{},
  } as unknown as ExtensionAPI);
  const result=await search.execute('local-rank',{query,limit:tools.length},undefined,undefined,{} as never);
  return (result.details as {loaded:string[]}).loaded;
}

export async function discoverTools(input:DiscoveryArgs,snapshot:DiscoverySnapshot):Promise<DiscoveryResult> {
  const query=input.query?.trim(),mode=input.mode??'auto',limit=input.limit??1,offset=input.offset??0;
  if(typeof query!=='string'||(!query&&mode!=='catalog'))throw new Error('query 必须非空；枚举目录时使用 mode=catalog');
  if(!['auto','exact','keyword','catalog'].includes(mode))throw new Error('mode 必须为 auto/exact/keyword/catalog');
  if(!Number.isInteger(limit)||limit<1||limit>20)throw new Error('limit 必须为 1–20 的整数');
  if(!Number.isSafeInteger(offset)||offset<0)throw new Error('offset 必须为非负整数，使用返回的 next 翻页');
  const byName=new Map(snapshot.tools.map(tool=>[tool.name,tool]));
  const suffixes=snapshot.tools.filter(tool=>tool.name.endsWith('__'+query));
  const exact=mode==='exact'||mode==='auto'&&(byName.has(query)||snapshot.known(query)||/^[a-zA-Z][a-zA-Z0-9]*_\w+$/.test(query));
  const base={loaded:[] as string[],already_loaded:[] as string[],...(snapshot.unavailableServers.length?{unavailable_servers:snapshot.unavailableServers}:{})};
  if(exact){
    // Only auto mode accepts an unambiguous MCP shorthand. Full names always win.
    const name=mode==='auto'&&!byName.has(query)&&suffixes.length===1?suffixes[0]!.name:query;
    if(mode==='auto'&&!byName.has(query)&&suffixes.length>1){
      const candidates=suffixes.filter(tool=>!snapshot.denied.has(tool.name)&&!snapshot.unavailable.has(tool.name)&&tool.exposure!=='hidden');
      return {...base,status:'candidates',mode:'exact',message:'简称对应多个工具，请用完整名称精确加载。',
        total_candidates:candidates.length,has_more:candidates.length>8,...(candidates.length>8?{next:{query:'',mode:'catalog' as const,limit,offset:0}}:{}),
        candidates:candidates.slice(0,8).map(tool=>({name:tool.name,summary:'',active:snapshot.active.includes(tool.name),matched:true}))};
    }
    const tool=byName.get(name);
    if(snapshot.denied.has(name)||tool?.exposure==='hidden'||!tool&&snapshot.known(name))
      return {...base,status:'unauthorized',mode:'exact',name,message:snapshot.reason?.(name)??'工具未向当前会话授权，或已禁用/解绑；未加载。'};
    if(snapshot.unavailable.has(name)||!tool&&name.startsWith('mcp__')&&snapshot.unavailableServers.length)
      return {...base,status:'unavailable',mode:'exact',name,message:'MCP 发现未完成或服务不可用，暂时无法确认或加载此工具；不能据此判定不存在。'};
    if(!tool)return {...base,status:'not_found',mode:'exact',name,message:'当前工具目录中不存在此名称；核对拼写，或用 mode=keyword/catalog 查找可用名称。'};
    if(snapshot.active.includes(name))return {...base,status:'already_loaded',mode:'exact',name,already_loaded:[name],message:'工具已加载，可以直接调用。'};
    return {...base,status:'loaded',mode:'exact',name,loaded:[name],message:'已精确加载；参数与约束见下一轮工具声明。'};
  }

  const allowed=snapshot.tools.filter(tool=>tool.name!=='tool_search'&&tool.exposure!=='hidden'&&!snapshot.denied.has(tool.name)&&!snapshot.unavailable.has(tool.name));
  const ranked=mode==='catalog'?[]:await rankTools(allowed,query);
  const matched=new Set(ranked),tools=new Map(allowed.map(tool=>[tool.name,tool]));
  // Include the unmatched tail too: synonyms and multilingual queries cannot
  // silently hide a permitted tool. Only compact metadata is paged to the model.
  const names=[...ranked,...allowed.map(tool=>tool.name).filter(name=>!matched.has(name)).sort()];
  const version=createHash('sha256').update(JSON.stringify([query,mode==='catalog'?'catalog':'keyword',names])).digest('hex').slice(0,16);
  if(offset>0&&input.catalog_version!==version)return {...base,status:'catalog_changed',mode:mode==='catalog'?'catalog':'keyword',catalog_version:version,
    message:'目录或权限已变化，或分页缺少 catalog_version；请从返回的 next 重新读取，避免跳过候选。',next:{query,mode:mode==='catalog'?'catalog':'keyword',limit,offset:0}};
  const page=names.slice(offset,offset+Math.max(8,limit));
  const matching=page.filter(name=>matched.has(name));
  const unloaded=matching.filter(name=>!snapshot.active.includes(name));
  const selected=mode==='catalog'?[]:(unloaded.length?unloaded:matching).slice(0,limit);
  const already=selected.filter(name=>snapshot.active.includes(name)),loaded=selected.filter(name=>!snapshot.active.includes(name));
  const hasMore=offset+page.length<names.length;
  return {...base,status:loaded.length?'loaded':already.length?'already_loaded':'candidates',mode:mode==='catalog'?'catalog':'keyword',
    loaded,already_loaded:already,match_count:ranked.length,...(!ranked.length&&mode!=='catalog'?{fallback:'catalog' as const}:{}),
    message:mode==='catalog'?'可用工具目录；用完整名称精确加载。':ranked.length?'已搜索全部可用工具；仅加载本页所需项，其余候选不携带参数 Schema。候选尾部包含未命中的工具。':'关键词未命中，已自动回退到可用工具目录；请按功能选择完整名称。',
    candidates:page.map(name=>{const tool=tools.get(name)!;return {name,summary:Array.from(tool.description.trim().split(/\r?\n/)[0]??'').slice(0,60).join(''),active:snapshot.active.includes(name)||loaded.includes(name),matched:matched.has(name)};}),
    total_candidates:names.length,catalog_version:version,has_more:hasMore,...(hasMore?{next:{query,mode:mode==='catalog'?'catalog' as const:'keyword' as const,limit,offset:offset+page.length,catalog_version:version}}:{}),
  };
}

export function discoveryReceipt(result:DiscoveryResult){
  return {content:[{type:'text' as const,text:JSON.stringify(result)}],details:{...result,discovery_version:1},
    ...(['unauthorized','not_found','unavailable','catalog_changed'].includes(result.status)?{isError:true}:{})};
}
