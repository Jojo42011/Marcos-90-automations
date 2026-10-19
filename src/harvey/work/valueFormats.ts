/** Fixed data conversions only; no model-authored code or inferred missing values. */
export function formatSourceValue(value:any,format='text'):string {
  if(value===null||value===undefined)return '';
  if(format==='date_only'){
    const text=value?.type==='excel_date'?value.value:String(value);
    if(!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(text))throw Error('Source is not an explicit ISO calendar date; no date was inferred');
    return text.slice(0,10);
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
