// A compact map of routes, not a second tool registry or a grant of permission.
export function capabilityMap(input:{local:boolean;browser:boolean;managed:boolean;connectionError?:string;apps:any[];custom:any[];tools:string[]}) {
  const has=(name:string)=>input.tools.includes(name);
  return {computer:input.local?'connected_local_tab':'hosted_chat_browser',
    routes:[
      {goal:'Inspect and operate the current website',available:has('computer')&&(input.local||input.browser),tools:['computer'],next:'Discover current schemas. Read snapshot/table; inspect scroll regions and scroll actual content. Empty rows are an observation gap, not proof automation is impossible.'},
      {goal:'Understand visual controls or unreadable page content',available:has('inspect_screen')&&(input.local||input.browser),tools:['inspect_screen'],next:'Ask a specific visual question. Native vision receives pixels; a vision helper supplies text for text-only main models. Reinspect after actions; visual analysis alone does not verify all records.'},
      {goal:'Read or write connected apps, including Google Sheets',available:input.managed&&has('COMPOSIO_SEARCH_TOOLS'),state:input.connectionError?'unknown':'checked',apps:input.apps,error:input.connectionError,tools:['plugins','COMPOSIO_SEARCH_TOOLS','COMPOSIO_GET_TOOL_SCHEMAS','COMPOSIO_MANAGE_CONNECTIONS','COMPOSIO_MULTI_EXECUTE_TOOL'],next:'Discover exact action and scope. Connected is not permission to act. If OAuth is required return its actual link; keep independent source collection moving. Refresh plugins after authorization.'},
      {goal:'Use custom connected services',available:input.custom.length>0,connections:input.custom,tools:['plugin_tools','plugin_call'],next:'Discover the current schema and honor Enable actions.'},
      {goal:'Retain extracted records and deliver files',available:has('work_records'),tools:['work_records','workspace_files'],next:'Save source-backed batches by stable ID, separate large sections. Export CSV when requested; Google Sheets delivery still requires the managed app and read-back.'},
      {goal:'Resume a long task without repeating completed work',available:has('task_plan'),tools:['task_plan','continuity','history_search'],next:'Read the saved contract, progress and records. Preserve latest count, exclusions, fields and destination. A blocked delivery step need not block extraction.'},
      {goal:'Reuse a procedure that worked',available:has('workflow'),tools:['workflow'],next:'List/get relevant taught or execution-backed procedures. Check prerequisites against current state; historical success is not current proof.'},
      {goal:'Use internal CRM/business data',available:has('business_tools'),tools:['business_tools','business_call'],next:'Discover authorized tools. Internal CRM data is not automatically the external Brivity account.'}
    ],rule:'A missing search result is not a missing capability. Try another relevant route before declaring a limitation. Do not switch accounts/computers or expand authorization.'};
}

export function validateContract(value:any) {
  if(value===undefined)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Contract must be an object');
  const result:any={};
  for(const field of ['scope','destination','collection'])if(value[field]!==undefined){
    if(typeof value[field]!=='string'||value[field].length>1000)throw Error('Use short contract text');
    result[field]=value[field];
  }
  if(value.count!==undefined){if(!Number.isSafeInteger(value.count)||value.count<1)throw Error('Contract count must be a positive integer');result.count=value.count;}
  for(const field of ['fields','sections','exclusions'])if(value[field]!==undefined){
    if(!Array.isArray(value[field])||value[field].length>100||value[field].some((x:any)=>typeof x!=='string'||x.length>300))throw Error('Contract lists must contain bounded text');
    result[field]=value[field];
  }
  return result;
}

// A stop decision must distinguish lack of observations from lack of capability.
export function unsupportedCapabilityClaim(text:string) {
  return /(?:cannot|can't|unable to|not able to).{0,70}(?:scroll|render|automat|extract|create.{0,15}(?:sheet|spreadsheet))|(?:virtualiz|lazy.load).{0,100}(?:limitation|prevent|impossible)|(?:manually scroll|copy.paste approach)/is.test(text);
}
