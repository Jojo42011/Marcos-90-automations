import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import fs from 'node:fs/promises';
const root=existsSync('dist/src/videoKnowledge')?'dist/src/videoKnowledge':'dist/videoKnowledge';
const load=name=>import(pathToFileURL(path.resolve(root,name+'.js')).href);
const {VideoStore,validateNotes,postId}=await load('store');
const {videoReply,videoAdmin,videoStore,closeVideoStore}=await load('index');
const {processVideo,syncVideos}=await load('worker');
const {publicIpv4,downloadMedia,transcribeVideo}=await load('media');
const dir=mkdtempSync(path.join(tmpdir(),'video-knowledge-test-'));
process.env.VIDEO_KNOWLEDGE_DB_PATH=path.join(dir,'admin.db');
process.env.ZERNIO_TIKTOK_ACCOUNT_ID='account-a';
globalThis.fetch=async()=>{throw new Error('Live network forbidden in this test');};
let checks=0;
const check=async(name,fn)=>{await fn();checks++;console.log('ok '+name);};
const store=new VideoStore(path.join(dir,'videos.db'));
const video=(post='111',account='account-a',caption='This house is in San Antonio. Comment OAK HILL. Listed at $450,000.')=>({account,post,url:`https://www.tiktok.com/@realtor/video/${post}`,caption,published:'2026-10-01T12:00:00Z'});
const notes={facts:[{field:'city',value:'San Antonio',quote:'This house is in San Antonio.',source:'caption'},{field:'price',value:'$450,000',quote:'Listed at $450,000.',source:'caption'}],keywords:['oak hill']};
const approve=(v)=>store.review(v.account,v.post,v.revision,'approve');
try {
 await check('default disabled leaves DM behavior untouched',()=>{delete process.env.VIDEO_KNOWLEDGE_ENABLED;delete process.env.VIDEO_KNOWLEDGE_REPLIES_ENABLED;assert.equal(videoReply('u','OAK HILL',store,'account-a'),null);});
 await check('valid canonical URL only',()=>{assert.equal(postId(video().url),'111');assert.equal(postId('https://tiktok.com.evil.test/@a/video/111'),null);assert.equal(postId('http://tiktok.com/@a/video/111'),null);assert.equal(postId('https://tiktok.com:444/@a/video/111'),null);});
 await check('duplicate discovery does not requeue',()=>{assert.equal(store.ingest(video()),true);assert.equal(store.ingest(video()),false);});
 await check('account separation',()=>{store.ingest(video('111','account-b'));assert.equal(store.list('account-b').length,1);assert.equal(store.list('account-a').length,1);});
 await check('worker produces review state, never automatic approval',async()=>{assert.equal(await processVideo(store,'account-a',{transcribe:async()=> 'This is the full recorded speech.',extract:async()=>notes}),'needs_review');assert.equal(store.get('account-a','111').state,'needs_review');});
 process.env.VIDEO_KNOWLEDGE_ENABLED='true';process.env.VIDEO_KNOWLEDGE_REPLIES_ENABLED='true';
 await check('unreviewed exact video cannot supply facts',()=>{assert.doesNotMatch(videoReply('u',video().url+' location?',store,'account-a'),/San Antonio/);});
 await check('unsupported city rejected',()=>{assert.throws(()=>validateNotes({...notes,facts:[{field:'city',value:'Austin',quote:'This house is in San Antonio.',source:'caption'}]},video()),/supported/);});
 await check('fabricated quotation rejected',()=>{assert.throws(()=>validateNotes({...notes,facts:[{field:'city',value:'Austin',quote:'This house is in Austin.',source:'caption'}]},video()),/supported/);});
 await check('duplicate conflicting fields rejected',()=>{assert.throws(()=>validateNotes({...notes,facts:[notes.facts[0],notes.facts[0]]},video()),/conflicting/);});
 await check('generic keyword cannot select a house',()=>{assert.throws(()=>validateNotes({...notes,keywords:['info']},video()),/specific/);});
 await check('approval is tied to reviewed revision',()=>{assert.throws(()=>store.review('account-a','111','old','approve'),/changed/);approve(store.get('account-a','111'));assert.equal(store.get('account-a','111').state,'ready');});
 await check('unique keyword returns only approved source facts',()=>{assert.match(videoReply('u','oak hill location?',store,'account-a'),/San Antonio/);assert.doesNotMatch(videoReply('u','oak hill location?',store,'account-a'),/Austin|450/);});
 await check('conversation remembers the selected video',()=>{assert.match(videoReply('u','price?',store,'account-a'),/450,000/);});
 await check('price is historical and needs current confirmation',()=>{assert.match(videoReply('u','price?',store,'account-a'),/2026-10-01.*confirm the current price/);assert.doesNotMatch(videoReply('u','still available?',store,'account-a'),/450,000/);});
 await check('missing bedroom count cannot be guessed',()=>{assert.doesNotMatch(videoReply('u','how many bedrooms?',store,'account-a'),/San Antonio|450,000/);});
 await check('buyer service-area questions retain normal behavior',()=>{assert.equal(videoReply('u','do you work in Austin?',store,'account-a'),null);});
 await check('unknown link clears stale property reference',()=>{assert.doesNotMatch(videoReply('u','https://www.tiktok.com/@x/video/999 price?',store,'account-a'),/450,000/);assert.doesNotMatch(videoReply('u','price?',store,'account-a'),/450,000/);});
 await check('short link never falls back to old property',()=>{videoReply('u','oak hill',store,'account-a');assert.doesNotMatch(videoReply('u','https://vm.tiktok.com/unknown price?',store,'account-a'),/450,000/);});
 await check('another house clears conversation selection',()=>{videoReply('u','oak hill',store,'account-a');videoReply('u','another house',store,'account-a');assert.doesNotMatch(videoReply('u','price?',store,'account-a'),/450,000/);});
 await check('recent unique comment identifies video',()=>{store.comment('account-a','commenter','111',Date.now());assert.match(videoReply('commenter','location?',store,'account-a'),/San Antonio/);});
 await check('comment association cannot cross account',()=>{assert.equal(store.resolve('account-b','commenter','location?').video,undefined);});
 await check('reused keyword asks clarification',async()=>{store.ingest(video('222'));await processVideo(store,'account-a',{transcribe:async()=> 'Second house full speech.',extract:async()=>notes});approve(store.get('account-a','222'));assert.match(videoReply('new','oak hill',store,'account-a'),/More than one/);});
 await check('explicit link wins over reused keyword',()=>{assert.match(videoReply('new',video().url+' oak hill location?',store,'account-a'),/San Antonio/);});
 await check('multiple comment sources do not pick most recent house',()=>{store.comment('account-a','multi','111',Date.now());store.comment('account-a','multi','222',Date.now());assert.match(videoReply('multi','info',store,'account-a'),/More than one/);});
 await check('source edit revokes approval',()=>{store.ingest(video('111','account-a','The caption was edited.'));assert.equal(store.get('account-a','111').state,'queued');assert.doesNotMatch(videoReply('commenter','price?',store,'account-a'),/450,000/);});
 await check('stale worker cannot overwrite an edited source',()=>{const old=store.claim('account-a');store.ingest({...video(),caption:'A newer edit.'});store.complete(old,'Some complete speech here.',{facts:[],keywords:[]});assert.equal(store.get('account-a','111').transcript,'');});
 await check('one lease per job; crash recovery claims a fresh lease',()=>{const a=store.claim('account-a');assert.ok(a);assert.equal(store.claim('account-a'),undefined);const b=store.claim('account-a',Date.now()+31*60_000);assert.notEqual(a.lease,b.lease);store.complete(a,'Old worker speech.',{facts:[],keywords:[]});assert.equal(store.get('account-a','111').transcript,'');store.fail(b);});
 await check('failed transcription cannot become ready',async()=>{store.ingest(video('333'));await processVideo(store,'account-a',{transcribe:async()=>{throw new Error('secret-provider-error');},extract:async()=>notes});assert.equal(store.get('account-a','333').state,'queued');assert.doesNotMatch(store.get('account-a','333').error,/secret/);});
 await check('three attempts stop automatic retries',()=>{for(let i=0;i<2;i++){const v=store.claim('account-a',Date.now()+86400_000);if(v)store.fail(v);}store.db.prepare("UPDATE videos SET attempts=2,state='queued',next_attempt=0 WHERE account=? AND post=?").run('account-a','333');const v=store.claim('account-a');store.fail(v);assert.equal(store.get('account-a','333').state,'failed');});
 await check('sync maps account-post API fields and rejects other platforms',async()=>{const n=await syncVideos(store,'sync-account',async(route)=>{assert.equal(route,'/accounts/sync-account/posts');return {posts:[{id:'777',platform:'tiktok',permalink:video('777').url,message:video().caption,createdTime:video().published,mediaType:'video'},{id:'888',platform:'instagram'}]};});assert.equal(n,1);assert.equal(store.get('sync-account','777').state,'queued');});
 await check('rejects private network media targets before connecting',async()=>{for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.1.1','192.168.1.1','100.64.0.1','0.0.0.0'])assert.equal(publicIpv4(ip),false);assert.equal(publicIpv4('8.8.8.8'),true);await assert.rejects(()=>downloadMedia('file:///secret'));await assert.rejects(()=>downloadMedia('https://127.0.0.1/video'));});
 await check('no model path fails before downloading or spending',async()=>{delete process.env.VIDEO_WHISPER_MODEL;await assert.rejects(()=>transcribeVideo(video()),/MODEL/);});
 await check('local media pipeline checks full audio and cleans temporary files',async()=>{
   process.env.VIDEO_WHISPER_MODEL=path.join(dir,'fixture-model.bin');let workDir;let speechCalls=0;
   const result=await transcribeVideo(video(),{request:async()=>({downloadUrl:'https://example.invalid/video'}),download:async()=>Buffer.from('0000ftypfixture'),execute:async(cmd,args,cwd)=>{
     workDir=cwd;
     if(cmd==='ffprobe')return JSON.stringify({format:{duration:5},streams:[{codec_type:'audio'}]});
     if(cmd==='ffmpeg'){assert.ok(args.includes('file,pipe'));await fs.writeFile(args.at(-1),Buffer.alloc(5*32000+44));return '';}
     speechCalls++;assert.ok(args.includes('1'));assert.ok(args.includes(process.env.VIDEO_WHISPER_MODEL));await fs.writeFile(path.join(cwd,'transcript.txt'),'The house is in San Antonio.');return '';
   }});
   assert.equal(result,'The house is in San Antonio.');assert.equal(speechCalls,1);assert.equal(existsSync(workDir),false);
 });
 await check('truncated audio never reaches speech recognition',async()=>{
   await assert.rejects(()=>transcribeVideo(video(),{request:async()=>({downloadUrl:'https://example.invalid/video'}),download:async()=>Buffer.from('0000ftypfixture'),execute:async(cmd,args)=>{
     if(cmd==='ffprobe')return JSON.stringify({format:{duration:60},streams:[{codec_type:'audio'}]});
     if(cmd==='ffmpeg'){await fs.writeFile(args.at(-1),Buffer.alloc(32044));return '';}
     throw new Error('Transcriber must not run');
   }}),/coverage incomplete/);
 });
 await check('unrecognized feature question does not invent attributes',()=>{assert.match(videoReply('q',video('222').url+' does it have solar panels?',store,'account-a'),/verify that detail/);});
 await check('processing flag does not arm replies',()=>{delete process.env.VIDEO_KNOWLEDGE_REPLIES_ENABLED;assert.equal(videoReply('u','oak hill',store,'account-a'),null);});
 await check('admin preview never sends a message',async()=>{const result=await videoAdmin('POST',{action:'preview',message:'what price?'});assert.equal(result.sent,false);});
 if(root.includes('dist/src')) await check('Marco enabled pipeline serves reviewed facts and retains conversation selection',async()=>{
   process.env.VIDEO_KNOWLEDGE_REPLIES_ENABLED='true';process.env.TENANT_DATA_ROOT=dir;process.env.DB_JSON_PATH=path.join(dir,'leads.json');process.env.LISTINGS_DB_PATH=path.join(dir,'listings.db');delete process.env.ANTHROPIC_API_KEY;
   const liveStore=videoStore();liveStore.ingest(video());liveStore.complete(liveStore.claim('account-a'),'The complete source speech.',notes);liveStore.review('account-a','111',liveStore.get('account-a','111').revision,'approve');
   const pipeline=await import(pathToFileURL(path.resolve('dist/src/app/pipeline.js')).href);
   const payload={platform:'tiktok',userId:'video-test',username:'fixture',displayName:'Fixture',message:'OAK HILL location?',commentOrDm:'dm',marcoPreviousOutbound:null,listingRef:null};
   const first=await pipeline.run(payload);assert.match(first.reply,/San Antonio/);assert.doesNotMatch(first.reply,/Austin/);
   const second=await pipeline.run({...payload,message:'price?'});assert.match(second.reply,/450,000/);
 });
 await check('database persists across reopen',()=>{store.close();const reopened=new VideoStore(path.join(dir,'videos.db'));assert.equal(reopened.get('account-a','222').state,'ready');reopened.close();});
 console.log(`Video knowledge: ${checks} offline checks passed. No messages sent, no live APIs used.`);
} finally {if(store.db.open)store.close();closeVideoStore();rmSync(dir,{recursive:true,force:true});}
