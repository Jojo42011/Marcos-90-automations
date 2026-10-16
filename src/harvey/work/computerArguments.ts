/** Normalize explicit computer-call envelopes, never invent targets or execute code. */
export function computerArguments(raw:any):Record<string,any> {
  const object=(v:any)=>{if(typeof v==='string'&&v.length<=32000){try{v=JSON.parse(v);}catch{return undefined;}}return v&&typeof v==='object'&&!Array.isArray(v)?v:undefined;};
  let input=object(raw)||{};
  for(let depth=0;depth<2;depth++){
    const nested=object(input.arguments)||object(input.input)||object(input.parameters);
    if(!input.tool&&!input.tool_name&&!input.name&&nested&&(nested.tool||nested.tool_name||nested.name)&&['call','tools',undefined].includes(nested.action)&&['call','tools',undefined].includes(input.action)){input={...nested,action:nested.action||input.action};continue;}break;
  }
  let name=input.tool??input.tool_name??input.name;
  const fn=object(name)||object(input.function);
  if(fn)name=fn.name;
  let action=input.action;
  if(typeof action==='string'&&/^browser_[a-z_]+$/.test(action)){
    if(typeof name==='string'&&name!==action)return {action:'invalid',tool:name,arguments:input.arguments||{}};
    name=action;action='call';
  }
  const aliases:Record<string,string>={snapshot:'browser_snapshot',scroll:'browser_scroll',read_table:'browser_read_table',wait_for:'browser_wait_for',inspect_scroll_regions:'browser_inspect_scroll_regions'};
  if(aliases[action]){name=aliases[action];action='call';}
  if(typeof name==='string'){name=name.replace(/^(?:functions\.|computer\.)/,'');name=aliases[name]||name;}
  if(!action&&name)action='call';
  const explicit=input.arguments??input.args??input.parameters??fn?.arguments;
  const args=explicit===undefined?Object.fromEntries(Object.entries(input).filter(([k])=>!['action','tool','tool_name','name','function'].includes(k))):object(explicit);
  return {action,...(name!==undefined?{tool:name}:{}),...(action==='call'?{arguments:args??explicit}:{} )};
}
