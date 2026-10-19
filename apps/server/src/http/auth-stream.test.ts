import {describe,it,expect} from 'vitest';
import Fastify from 'fastify';
import {requireJWT,signJWT} from './auth.js';
describe('explicit SSE authentication',()=>{
 it('uses a valid explicit token over an unrelated localhost cookie',async()=>{
  const app=Fastify(),key='LOCAL current application key';app.addHook('preHandler',requireJWT(key));app.get('/stream',async()=>({ok:true}));
  try{const token=signJWT(key),other=signJWT('LOCAL isolated fixture key');
   expect((await app.inject({url:'/stream?token='+token,headers:{cookie:'series_token='+other}})).statusCode).toBe(200);
   expect((await app.inject({url:'/stream?token='+other,headers:{cookie:'series_token='+token}})).statusCode).toBe(401);
   expect((await app.inject({url:'/stream',headers:{cookie:'series_token='+token}})).statusCode).toBe(200);
   expect((await app.inject({url:'/stream?token='+other,headers:{authorization:'Bearer '+token}})).statusCode).toBe(200);
  }finally{await app.close();}
 });
});
