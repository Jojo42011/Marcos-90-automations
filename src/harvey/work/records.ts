import {createHash} from "crypto";
import {get,list,put,text,workDb} from "./store.js";
import {writeFileSync,readFileSync,existsSync} from "fs";
import {join} from "path";
import {filesDir,filePath} from "./files.js";

/** Private, source-projected work product. It is not reusable teaching or new authorization. */
export function workRecords(owner:string,chatId:string,input:any) {
  get("chat",owner,chatId);
  const collection=text(input.collection,"Collection",80);
  const rows=()=>list<any>("work_record",owner).filter(r=>r.chatId===chatId&&r.collection===collection);
  if(input.action==="export"){
    const all=rows().sort((a,b)=>a.key.localeCompare(b.key));
    if(!all.length)throw Error("No saved records in this collection. Retrieve and save the requested data first.");
    const columns=input.columns??[...new Set(all.flatMap(r=>Object.keys(r.fields)))];
    if(!Array.isArray(columns)||!columns.length||columns.length>30||columns.some(c=>typeof c!=="string"||!c.length||c.length>80)||new Set(columns).size!==columns.length)throw Error("Use 1–30 unique saved field names as columns");
    if(columns.some(c=>!all.some(r=>Object.prototype.hasOwnProperty.call(r.fields,c))))throw Error("A requested column has never been observed. Retrieve that field before exporting it.");
    const cell=(v:unknown)=>{let value=v==null?'':typeof v==='object'?JSON.stringify(v):String(v);if(/^[\s]*[=+@-]/.test(value)||/^[\t\r\n]/.test(value))value="'"+value;return '"'+value.replace(/"/g,'""')+'"';};
    const csv='\uFEFF'+[['source_id',...columns].map(cell).join(','),...all.map(r=>[r.key,...columns.map(c=>Object.prototype.hasOwnProperty.call(r.fields,c)?r.fields[c]:null)].map(cell).join(','))].join('\r\n')+'\r\n';
    const hash=createHash('sha256').update(csv).digest('hex'),name='records-'+hash.slice(0,20)+'.csv',path=join(filesDir(owner,chatId),name);
    if(!existsSync(path))writeFileSync(path,csv,{encoding:'utf8',flag:'wx',mode:0o600});
    if(readFileSync(filePath(owner,chatId,name),'utf8')!==csv)throw Error('Export verification failed');
    return {file:name,download:`/api/harvey/work/files/${chatId}/${name}`,rows:all.length,columns,sha256:hash,
      missingByColumn:Object.fromEntries(columns.map(c=>[c,all.filter(r=>!Object.prototype.hasOwnProperty.call(r.fields,c)||r.fields[c]==null).length])),
      note:'Verified CSV of saved observations only, not proof of full source coverage or correct filters. Unread fields remain blank; confirmed empty source strings remain empty. Formula-like cells are escaped for spreadsheet safety. Reconcile expected counts and exclusions before reporting the requested export complete.'};
  }
  if(input.action==="save"){
    // Only the agent loop supplies this projection after checking current tool evidence.
    const records=input._verifiedRecords;
    if(!Array.isArray(records)||!records.length||records.length>30)throw Error("Save records through source evidence, not unsupported values");
    workDb().transaction(()=>{const existing=new Map(rows().map(r=>[r.id,r]));for(const record of records){
      const id=createHash("sha256").update(JSON.stringify([chatId,collection,record.key])).digest("hex");
      const previous=existing.get(id);
      const origins=(r:any)=>r?.fieldSources??Object.fromEntries(Object.keys(r?.fields||{}).map(field=>[field,{tool:r.source?.tool,observedAt:r.source?.observedAt,path:r.source?.paths?.[field]}]));
      // Profiles arrive in sections. Only newly observed fields replace old
      // values (including explicit null); retain the original field provenance.
      const saved=put("work_record",owner,{id,chatId,collection,...record,fields:{...previous?.fields,...record.fields},fieldSources:{...origins(previous),...origins(record)}});
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
