import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),dir=mkdtempSync(join(tmpdir(),'video-edit-'));
process.env.HARVEY_WORK_DIR=dir;
const V=require('../dist/src/harvey/work/video.js'),F=require('../dist/src/harvey/work/files.js');
const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg';
function run(args){const p=spawnSync(ffmpeg,['-hide_banner','-loglevel','error',...args],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);}
const root=F.filesDir('alice','video'),source=join(root,'original.mov'),match=join(root,'match.mp4');
run(['-f','lavfi','-i','testsrc2=size=96x64:rate=24:duration=2.75','-f','lavfi','-i','sine=frequency=440:duration=2.75','-map','0:v','-map','1:a','-map','1:a','-c:v','libx264','-pix_fmt','yuv420p','-c:a:0','pcm_s16le','-c:a:1','aac','-threads','1',source]);
run(['-f','lavfi','-i','testsrc2=size=80x60:rate=30:duration=2.4','-c:v','libx264','-pix_fmt','yuv420p','-threads','1',match]);
const before=readFileSync(source),info=await F.inspectVideo('alice','video',{file:source});assert.equal(info.video.fps,24);assert.equal(info.audio.length,2);
const result=await F.editVideo('alice','video',{file:source,matchFile:match,durationSeconds:15});assert(!result.error,JSON.stringify(result));assert.equal(result.frames,72);assert.equal(result.durationSeconds,2.4);assert.equal(result.selectedAudio.codec,'aac');assert.equal(result.ignoredAudio[0].codec,'pcm_s16le');assert.equal(result.video.pixelFormat,'yuv420p');assert.equal(result.audio.length,1);assert.deepEqual(readFileSync(source),before);
const reused=await F.editVideo('alice','video',{file:'original.mov',matchFile:'match.mp4',durationSeconds:15});assert(reused.reused);assert.equal(reused.file,result.file);
const denied=await F.inspectVideo('bob','other',{file:source});assert(denied.error);
writeFileSync(join(root,'failed.mp4'),'');assert.equal((await F.inspectVideo('alice','video',{file:'failed.mp4'})).diagnostic.code,'incomplete_file');
const cancelled=new AbortController();cancelled.abort();await assert.rejects(F.editVideo('alice','video',{file:source,durationSeconds:1},cancelled.signal));
console.log('ok actual FFmpeg probe, AAC selection, matched duration/frame count, output decode, preserved originals, deduplication, owner confinement and cancellation');
if(process.platform!=='win32'){
  // Controlled first encoder failure exercises the real retry and cleanup path.
  const wrapper=join(dir,'ffmpeg-retry'),counter=join(dir,'attempts');
  writeFileSync(wrapper,`#!/usr/bin/env node\nconst fs=require('fs'),cp=require('child_process');const args=process.argv.slice(2);if(!args.includes('-decoders')){const n=fs.existsSync(${JSON.stringify(counter)})?Number(fs.readFileSync(${JSON.stringify(counter)},'utf8')):0;fs.writeFileSync(${JSON.stringify(counter)},String(n+1));if(n===0){fs.writeFileSync(args.at(-1),'incomplete');console.error('Cannot allocate memory');process.exit(1);}}const p=cp.spawnSync(${JSON.stringify(ffmpeg)},args,{stdio:'inherit'});process.exit(p.status??1);`);chmodSync(wrapper,0o755);process.env.FFMPEG_PATH=wrapper;
  const recovered=await F.editVideo('alice','video',{file:source,durationSeconds:1});assert(!recovered.error,JSON.stringify(recovered));assert.equal(recovered.attempts,2);assert.equal(recovered.recoveryAttempts[0].code,'resource_limit');assert.equal(readFileSync(counter,'utf8'),'2');assert(!readdirSync(join(root,'.media')).some(n=>n.endsWith('.mp4')));
  console.log('ok automatic lower-resource retry runs once, verifies output and removes only its own failed temporary output');
  const stall=join(dir,'ffmpeg-stall'),started=join(dir,'started');writeFileSync(stall,`#!/usr/bin/env node\nconst fs=require('fs'),cp=require('child_process');const args=process.argv.slice(2);if(args.includes('-decoders')){const p=cp.spawnSync(${JSON.stringify(ffmpeg)},args,{stdio:'inherit'});process.exit(p.status??1);}fs.writeFileSync(${JSON.stringify(started)},'yes');fs.writeFileSync(args.at(-1),'partial');setInterval(()=>{},1000);`);chmodSync(stall,0o755);process.env.FFMPEG_PATH=stall;
  const control=new AbortController();const pending=F.editVideo('alice','video',{file:source,durationSeconds:1.5},control.signal);const {existsSync}=await import('node:fs');for(let i=0;i<100&&!existsSync(started);i++)await new Promise(r=>setTimeout(r,30));assert(existsSync(started));control.abort();await assert.rejects(pending);assert(!readdirSync(join(root,'.media')).some(n=>n.endsWith('.mp4')));
  console.log('ok cancellation stops an in-flight encoder and retains original files');
}
