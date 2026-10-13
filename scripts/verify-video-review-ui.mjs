import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const pageHtml=readFileSync('public/video-knowledge.html');
const video={post:'123',url:'https://www.tiktok.com/@fixture/video/123',published:'2026-10-01T00:00:00Z',state:'needs_confirmation',revision:'v1',approval:JSON.stringify({mode:'review_required',reasons:['Location is missing matching transcript evidence.']}),warnings:JSON.stringify(['A model claim was omitted.']),caption:'<img src=x onerror=alert(1)> 5 bedrooms',transcript:'six bedrooms',notes:JSON.stringify({facts:[{field:'city',value:'San Antonio',quote:'San Antonio',source:'caption'}],keywords:['elevator']}),conflicts:JSON.stringify([{field:'bedrooms',question:'The sources disagree about bedrooms. Which value is correct?',candidates:[{field:'bedrooms',value:'5 bedrooms',quote:'5 bedrooms',source:'caption'},{field:'bedrooms',value:'six bedrooms',quote:'six bedrooms',source:'transcript'}]}])};
let approvals=[], stale=false;
const server=createServer(async(req,res)=>{
 if(req.url.startsWith('/api/video-knowledge')){
  let data='';for await(const chunk of req)data+=chunk;
  res.setHeader('Content-Type','application/json');
  if(req.method==='POST'){const body=JSON.parse(data);if(body.action==='approve'){approvals.push(body);if(stale){res.statusCode=400;return res.end(JSON.stringify({error:'Video changed; reload before reviewing'}));}video.state='ready';return res.end(JSON.stringify(video));}if(body.action==='preview')return res.end(JSON.stringify({reply:'Test preview reply',sent:false}));}
  return res.end(JSON.stringify({enabled:true,repliesEnabled:false,summary:{needs_confirmation:1},items:[video]}));
 }res.setHeader('Content-Type','text/html');res.end(pageHtml);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({headless:true,...(process.env.VIDEO_TEST_BROWSER?{executablePath:process.env.VIDEO_TEST_BROWSER}:{})});const page=await browser.newPage({viewport:{width:390,height:844}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port+'/video-knowledge.html');
 await page.getByRole('button',{name:'Approve selected facts'}).waitFor();
 assert.equal(await page.locator('#items img').count(),0);assert.equal(await page.getByText('Location is missing matching transcript evidence.').count(),1);
 await page.getByRole('button',{name:'Approve selected facts'}).click();assert.equal(approvals.length,0);
 await page.getByLabel('Resolve bedrooms').selectOption('0');await page.getByLabel('Reason for bedrooms').fill('Fixture reviewer verified caption');
 await page.getByRole('button',{name:'Approve selected facts'}).click();assert.equal(approvals.length,0);await page.getByLabel('I checked these omissions against the sources.').check();
 await page.getByRole('button',{name:'Approve selected facts'}).click();await page.waitForFunction(()=>document.querySelector('article[data-state=ready]'));
 assert.deepEqual(approvals[0].resolutions,[{field:'bedrooms',candidate:0,reason:'Fixture reviewer verified caption'}]);assert.equal(approvals[0].revision,'v1');assert.equal(approvals[0].acknowledgeWarnings,true);
 stale=true;await page.getByLabel('I checked these omissions against the sources.').check();await page.getByLabel('Resolve bedrooms').selectOption('omit');await page.getByLabel('Reason for bedrooms').fill('Cannot verify count');await page.getByRole('button',{name:'Approve selected facts'}).click();await page.waitForFunction(()=>document.getElementById('error').textContent.includes('Video changed'));
 await page.getByLabel('Message or video link').fill('ELEVATOR bedrooms?');await page.getByRole('button',{name:'Preview reply'}).click();await page.waitForFunction(()=>document.getElementById('previewResult').textContent.includes('Nothing sent'));
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);video.approval=JSON.stringify({mode:'automatic',reasons:[]});await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('Automatically approved — both sources support every extracted detail.').waitFor();
 console.log('Video review UI passed: explicit decision required, source text inert, revision sent, stale review shown, no-send preview, mobile layout.');
}finally{await browser?.close();await new Promise(r=>server.close(r));}
