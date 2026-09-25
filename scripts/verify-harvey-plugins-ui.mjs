// Local browser fixture: no application server or connected provider is contacted.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
const browser=await chromium.launch(process.env.PW_CHROMIUM?{executablePath:process.env.PW_CHROMIUM}:{});
try {
  const page=await browser.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html></html>'}));
  await page.goto('http://harvey.test/harvey');
  await page.setContent(readFileSync('public/harvey.html','utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,''));
  await page.addScriptTag({content:readFileSync('public/harvey-work.js','utf8')});
  await page.evaluate(()=>{
    window.requests=[];window.pending=[];window.fixtureConnected=false;
    const app=slug=>({name:slug,slug,isNoAuth:false});
    window.hooks={state:{projectId:null,mode:'chat',view:'chat',conversations:[]},
      showView(view){this.state.view=view;document.getElementById('view-work').hidden=false;},
      toast(message){window.lastToast=message;},newChat(){},refresh(){},
      async api(path){
        window.requests.push(path);const u=new URL(path,location.origin);let data={};
        if(u.pathname.endsWith('/work/status'))data={};
        else if(u.pathname.endsWith('/projects'))data={projects:[]};
        else if(u.pathname.endsWith('/work/plugins'))data={connections:[],catalog:[]};
        else if(u.pathname.endsWith('/work/managed/connect'))data={url:'http://harvey.test/authorize'};
        else if(u.pathname.endsWith('/work/managed')){
          const q=u.searchParams.get('search')||'',cursor=u.searchParams.get('cursor');
          if(q==='slow')return new Promise(resolve=>window.pending.push(()=>resolve({ok:true,data:{enabled:true,items:[app('Stale result')],cursor:null}})));
          if(q==='error')return {ok:false,error:'Fixture catalog unavailable'};
          data={enabled:true,connected:window.fixtureConnected?[{...app('Canva'),scope:'owner',connection:{isActive:true}}]:[],
            items:q==='video'?(cursor?[app('VideoDB')]:[app('Captions')]):(cursor?[app('Drive'),app('Canva')]:[app('Gmail'),app('Drive')]),cursor:cursor?null:'second-page'};
        }
        return {ok:true,data};
      }};
    window.HarveyWork.init(window.hooks);
  });
  await page.locator('[data-work-view="plugins"]').first().click();
  await page.waitForSelector('#pluginLoadMore:not([hidden])');
  await page.locator('#pluginLoadMore').click();
  await page.waitForFunction(()=>document.querySelectorAll('#managedGrid .plugin-card').length===3);
  assert(await page.locator('#pluginLoadMore').isHidden());
  assert((await page.locator('#managedGrid').textContent()).includes('Canva'));
  console.log('ok full catalog pagination appends apps and deduplicates overlap');
  await page.locator('#pluginSearch').fill('video');
  await page.waitForFunction(()=>document.getElementById('managedGrid').textContent.includes('Captions'));
  await page.locator('#pluginLoadMore').click();
  await page.waitForFunction(()=>document.getElementById('managedGrid').textContent.includes('VideoDB'));
  assert(await page.evaluate(()=>window.requests.some(p=>p.includes('search=video&cursor=second-page'))));
  console.log('ok search pages preserve the query and stop at the final cursor');
  await page.locator('#pluginSearch').fill('slow');
  await page.waitForFunction(()=>window.pending.length===1);
  await page.locator('#pluginSearch').fill('video');
  await page.waitForFunction(()=>document.getElementById('managedGrid').textContent.includes('Captions'));
  await page.evaluate(()=>window.pending.shift()());
  assert(!(await page.locator('#managedGrid').textContent()).includes('Stale result'));
  await page.locator('#pluginSearch').fill('error');
  await page.waitForFunction(()=>document.getElementById('pluginSearchStatus').textContent.includes('Fixture catalog unavailable'));
  await page.locator('#pluginSearch').fill('');
  await page.waitForFunction(()=>document.getElementById('managedGrid').textContent.includes('Gmail'));
  console.log('ok late search responses cannot overwrite newer results; errors recover');
  await page.locator('#pluginSearch').fill('slow');
  await page.waitForFunction(()=>window.pending.length===1);
  await page.evaluate(()=>{window.fixtureConnected=true;window.dispatchEvent(new Event('focus'));});
  await page.waitForSelector('.connected-badge');
  await page.evaluate(()=>window.pending.shift()());
  assert(!(await page.locator('#managedGrid').textContent()).includes('Stale result'));
  assert((await page.locator('.plugin-intro').textContent()).includes('scheduled agents'));
  console.log('ok returning from authorization refreshes connected apps and invalidates the previous catalog');
  await page.locator('#managedGrid [data-work-action="managed-connect"]').first().click();
  await page.waitForURL('**/authorize');
  assert.deepEqual(errors,[]);
  console.log('ok connect navigates to the provider sign-in URL without browser errors');
} finally {await browser.close();}
