import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({load(url,context,next){
 if(url.endsWith('/core/zernioOwnerConfig.js'))return {format:'commonjs',shortCircuit:true,source:"exports.currentZernioSecrets=()=>({apiKey:'fixture-only',ownerSlug:'fixture'});"};
 return next(url,context);
}});
const original=globalThis.fetch;let calls=[];
globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return new Response(JSON.stringify({dailyData:[{date:'2026-11-06',metrics:{views:25,comments:0}},{date:'invalid',metrics:{views:100}}]}),{status:200});};
try{
 const z=await import('../dist/src/integrations/zernio/index.js');
 const result=await z.fetchDailyPerformance('account-a');
 assert.equal(result.days.length,1);assert.equal(result.days[0].metrics.views,25);assert.equal(result.days[0].metrics.comments,0);assert.equal(result.days[0].metrics.shares,null);
 const query=new URL(calls[0].url).searchParams;
 assert.equal(query.get('attribution'),'received');assert.equal(query.get('accountId'),'account-a');
 assert.equal((Date.parse(query.get('toDate'))-Date.parse(query.get('fromDate')))/86400000,179);
 await z.fetchDailyPerformance('account-a');assert.equal(calls.length,1);
 globalThis.fetch=async()=>new Response('{}',{status:503});
 assert.match((await z.fetchDailyPerformance('account-b')).error,/503/);
 globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({post:{_id:'remote',status:'scheduled'}}),{status:200});};
 const publishing=await import('../dist/src/integrations/zernio/posts.js');
 const created=await publishing.createZernioPost({idempotencyKey:'stable-post-id',content:'fixture',mediaUrl:'https://example.com/video.mp4',platforms:[{platform:'instagram',accountId:'a'}],scheduledFor:'2030-11-10T16:00:00Z'});
 assert.equal(created.postId,'remote');assert.equal(calls.at(-1).init.headers['Idempotency-Key'],'stable-post-id');
 assert.equal(JSON.parse(calls.at(-1).init.body).scheduledFor,'2030-11-10T16:00:00Z');
 console.log('Daily performance and publishing transport checks passed: received attribution, account scope, date range, null metrics, cache, errors and idempotency header.');
}finally{globalThis.fetch=original;}
