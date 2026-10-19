import {createHash} from "crypto";
import {get,list,put,text,workDb} from "./store.js";
import {writeFileSync,readFileSync,existsSync} from "fs";
import {join} from "path";
import {formatSourceValue} from "./valueFormats.js";
import {filesDir,filePath,writeWorkspaceFile} from "./files.js";

/** Private, source-projected work product. It is not reusable teaching or new authorization. */
export function workRecords(owner:string,chatId:string,input:any) {
  get("chat",owner,chatId);
  const collection=text(input.collection,"Collection",80);
  const rows=()=>list<any>("work_record",owner).filter(r=>r.chatId===chatId&&r.collection===collection);
  if(input.action==="export"){
    let all=rows().sort(input.order==='saved'?(a,b)=>(a.sourceOrder??0)-(b.sourceOrder??0):(a,b)=>a.key.localeCompare(b.key));
    if(input._orderValues){
      const selected=input._orderValues.map((value:any,index:number)=>({value,index,matches:all.filter(r=>input._orderField?r.fields[input._orderField]===value:r.key===value)}));
      const missing=selected.filter((row:any)=>row.matches.length!==1);
      if(missing.length)return {error:'Source-order rows do not match the saved collection. No export was written. Retrieve or repair the specific observed source rows below, then retry the source-bound export.',missingCount:missing.length,
        missingSourceRows:missing.slice(0,30).map((row:any)=>({position:row.index+1,expectedValue:row.value,matches:row.matches.length,sourceRow:input._orderRows?.[row.index],sourceReference:input.orderFrom?{evidenceId:input.orderFrom.evidenceId,path:input.orderFrom.path+'/'+row.index}:undefined})),
        matchingField:input._orderField||'record key',savedFields:[...new Set(all.flatMap(r=>Object.keys(r.fields)))],
        note:'These are actual observed source values, not permission to invent data. Use each source row to retrieve its missing details or correct its missing field. For projections use the original sourceReference, not this repair response receipt. Preserve already verified records, exclude out-of-scope extras through source-bound export, and do not manually author the extracted CSV.'};
      all=selected.map((row:any)=>row.matches[0]);
      if(new Set(all.map(r=>r.key)).size!==all.length)throw Error('Observed source order contains duplicate record identities.');
    }
    if(input.keys!==undefined){
      const byKey=new Map(all.map(r=>[r.key,r]));
      if(!Array.isArray(input.keys)||!input.keys.length||input.keys.length>10000||new Set(input.keys).size!==input.keys.length||input.keys.some((key:any)=>typeof key!=='string'||!byKey.has(key)))throw Error('Export keys must be unique existing record keys in the exact requested output order; list the saved collection and use its actual keys.');
      all=input.keys.map((key:string)=>byKey.get(key)!);
    }
    if(!all.length)throw Error("No saved records in this collection. Retrieve and save the requested data first.");
    const requested=input.columns??[...new Set(all.flatMap(r=>Object.keys(r.fields)))];
    if(!Array.isArray(requested)||!requested.length||requested.length>200)throw Error('Use 1–200 saved fields as columns');
    const columns=requested.map(c=>typeof c==='string'?{field:c,header:c}:c);
    if(columns.some(c=>!c||typeof c.field!=='string'||!c.field||typeof c.header!=='string'||!c.header||c.field.length>80||c.header.length>80)||new Set(columns.map(c=>c.header)).size!==columns.length)throw Error('Use unique headers and actual saved field names');
    if(columns.some(c=>!all.some(r=>Object.prototype.hasOwnProperty.call(r.fields,c.field))))throw Error('A requested field has never been observed. Read the source and save that exact field before exporting');
    if(input._requireObserved&&columns.some(c=>all.some(r=>r.fields[c.field]!=null&&!['computer','inspect_screen','workspace_sheet','business_call','plugin_request','COMPOSIO_MULTI_EXECUTE_TOOL'].includes(r.fieldSources?.[c.field]?.tool||r.source?.tool))))throw Error('External extraction exports require actual website, connector or native workbook source values, not an agent-authored intermediate file');
    const headers=columns.map(c=>c.header),includeId=input.includeSourceId!==false;
    const cell=(v:unknown)=>{let value=v==null?'':typeof v==='object'?JSON.stringify(v):String(v);if(/^[\s]*[=+@-]/.test(value)||/^[\t\r\n]/.test(value))value="'"+value;return '"'+value.replace(/"/g,'""')+'"';};
    const csv='\uFEFF'+[[...(includeId?['source_id']:[]),...headers].map(cell).join(','),...all.map(r=>[...(includeId?[r.key]:[]),...columns.map(c=>{const v=Object.prototype.hasOwnProperty.call(r.fields,c.field)?r.fields[c.field]:null;return c.format?formatSourceValue(v,c.format):v;})].map(cell).join(','))].join('\r\n')+'\r\n';
    const hash=createHash('sha256').update(csv).digest('hex'),name=input.file||'records-'+hash.slice(0,20)+'.csv';
    if(input.file){if(!/\.csv$/i.test(name))throw Error('Export filename must end in .csv');writeWorkspaceFile(owner,chatId,{file:name,content:csv,expectedSha256:input.expectedSha256});}
    else{const path=join(filesDir(owner,chatId),name);if(!existsSync(path))writeFileSync(path,csv,{encoding:'utf8',flag:'wx',mode:0o600});}
    if(readFileSync(filePath(owner,chatId,name),'utf8')!==csv)throw Error('Export verification failed');
    return {file:name,download:`/api/harvey/work/files/${chatId}/${encodeURIComponent(name)}`,rows:all.length,columns:headers,sha256:hash,
      missingByColumn:Object.fromEntries(columns.map(c=>[c.header,all.filter(r=>!Object.prototype.hasOwnProperty.call(r.fields,c.field)||r.fields[c.field]==null).length])),
      note:'Verified CSV of saved observations only, not proof of full source coverage or correct filters. Unread fields remain blank; confirmed empty source strings remain empty. Formula-like cells are escaped for spreadsheet safety. Reconcile expected counts and exclusions before reporting the requested export complete.'};
  }
  if(input.action==="save"){
    // Only the agent loop supplies this projection after checking current tool evidence.
    const records=input._verifiedRecords;
    if(!Array.isArray(records)||!records.length||records.length>30)throw Error("Save records through source evidence, not unsupported values");
    workDb().transaction(()=>{const existing=new Map(rows().map(r=>[r.id,r]));for(const record of records){
      const id=createHash("sha256").update(JSON.stringify([chatId,collection,record.key])).digest("hex");
      const previous=existing.get(id);
      const sourceOrder=previous?.sourceOrder??Math.max(-1,...[...existing.values()].map((r:any)=>r.sourceOrder??-1))+1;
      const origins=(r:any)=>r?.fieldSources??Object.fromEntries(Object.keys(r?.fields||{}).map(field=>[field,{tool:r.source?.tool,observedAt:r.source?.observedAt,path:r.source?.paths?.[field]}]));
      // Profiles arrive in sections. Only newly observed fields replace old
      // values (including explicit null); retain the original field provenance.
      const saved=put("work_record",owner,{id,chatId,collection,...record,sourceOrder,fields:{...previous?.fields,...record.fields},fieldSources:{...origins(previous),...origins(record)}});
      existing.set(id,saved);
    }}).immediate();
    return {saved:records.length,total:rows().length,note:"Source values saved; this does not establish complete coverage or correct field interpretation. Read records before writing the final document."};
  }
  if(input.action!=="list")throw Error("Use save, list or export");
  const offset=input.offset??0;if(!Number.isInteger(offset)||offset<0)throw Error("Invalid offset");
  const all=rows(),items:any[]=[];let size=0;
  for(const row of all.slice(offset,offset+20)){const n=JSON.stringify(row).length;if(items.length&&size+n>9000)break;items.push(row);size+=n;}
  return {items,total:all.length,nextOffset:offset+items.length<all.length?offset+items.length:null,note:"Stored observations, not proof the source remains current. Coverage and missing sections must be checked separately."};
}
