import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,openSync,ftruncateSync,closeSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import http from 'node:http';import {once} from 'node:events';
const require=createRequire(import.meta.url);process.env.HARVEY_BROWSER_ENABLED='true';process.env.HARVEY_WORK_DIR=mkdtempSync(join(tmpdir(),'browser-upload-'));
const B=require('../dist/src/harvey/work/browser.js'),F=require('../dist/src/harvey/work/files.js');let posts=0,received=0;
const server=http.createServer((req,res)=>{if(req.url==='/upload'){posts++;req.on('data',b=>received+=b.length);req.on('end',()=>res.end('Upload received'));return;}res.setHeader('Content-Type','text/html');res.end(`<h1>Upload fixture</h1><input id="file" type="file" accept="video/mp4" onchange="document.querySelector('#selected').textContent=this.files[0].name+' '+this.files[0].size"><p id="selected">No file selected</p><button id="send" onclick="const data=new FormData();data.append('file',document.querySelector('#file').files[0]);fetch('/upload',{method:'POST',body:data}).then(r=>r.text()).then(t=>document.querySelector('#result').textContent=t)">Send selected file</button><p id="result">Not uploaded</p>`);});
server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
const call=(tool,args={})=>B.browserCall('alice','upload',tool,args);const check=r=>assert(!r.error,JSON.stringify(r));
try{
 check(await call('browser_navigate',{url:base}));const dir=F.filesDir('alice','upload'),file=join(dir,'extensionless');
 writeFileSync(file,Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(32)]));const fd=openSync(file,'r+');ftruncateSync(fd,64*1024*1024);closeSync(fd);
 check(await call('browser_click',{target:'#file'}));
 await assert.rejects(call('browser_file_upload',{}),/requires paths/);
 // Bad arguments must leave the chooser open for correction.
 check(await call('browser_file_upload',{files:[file]}));
 let r=await call('browser_snapshot');check(r);assert.match(JSON.stringify(r),/extensionless.mp4 67108864/);assert.equal(posts,0);
 check(await call('browser_click',{target:'#send'}));
 check(await call('browser_wait_for',{text:'Upload received'}));assert.equal(posts,1);assert(received>64*1024*1024);
 check(await call('browser_snapshot'));assert.equal(posts,1);
 console.log('ok real native chooser, corrected arguments without cancellation, extensionless 64 MiB media and exactly one server-received multipart upload');
}finally{await B.closeBrowsers();server.closeAllConnections();await new Promise(r=>server.close(r));}
