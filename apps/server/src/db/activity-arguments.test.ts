import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openDatabase} from './index.js';
import {readActivityContent} from './activity-content.js';

const dsn=process.env.TEST_ACTIVITY_ARGUMENTS_DSN;
test('original malformed arguments paginate losslessly with authorization and version checks', {skip:!dsn&&'requires isolated PostgreSQL'},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase();t.after(()=>db.close());
 const exp=await db.createExploration('fixture','local only');
 const raw='{"facts":[{"evidence":"'+('中文😀\\"'.repeat(2500))+'", {"bad":true}]}';
 const detail='Invalid arguments for tool "record_fact": Expected property name\n\nReceived arguments:\n'+raw;
 const id=(await db.query("INSERT INTO activity(exploration_id,kind,tool,is_error,detail) VALUES($1,'tool_result','record_fact',true,$2) RETURNING id",[exp,detail])).rows[0]!.id;
 const read=(query:Record<string,unknown>,scope=exp)=>readActivityContent(db,'task','exploration_id=$1 AND id=$2',[scope,id],{field:'arguments',...query});
 let offset=0,version:string|undefined,joined='';
 do{const page=await read({offset:String(offset),limit:'97',...(version?{version}:{})}) as any;joined+=page.detail;offset=page.next_offset;version=page.version;if(!page.has_more)break;}while(true);
 assert.equal(joined,raw);assert.equal(offset,Array.from(raw).length);
 await assert.rejects(read({offset:'0'},exp+1),{statusCode:404});
 await assert.rejects(read({offset:'0',version:'0'}),{statusCode:409});
 await assert.rejects(read({offset:String(offset+1)}),{statusCode:400});
 assert.equal((await db.query('SELECT detail FROM activity WHERE id=$1',[id])).rows[0]!.detail,detail);
 await db.query("UPDATE activity SET kind='text' WHERE id=$1",[id]);
 await assert.rejects(read({offset:'0'}),{statusCode:400});
});
