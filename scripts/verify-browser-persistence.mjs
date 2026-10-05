import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
if(process.argv[2]) {
  const {browserCall,closeBrowsers,browserDirectory,browserPreview}=require('../dist/src/harvey/work/browser.js');
  try {
    const phase=process.argv[2], base=process.env.FIXTURE_URL;
    assert.equal((await browserPreview('marco','agent-chat')).state,'closed');
    await browserCall('marco','agent-chat','browser_navigate',{url:base+(phase==='save'?'/login':'/private')});
    const result=await browserCall('marco','agent-chat','browser_snapshot',{});
    assert.match(JSON.stringify(result.content),/Signed in as fixture Marco/);
    const snapshot=result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
    const ref=snapshot.match(/button "Verify control" \[ref=([^\]]+)\]/)?.[1];
    assert(ref,'Fixture control must have a current reference');
    await assert.rejects(()=>browserCall('marco','agent-chat','browser_click',{target:'missing999',ref:'missing999',element:'Missing control'}),/target changed/);
    await browserCall('marco','agent-chat','browser_click',{target:ref,ref,element:'Verify control'});
    const clicked=await browserCall('marco','agent-chat','browser_snapshot',{});
    assert.match(JSON.stringify(clicked.content),/Control verified/);
    const path=join(browserDirectory('marco','agent-chat'),'auth-state.json');
    assert(existsSync(path)); assert(JSON.parse(readFileSync(path,'utf8')).cookies.some(c=>c.name==='fixture_session'&&c.expires===-1));
    const preview=await browserPreview('marco','agent-chat');
    assert.equal(preview.state,'ready',JSON.stringify(preview));assert.match(preview.frame.image,/^data:image\/jpeg;base64,/);
    assert(preview.frame.url.startsWith(base));assert.equal((await browserPreview('marco','different-chat')).state,'closed');
    assert.equal((await browserPreview('wesley','agent-chat')).state,'closed');
    const again=await browserPreview('marco','agent-chat');assert.equal(again.frame.capturedAt,preview.frame.capturedAt);
    await closeBrowsers();
    assert.equal((await browserPreview('marco','agent-chat')).state,'closed');
    if(phase==='restore') {
      await browserCall('wesley','agent-chat','browser_navigate',{url:base+'/private'});
      const other=await browserCall('wesley','agent-chat','browser_snapshot',{});
      assert.match(JSON.stringify(other.content),/Please sign in/);
    }
    console.log('Browser persistence phase passed: '+phase);
  } finally {await closeBrowsers();}
} else {
  const root=mkdtempSync(join(tmpdir(),'browser-persistence-'));
  const server=http.createServer((req,res)=>{
    res.setHeader('Content-Type','text/html');
    if(req.url==='/login'){res.setHeader('Set-Cookie','fixture_session=valid; HttpOnly; SameSite=Lax; Path=/');res.end('<h1>Signed in as fixture Marco</h1><button onclick="this.textContent=&quot;Control verified&quot;">Verify control</button>');}
    else res.end(req.headers.cookie?.includes('fixture_session=valid')?'<h1>Signed in as fixture Marco</h1><button onclick="this.textContent=&quot;Control verified&quot;">Verify control</button>':'<h1>Please sign in</h1>');
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    for(const phase of ['save','restore']){
      const child=spawn(process.execPath,[process.argv[1],phase],{env:{...process.env,HARVEY_BROWSER_ENABLED:'true',HARVEY_WORK_DIR:root,FIXTURE_URL:'http://127.0.0.1:'+server.address().port},windowsHide:true,stdio:'inherit'});
      const [code]=await once(child,'exit');assert.equal(code,0);
    }
    console.log('Session-only sign-in survived a complete worker restart; another owner remained signed out.');
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
}
