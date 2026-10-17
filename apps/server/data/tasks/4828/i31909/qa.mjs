import pg from '/Users/pphua/Documents/GitHub/JARVIS/apps/server/node_modules/pg/lib/index.js';
const c=new pg.Client({host:'127.0.0.1',port:5433,user:'series',password:'series',database:'series'});
await c.connect();
const r=await c.query("select id,type,task_ids,domain,port,url,service_name,page_title,technologies,status_code,auth,authorization_host from assets where domain='144.123.22.234' or ip='144.123.22.234' order by id");
console.log(r.rows.length);
for(const x of r.rows) console.log(JSON.stringify(x));
await c.end();
