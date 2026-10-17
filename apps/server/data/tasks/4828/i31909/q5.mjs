import pg from '/Users/pphua/Documents/GitHub/JARVIS/apps/server/node_modules/pg/lib/index.js';
const c=new pg.Client({host:'127.0.0.1',port:5433,user:'series',password:'series',database:'series'});
await c.connect();
const show=async(label,sql)=>{try{const r=await c.query(sql);console.log('=== '+label, r.rows.length);for(const row of r.rows)console.log(JSON.stringify(row).slice(0,2500));}catch(e){console.log('=== '+label+' ERR '+e.message);}};
await show('conversations','select * from conversations where task_id=4828');
await show('conv activities','select * from conversation_activities order by id desc limit 10');
await show('activity 4828','select id,task_id,intent_id,step_no,kind,substr(content,1,800) as content from activity where task_id=4828 order by id');
await c.end();
