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
  const {browserCall,closeBrowsers,browserDirectory}=require('../dist/src/harvey/work/browser.js');
  try {
    const phase=process.argv[2], base=process.env.FIXTURE_URL;
    await browserCall('marco','agent-chat','browser_navigate',{url:base+(phase==='save'?'/login':'/private')});
    const result=await browserCall('marco','agent-chat','browser_snapshot',{});
    assert.match(JSON.stringify(result.content),/Signed in as fixture Marco/);
    const path=join(browserDirectory('marco','agent-chat'),'auth-state.json');
    assert(existsSync(path)); assert(JSON.parse(readFileSync(path,'utf8')).cookies.some(c=>c.name==='fixture_session'&&c.expires===-1));
    await closeBrowsers();
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
    if(req.url==='/login'){res.setHeader('Set-Cookie','fixture_session=valid; HttpOnly; SameSite=Lax; Path=/');res.end('<h1>Signed in as fixture Marco</h1>');}
    else res.end(req.headers.cookie?.includes('fixture_session=valid')?'<h1>Signed in as fixture Marco</h1>':'<h1>Please sign in</h1>');
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    for(const phase of ['save','restore']){
      const child=spawn(process.execPath,[process.argv[1],phase],{env:{...process.env,HARVEY_BROWSER_ENABLED:'true',HARVEY_WORK_DIR:root,FIXTURE_URL:'http://127.0.0.1:'+server.address().port},windowsHide:true,stdio:'inherit'});
      const [code]=await once(child,'exit');assert.equal(code,0);
    }
    console.log('Session-only sign-in survived a complete worker restart; another owner remained signed out.');
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
}
