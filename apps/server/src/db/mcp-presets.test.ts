import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openDatabase} from './index.js';

const dsn=process.env.TEST_MCP_PRESETS_DSN;
test('MCP startup presets permit concurrent sessions and preserve explicit configuration/deletion', {skip:!dsn&&'isolated PostgreSQL required'}, async()=>{
  assert.match(new URL(dsn!).pathname,/^\/test_/);
  process.env.SERIES_PG_DSN=dsn;
  let db=await openDatabase();
  try{
    const servers=await db.platform().listMCP();
    assert.equal(servers.some(s=>s.name==='ScopeSentry'),false);
    for(const name of ['playwright','chrome-devtools']){
      const server=servers.find(s=>s.name===name)!;
      assert.ok(server.args.includes('--isolated'));
      assert.equal(server.enabled,false);
    }
    const search=servers.find(s=>s.name==='web_search')!;
    assert.equal(search.env.FATE_MCP_FETCH_PROXY,'1');
    const browser=servers.find(s=>s.name==='playwright')!;
    await db.platform().saveMCP({...browser,args:['custom-command-argument'],enabled:true});
    const scope=await db.platform().saveMCP({name:'ScopeSentry',transport:'http',url:'https://example.com/mcp',command:'',args:[],env:{},enabled:false,insecure:false});
    await db.close();db=await openDatabase();
    assert.equal((await db.platform().listMCP()).find(s=>s.name==='ScopeSentry')?.id,scope);
    await db.platform().deleteMCP(scope);
    await db.close();db=await openDatabase();
    const restarted=await db.platform().listMCP();
    assert.equal(restarted.some(s=>s.name==='ScopeSentry'),false);
    assert.deepEqual(restarted.find(s=>s.name==='playwright')?.args,['custom-command-argument']);
    assert.equal(restarted.find(s=>s.name==='playwright')?.enabled,true);
  }finally{await db.close();}
});
