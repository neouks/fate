import {createInterface} from 'node:readline';
import tool from './quote.json' with {type:'json'};

function respond(method, params) {
  switch (method) {
    case 'initialize':
      return {result:{protocolVersion:params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'materials',version:'1.0.0'}}};
    case 'ping': return {result:{}};
    case 'tools/list': return {result:{tools:[tool]}};
    case 'tools/call': {
      const args=params.arguments;
      if (params.name!==tool.name || !args || typeof args.text!=='string' ||
          typeof args.quote!=='string' || !args.quote || Object.keys(args).some(k=>!Object.hasOwn(tool.inputSchema.properties,k)))
        return {error:{code:-32602,message:'需要 text 和非空 quote 字符串'}};
      const start=args.text.indexOf(args.quote);
      const line=start<0?null:args.text.slice(0,start).split(/\r\n|\r|\n/).length;
      return {result:{content:[{type:'text',text:JSON.stringify({matched:start>=0,line})}]}};
    }
    default: return {error:{code:-32601,message:'Unknown method'}};
  }
}

for await (const line of createInterface({input:process.stdin})) {
  let request;
  try { request=JSON.parse(line); }
  catch { process.stdout.write('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Invalid JSON"}}\n');continue; }
  if (request?.id==null) continue;
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,...respond(request.method,request.params??{})})+'\n');
}
