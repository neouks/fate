import test from 'node:test';
import assert from 'node:assert/strict';
import {createMockTraffic} from './mock/traffic.ts';
test('demo traffic uses the current hosts/exchanges contract, filters and paginates',()=>{
 const rows=[1,2,3].map(id=>({id:String(id),host:'demo.invalid',url:`http://demo.invalid/${id}`,method:id===1?'POST':'GET',status:200}));
 const api=createMockTraffic(rows);
 assert.deepEqual(api.hosts(),{hosts:[{host:'demo.invalid',count:3}]});
 const page=api.page(new URLSearchParams('method=GET&size=1&page=1'));
 assert.equal(page.total,2);assert.equal(page.exchanges[0].id,'3');
 assert.equal(api.paths(new URLSearchParams('host=demo.invalid')).total,3);
 assert.equal(api.remove('demo.invalid').deleted,3);
 assert.deepEqual(api.hosts(),{hosts:[]});assert.deepEqual(api.page(new URLSearchParams()).exchanges,[]);
 assert.equal(rows.length,3);
});
