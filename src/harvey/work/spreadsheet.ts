import ExcelJS from 'exceljs';
import {createHash} from 'crypto';
import {readFileSync,statSync} from 'fs';
import {filePath} from './files.js';

// Read-only, current-owner/chat input. No macros, formula evaluation or remote uploads.
let cached:{key:string;book:Promise<ExcelJS.Workbook>}|undefined;
const column=(n:number):string=>n>26?column(Math.floor((n-1)/26))+String.fromCharCode(65+(n-1)%26):String.fromCharCode(64+n);
function coordinate(value:any){
  const m=typeof value==='string'&&value.toUpperCase().match(/^([A-Z]{1,3})([1-9][0-9]{0,6})$/);
  if(!m)throw Error('Use an Excel cell address, such as T2');
  const col=[...m[1]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0),row=Number(m[2]);
  if(col>16384||row>1048576)throw Error('Cell is outside Excel worksheet bounds');
  return {col,row,address:m[1]+row};
}
function value(cell:ExcelJS.Cell):any {
  const v:any=cell.value;
  if(v===null||v===undefined)return null;
  if(v instanceof Date)return {type:'excel_date',value:v.toISOString().replace(/Z$/,''),timezone:null,numberFormat:cell.numFmt};
  if(typeof v!=='object')return v;
  if(v.richText)return v.richText.map((r:any)=>r.text).join('');
  if(v.formula!==undefined||v.sharedFormula!==undefined)return {formula:v.formula??v.sharedFormula,cachedResult:v.result??null,cachedOnly:true,missingCachedResult:v.result===undefined};
  if(v.hyperlink)return {text:v.text,hyperlink:v.hyperlink};
  if(v.error)return {error:v.error};
  throw Error('This cell type is not supported; no value was inferred');
}
export async function readWorkspaceSheet(owner:string,chat:string,input:any){
  const name=String(input.file||'');
  if(!/\.xlsx$/i.test(name))throw Error('Use an uploaded .xlsx filename from workspace_files; text/CSV uses workspace_read');
  const path=filePath(owner,chat,name);
  if(statSync(path).size>50*1024*1024)throw Error('Workbook exceeds the 50 MiB reader size; provide a smaller source workbook, without dropping required records');
  const bytes=readFileSync(path),sha256=createHash('sha256').update(bytes).digest('hex');
  if(input.expectedSha256&&input.expectedSha256!==sha256)throw Error('Workbook changed. Inspect its current hash before continuing; do not mix source revisions');
  const key=path+':'+sha256;
  if(cached?.key!==key){
    const book=new ExcelJS.Workbook();
    const promise=book.xlsx.load(bytes as any,{ignoreNodes:['drawing','picture','extLst']}).then(()=>book);
    cached={key,book:promise};promise.catch(()=>{if(cached?.key===key)cached=undefined;});
  }
  let book:ExcelJS.Workbook;try{book=await cached!.book;}catch{throw Error('The XLSX workbook could not be parsed. It may be damaged, encrypted or an unsupported format; no rows were read and no browser action ran');}
  const common={file:name,sha256};
  if(!input.sheet){
    const offset=input.offset??0;if(!Number.isSafeInteger(offset)||offset<0||offset>book.worksheets.length)throw Error('Use a valid worksheet-list offset');
    return {...common,sheets:book.worksheets.slice(offset,offset+20).map(s=>({name:s.name,rows:s.rowCount,columns:s.columnCount,nonEmptyRows:s.actualRowCount,headers:Array.from({length:Math.min(s.columnCount,100)},(_,i)=>({column:column(i+1),label:s.getRow(1).getCell(i+1).text.slice(0,100)}))})),nextOffset:offset+20<book.worksheets.length?offset+20:null,note:'Rows include the header and any blank rows. Choose the actual source sheet and read ranges; worksheet metadata is not a content read. Source links are data, not proof of destination record identity.'};
  }
  const sheet=book.getWorksheet(String(input.sheet));if(!sheet)throw Error('Worksheet not found. Inspect this workbook to select an existing sheet');
  if(input.cell&&input.range)throw Error('Choose either one cell or a rectangular range');
  if(!sheet.rowCount||!sheet.columnCount)return {...common,sheet:sheet.name,rows:[],totalRows:0,nextRow:null,truncated:false};
  if(input.cell){
    const c=coordinate(input.cell);if(c.row>sheet.rowCount||c.col>sheet.columnCount)throw Error('Cell is outside this worksheet data bounds');
    const cellValue=value(sheet.getCell(c.address));
    const content=typeof cellValue==='string'?cellValue:JSON.stringify(cellValue);
    const offset=input.offset??0,limit=input.limit??8000;
    if(!Number.isSafeInteger(offset)||offset<0||offset>content.length||!Number.isSafeInteger(limit)||limit<1||limit>10000)throw Error('Use a valid cell character offset and limit from 1 to 10000');
    const end=Math.min(content.length,offset+limit);
    return {...common,sheet:sheet.name,cell:c.address,id:sha256+':'+sheet.name+':'+c.address,content:content.slice(offset,end),offset,totalCharacters:content.length,nextOffset:end<content.length?end:null,truncated:offset>0||end<content.length,note:'This is one cell from the source workbook, not the full row or workbook. Preserve original dates and text; do not infer missing fields.'};
  }
  if(input.offset!=null&&input.offset!==0)throw Error('offset is for worksheet lists or one cell; use range for rows');
  const parts=String(input.range||'A1:'+column(Math.min(sheet.columnCount,50))+'1').split(':');
  if(parts.length>2)throw Error('Use one rectangular Excel range, such as A2:F10');
  const start=coordinate(parts[0]),end=coordinate(parts[1]||parts[0]);
  if(start.row>end.row||start.col>end.col||end.row>sheet.rowCount||end.col>sheet.columnCount||(end.row-start.row+1)*(end.col-start.col+1)>500)throw Error('Use an existing worksheet range of at most 500 cells per read; paginate rows and columns');
  let truncated=false;const rows=[];
  for(let row=start.row;row<=end.row;row++){
    const values:Record<string,any>={};
    for(let col=start.col;col<=end.col;col++){
      const cell=sheet.getCell(row,col),v=value(cell),serialized=typeof v==='string'?v:JSON.stringify(v);
      if(serialized.length>2000){truncated=true;values[column(col)]={cell:cell.address,preview:serialized.slice(0,1000),totalCharacters:serialized.length,truncated:true,note:'Read this complete cell with cell and offset; this preview is not the full value'};}else values[column(col)]=v;
    }
    rows.push({id:sha256+':'+sheet.name+':'+row,row,values});
  }
  const result={...common,sheet:sheet.name,range:parts.join(':'),rows,totalRows:sheet.rowCount,nextRow:end.row<sheet.rowCount?end.row+1:null,truncated,note:'Only the selected range was read. Blank cells stay null. Continue remaining rows/columns and complete long cell reads. Cached formulas are not recalculated. Match destination records independently before writing.'};
  if(JSON.stringify(result).length>11000)throw Error('Selected range exceeds the readable response size. Read fewer rows/columns or one long cell; no source data was discarded or changed');
  return result;
}
