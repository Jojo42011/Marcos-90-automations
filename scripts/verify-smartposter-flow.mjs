import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'poster-flow-'));
process.env.TENANT_DATA_ROOT=root;
const state=globalThis.posterFixture={created:0,updated:0,rejectUpdate:false,files:[{id:'file-1',name:'Finished tour.mp4'},{id:'file-2',name:'2030-12-31__all__future-video.mp4'}]};
const mock=source=>({format:'commonjs',shortCircuit:true,source:source.replace(/export (async )?function (\w+)/g,(_,a,n)=>';exports.'+n+' = '+(a||'')+'function '+n)});
registerHooks({load(url,ctx,next){
 if(url.endsWith('/smartPoster/drive.js'))return mock(`
 export async function getComposioDriveStatus(){return {connected:true,ready:true};}
 export async function ensureFolderId(){return {id:'folder',name:'Finished'};}
 export async function listFolderVideos(){return globalThis.posterFixture.files;}
 export async function readSidecarJson(){return null;}
 export async function downloadDriveFile(){return Buffer.from('fixture video');}`);
 if(url.endsWith('/zernio/index.js'))return mock(`export async function listZernioAccounts(){return {ok:true,accounts:[{id:'a',platform:'instagram',active:true},{id:'b',platform:'instagram',active:true}]};}`);
 if(url.endsWith('/zernio/posts.js'))return mock(`
 export async function getZernioPostStatus(){return {ok:true,status:'published',url:'https://example.com/published'};}
 export async function uploadBufferToZernio(){return {ok:true,publicUrl:'https://example.com/fixture.mp4'};}
 export async function createZernioPost(body){globalThis.posterFixture.created++;globalThis.posterFixture.lastCreate=body;if(globalThis.posterFixture.timeout)throw Error('Timeout');return {ok:true,postId:'remote-1'};}
 export async function updateZernioPost(id,body){globalThis.posterFixture.updated++;globalThis.posterFixture.lastUpdate={id,body};return globalThis.posterFixture.rejectUpdate?{ok:false,error:'Provider unavailable'}:{ok:true};}`);
 if(url.endsWith('/smartPoster/captions.js'))return mock(`export function parseVideoFileName(name){return {slug:name,platforms:['all']};}export async function draftCaption(){return 'Fixture caption';}`);
 return next(url,ctx);
}});
const store=await import('../dist/src/core/smartPosterStore.js');
const flow=await import('../dist/src/integrations/smartPoster/sync.js');
try{
 store.saveSettings({driveFolderId:'folder',driveFolderName:'Finished'});
 const first=await flow.runSmartPosterSync({forceSchedule:true,owner:'fixture'});
 assert.equal(first.created,2);assert.equal(state.created,0);
 const post=store.findByDriveFileId('file-1');
 assert.equal(post.status,'inbox');assert.deepEqual(post.accountIds,[]);assert.equal(post.scheduledFor,null);
 const body={caption:'Carlos edited this',localDate:'2030-11-10',localTime:'10:00',accountIds:['b']};
 await flow.updateSmartPosterPost(post.id,body);
 const second=await flow.runSmartPosterSync({owner:'fixture'});
 assert.equal(second.created,0);assert.equal(second.skipped,2);
 assert.equal(store.getPost(post.id).caption,'Carlos edited this');
 assert.deepEqual(store.getPost(post.id).accountIds,['b']);
 await flow.updateSmartPosterPost(post.id,body,true,'fixture');
 assert.equal(state.created,1);assert.equal(state.lastCreate.platforms.length,1);assert.equal(state.lastCreate.platforms[0].accountId,'b');
 assert.equal(state.lastCreate.scheduledFor,'2030-11-10T16:00:00.000Z');
 await flow.updateSmartPosterPost(post.id,{localDate:'2030-11-11',localTime:'11:00',accountIds:['a']});
 assert.equal(state.created,1);assert.equal(state.updated,1);assert.equal(state.lastUpdate.id,'remote-1');
 assert.equal(store.getPost(post.id).scheduledFor,'2030-11-11T17:00:00.000Z');
 state.rejectUpdate=true;
 await assert.rejects(flow.updateSmartPosterPost(post.id,{caption:'Rejected change'}),/Provider unavailable/);
 assert.equal(store.getPost(post.id).caption,'Carlos edited this');
 const fresh=store.findByDriveFileId('file-2');
 await assert.rejects(flow.updateSmartPosterPost(fresh.id,{localDate:'2030-11-11',localTime:'10:00',accountIds:[]},true),/at least one/);
 assert.equal(state.created,1);
 // Cadence is based on successful imports, with a persisted retry cooldown.
 const base={...store.getSettings(),timezone:'America/Chicago',ingestHour:7,ingestIntervalMinutes:0,lastSuccessfulSyncAt:null,lastAutoAttemptAt:null};
 assert.equal(flow.importDue(base,new Date('2030-11-10T12:59:00Z')),false);
 assert.equal(flow.importDue(base,new Date('2030-11-10T13:00:00Z')),true);
 assert.equal(flow.importDue({...base,lastSuccessfulSyncAt:'2030-11-10T13:00:00Z'},new Date('2030-11-10T18:00:00Z')),false);
 assert.equal(flow.importDue({...base,ingestIntervalMinutes:60,lastSuccessfulSyncAt:'2030-11-10T13:00:00Z'},new Date('2030-11-10T14:00:00Z')),true);
 assert.equal(flow.importDue({...base,lastAutoAttemptAt:'2030-11-10T13:00:00Z'},new Date('2030-11-10T13:14:00Z')),false);
 assert.equal(flow.importDue({...base,lastAutoAttemptAt:'2030-11-10T13:00:00Z'},new Date('2030-11-10T13:15:00Z')),true);
 assert.throws(()=>store.saveSettings({ingestIntervalMinutes:2}),/cadence/);
 await flow.reconcileScheduledPosts();
 assert.equal(store.getPost(post.id).status,'published');
 assert.equal(store.getPost(post.id).platformPostUrl,'https://example.com/published');
 state.timeout=true;
 const unknown=await flow.updateSmartPosterPost(fresh.id,body,true,'fixture');
 assert.equal(unknown.status,'scheduled');assert.match(unknown.error,/outcome unknown/);
 assert.equal(state.lastCreate.idempotencyKey,fresh.id);
 const calls=state.created;
 await assert.rejects(flow.updateSmartPosterPost(fresh.id,body,true,'fixture'),/no provider ID/);
 assert.equal(state.created,calls,'An unknown outcome must not cause a duplicate post');
 console.log('SmartPoster passed: import-only, exact targets, timezone, cadence, retries, published reconciliation, immutable schedules and uncertain-submit protection.');
}finally{store.getSmartPosterDb().close();rmSync(root,{recursive:true,force:true});}
