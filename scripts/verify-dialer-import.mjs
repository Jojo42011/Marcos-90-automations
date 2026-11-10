import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
// Exercise the current standalone Dialer importer. The CRM dialer was retired.
const source=readFileSync(new URL('../public/dialer.js',import.meta.url),'utf8');
const elements=new Map();
const element=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',close(){}});return elements.get(id);};
let submit,fail=false,requests=[],refreshed=0;
const context=vm.createContext({console,overview:{lists:[]},listId:'list-1',options:()=>'',esc:x=>x,$:element,
 modal:(_title,_body,onSubmit)=>{submit=onSubmit;},toast:()=>{},refresh:async()=>{refreshed++;},go:()=>{},
 api:async(path,body)=>{assert.equal(path,'/import');requests.push(body);if(fail)throw Error('Import unavailable');return {created:2,duplicates:3,invalid:0,sample:[]};}
});
vm.runInContext(source.slice(source.indexOf('  function importFile()'),source.indexOf('  async function contactDetail(')),context);
const form=new Map([['file',{size:50,text:async()=>'Name,Phone\nFixture,2105550199'}],['source','Fixture source'],['listId','list-1']]);
context.importFile();await submit(form);
assert.equal(requests[0].apply,false);assert.match(element('#importPreview').innerHTML,/2 new contacts/);
await submit(form);assert.equal(requests[1].apply,true);assert.equal(requests[1].source,'Fixture source');assert.equal(requests[1].listId,'list-1');assert.equal(refreshed,1);
form.set('source','Changed source');await submit(form);assert.equal(requests[2].apply,false,'changing source requires a fresh preview');
context.importFile();fail=true;await assert.rejects(()=>submit(form),/Import unavailable/);
fail=false;await submit(form);assert.equal(requests.at(-1).apply,false,'failed preview must not authorize applying');
form.set('file',{size:8000001,text:async()=>''});const before=requests.length;
await assert.rejects(()=>submit(form),/smaller than 8 MB/);assert.equal(requests.length,before);
console.log('Standalone Dialer import: preview-before-apply, source/list preservation, changed-input re-review, failed-preview recovery and file-size guard passed.');
