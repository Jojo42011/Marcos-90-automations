/** Fixed data conversions only; no model-authored code or inferred missing values. */
export function formatSourceValue(value:any,format='text'):string {
  if(value===null||value===undefined)return '';
  if(format==='date_only'){
    const text=value?.type==='excel_date'?value.value:String(value);
    if(!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(text))throw Error('Source is not an explicit ISO calendar date; no date was inferred');
    const date=text.slice(0,10),[year,month,day]=date.split('-').map(Number);
    const leap=year%4===0&&(year%100!==0||year%400===0);
    const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
    if(month<1||month>12||day<1||day>days[month-1])throw Error('Source calendar date is invalid; correct the source or report the exact invalid-date blocker. No date was inferred');
    return date;
  }
  if(typeof value==='object')throw Error('Select an actual scalar source value; objects are not silently converted to text');
  const text=String(value);
  if(format==='text')return text;
  if(format==='decimal_currency'){
    const match=text.trim().match(/^([-+]?)(?:[$£€]\s*)?(\d+)(?:\.(\d{2}))?$/);
    if(!match)throw Error('Currency format requires an observed whole amount or two-decimal amount; no rounding or value was inferred');
    return match[1]+match[2]+'.'+(match[3]||'00');
  }
  throw Error('Unknown source format');
}

/** Missing-only transfer: retain existing scalar fields and append literal history once. */
export function mergeMissingValue(current:string,incoming:string,history:boolean){
  if(!current)return incoming;
  if(!incoming||current===incoming||current.includes(incoming))return current;
  if(!history)return current;
  if(incoming.includes(current))return incoming;
  return current+'\n'+incoming;
}
