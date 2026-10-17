/** Adapt known legacy locator keys to the installed tool schema, without guessing targets. */
export function browserArguments(schema:any,input:any){
  if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Browser arguments must be an object");
  const args={...input},props=schema?.properties||{};
  if(props.values?.type==='array'&&args.value!==undefined){
    const values=Array.isArray(args.value)?args.value:[args.value];
    if(args.values!==undefined&&JSON.stringify(args.values)!==JSON.stringify(values))throw Error('Conflicting browser selection arguments; use values');
    args.values=values;delete args.value;
  }
  for(const [canonical,aliases] of [["target",["ref","selector"]],["startTarget",["startRef"]],["endTarget",["endRef"]]] as const){
    if(!props[canonical])continue;
    for(const alias of aliases){
      if(args[alias]===undefined)continue;
      if(args[canonical]!==undefined&&args[canonical]!==args[alias])throw new Error("Conflicting browser target arguments; use only "+canonical);
      args[canonical]=args[alias];delete args[alias];
    }
  }
  if(Array.isArray(args.fields)&&props.fields?.items)args.fields=args.fields.map((f:any)=>browserArguments(props.fields.items,f));
  for(const required of schema?.required||[])if(args[required]===undefined){
    // Zod's JSON schema can mark defaulted inputs required; honor the installed
    // default instead of rejecting valid calls such as viewport screenshots.
    if(props[required]?.default!==undefined)args[required]=props[required].default;
    else throw new Error("Missing browser argument: "+required+". Use the attached installed schema.");
  }
  for(const [key,value] of Object.entries(args)){
    const p=props[key];if(!p)continue;
    const types=Array.isArray(p.type)?p.type:p.type?[p.type]:[];
    const matches=(t:string)=>t==="null"?value===null:t==="array"?Array.isArray(value):t==="integer"?Number.isInteger(value):t==="number"?typeof value==="number"&&Number.isFinite(value):t==="object"?!!value&&typeof value==="object"&&!Array.isArray(value):typeof value===t;
    if(types.length&&!types.some(matches))throw new Error("Invalid type for browser argument: "+key+". Use the attached installed schema.");
    if(p.enum&&!p.enum.includes(value))throw new Error("Invalid choice for browser argument: "+key+". Use the attached installed schema.");
    if(typeof value==="number"&&(p.minimum!==undefined&&value<p.minimum||p.maximum!==undefined&&value>p.maximum))throw new Error("Out-of-range browser argument: "+key+". Use the attached installed schema.");
  }
  return args;
}
