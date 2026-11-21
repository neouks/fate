import pg from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {postgresDSN} from '../src/config/index.js';
if(!process.argv.includes('--run'))throw new Error('Pass --run to create and remove an isolated test database');
const url=new URL(postgresDSN().dsn),name='test_web_access_'+Date.now();url.pathname='/postgres';
const admin=new pg.Pool({connectionString:url.href});let created=false;
try{
 await admin.query(`CREATE DATABASE "${name}"`);created=true;url.pathname='/'+name;
 const output=await promisify(execFile)(process.execPath,['--import','tsx','--test','--test-concurrency=1','src/db/web-access-migration.test.ts','src/db/mcp-presets.test.ts'],{
  env:{...process.env,TEST_WEB_ACCESS_DSN:url.href,TEST_MCP_PRESETS_DSN:url.href},maxBuffer:2*1024*1024});
 console.log(output.stdout);
}catch(error){const e=error as {stdout?:string;stderr?:string};console.error(e.stdout??'',e.stderr??'');process.exitCode=1;}
finally{if(created)await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();}
