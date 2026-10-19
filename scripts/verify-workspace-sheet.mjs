// Native workbook reader fixtures. No customer data, provider calls or browser operations.
import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {mkdtempSync,writeFileSync,copyFileSync,readFileSync,symlinkSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
const require=createRequire(import.meta.url);process.env.HARVEY_WORK_DIR=mkdtempSync(join(tmpdir(),'harvey-sheet-'));
const Excel=require('exceljs'),F=require('../dist/src/harvey/work/files.js'),S=require('../dist/src/harvey/work/spreadsheet.js'),{TurnVerification}=require('../dist/src/harvey/reliability.js');
const file=join(F.filesDir('alice','sheet'),'source.xlsx'),book=new Excel.Workbook(),sheet=book.addWorksheet('Inputs');book.addWorksheet('Empty');
sheet.addRow(['Name','Zero','History','Date','Formula','Uncached','Error','Link','Rich']);
const history='  Observed history with unicode 😀 and whitespace\n'.repeat(400);
sheet.addRow(['Fixture',0,history,new Date('2026-10-20T00:00:00.000Z'),{formula:'1+2',result:3},{formula:'1+3'},{error:'#DIV/0!'},{text:'Reference',hyperlink:'https://example.com/'},{richText:[{text:'Keep '},{text:'spaces'}]}]);
sheet.addRow(['Other',null,history]);sheet.getCell('D2').numFmt='mm/dd/yyyy';await book.xlsx.writeFile(file);
const bytes=readFileSync(file);const read=input=>S.readWorkspaceSheet('alice','sheet',{file:'source.xlsx',...input});
const meta=await read({});assert.equal(meta.sheets[0].rows,3);assert.equal(meta.sheets[0].columns,9);assert.equal(meta.sheets[0].headers[2].label,'History');
assert.deepEqual((await read({sheet:'Inputs',range:'A2:B3',offset:0})).rows,(await read({sheet:'Inputs',range:'A2:B3'})).rows);await assert.rejects(read({sheet:'Inputs',range:'A2:B3',offset:1}),/use range for rows/);
const row=await read({sheet:'Inputs',range:'A2:B3'});assert.equal(row.truncated,false);assert.equal(row.rows[0].values.B,0);assert.equal(row.rows[1].values.B,null);assert.notEqual(row.rows[0].id,row.rows[1].id);
const ledger=new TurnVerification(),r=ledger.record('workspace_sheet',{},row);assert.equal(r.observation,true);assert.equal(r.scope,'files');assert.equal(ledger.projectRecords([{evidenceId:r.id,idPath:'/rows/0/id',fieldPaths:{name:'/rows/0/values/A'}}])[0].fields.name,'Fixture');
const preview=await read({sheet:'Inputs',range:'C2:C2'});assert(preview.truncated);assert.equal(preview.rows[0].values.C.totalCharacters,history.length);
let full='',offset=0,last;
do{const part=await read({sheet:'Inputs',cell:'C2',offset});last=ledger.record('workspace_sheet',{},part);full+=part.content;offset=part.nextOffset;}while(offset!==null);
assert.equal(full,history);assert.equal(last.completeCellRead,true);assert.equal(ledger.review({status:'completed',evidenceIds:[last.id],checks:['Read every character in C2 at the current source hash'],limitations:[]}).accepted,true);
const crossed=new TurnVerification();crossed.record('workspace_sheet',{},await read({sheet:'Inputs',cell:'C2'}));const otherPart=crossed.record('workspace_sheet',{},await read({sheet:'Inputs',cell:'C3',offset:8000}));assert(!otherPart.completeCellRead);assert.throws(()=>crossed.review({status:'completed',evidenceIds:[otherPart.id],checks:['Incorrectly mixed different cells'],limitations:[]}),/smaller/);
const typed=await read({sheet:'Inputs',range:'D2:I2'}),v=typed.rows[0].values;assert.equal(v.D.value,'2026-10-20T00:00:00.000');assert.equal(v.D.timezone,null);assert.equal(v.E.cachedResult,3);assert.equal(v.F.missingCachedResult,true);assert.equal(v.G.error,'#DIV/0!');assert.equal(v.H.hyperlink,'https://example.com/');assert.equal(v.I,'Keep spaces');
assert.equal((await read({sheet:'Empty'})).totalRows,0);
await assert.rejects(read({sheet:'Missing'}),/Worksheet not found/);await assert.rejects(read({sheet:'Inputs',range:'A1:XFD1048576'}),/existing worksheet range/);await assert.rejects(read({sheet:'Inputs',cell:'A0'}),/cell address/);await assert.rejects(read({expectedSha256:'wrong'}),/changed/);await assert.rejects(S.readWorkspaceSheet('bob','sheet',{file:'source.xlsx'}));await assert.rejects(read({file:'../source.xlsx'}));
if(process.platform!=='win32'){const escaped=join(F.filesDir('bob','sheet'),'outside.xlsx');writeFileSync(escaped,bytes);symlinkSync(escaped,join(F.filesDir('alice','sheet'),'escape.xlsx'));await assert.rejects(read({file:'escape.xlsx'}),/outside/);}
writeFileSync(file,'not an XLSX');await assert.rejects(read({}),/could not be parsed/);writeFileSync(file,bytes);assert.equal((await read({})).sha256,meta.sha256);
assert.deepEqual(readFileSync(file),bytes);
console.log('PASS native XLSX ranges, source projections, long-cell coverage, cell/hash isolation, null/zero/date/formula/error/rich text/link preservation, revision checks, cache recovery and owner/path boundaries; $0 provider spend');
