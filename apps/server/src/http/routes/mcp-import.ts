import type {FastifyInstance} from 'fastify';
import {validateServerTransport} from '../../pi/mcpTransport.js';

/** Import configuration only. Discovering tools/starting commands is a separate
 * explicit operation; a successful import does not claim a reachable server. */
export function registerMcpImportRoutes(app:FastifyInstance):void {
  app.post('/api/mcp/import',async(req,reply)=>{
    const raw=(req.body as {servers?:unknown}|null)?.servers;
    if(!Array.isArray(raw)||raw.length===0||raw.length>100)
      return reply.code(400).send({error:'servers 必须包含 1–100 个 MCP 配置'});
    const names=new Set<string>();
    let servers:Record<string,unknown>[];
    try {
      servers=raw.map((value,index)=>{
        try {
          if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('配置必须为对象');
          const input=value as Record<string,unknown>;
          if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>120)throw new Error('name 必须为 1–120 字符');
          const name=input.name.trim();
          if(names.has(name))throw new Error('同一批次不能重复导入同名 MCP');
          names.add(name);
          for(const field of ['command','url'])if(input[field]!==undefined&&typeof input[field]!=='string')throw new Error(`${field} 必须为字符串`);
          const transport=validateServerTransport(input);
          for(const field of ['enabled','insecure'])if(input[field]!==undefined&&typeof input[field]!=='boolean')throw new Error(`${field} 必须为布尔值`);
          return {...input,name,transport};
        }catch(error){throw new Error(`servers[${index}]: ${(error as Error).message}`);}
      });
    }catch(error){return reply.code(400).send({error:(error as Error).message});}

    const results=await app.db.transaction(async tx=>{
      const result=new Map<string,{id:number;name:string;action:'created'|'updated'}>();
      // Fixed lock order prevents overlapping batches from deadlocking.
      for(const s of [...servers].sort((a,b)=>String(a.name).localeCompare(String(b.name)))){
        const args=[s.name,s.transport,s.command??'',JSON.stringify(s.args??[]),JSON.stringify(s.headers??s.env??{}),s.url??'',s.enabled!==false,s.insecure??false];
        const inserted=await tx.query(`INSERT INTO mcp_servers(name,transport,command,args,env,url,enabled,insecure)
          VALUES($1,$2,NULLIF($3,''),$4::jsonb,$5::jsonb,NULLIF($6,''),$7,$8)
          ON CONFLICT(name) DO NOTHING RETURNING id`,args);
        let id=Number(inserted.rows[0]?.id);
        const created=!!id;
        if(!created){
          args[7]=s.insecure??null;
          const updated=await tx.query(`UPDATE mcp_servers SET transport=$2,command=NULLIF($3,''),args=$4::jsonb,
            env=$5::jsonb,url=NULLIF($6,''),enabled=$7,insecure=COALESCE($8::boolean,insecure) WHERE name=$1 RETURNING id`,args);
          if(!updated.rows[0])throw Object.assign(new Error('MCP 配置在导入期间已删除，请刷新后重试'),{statusCode:409});
          id=Number(updated.rows[0].id);
          await tx.query('DELETE FROM mcp_tools_cache WHERE server_id=$1',[id]);
        }
        result.set(String(s.name),{id,name:String(s.name),action:created?'created':'updated'});
      }
      return servers.map(s=>result.get(String(s.name))!);
    });
    return {ok:true,results};
  });
}
