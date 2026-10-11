export const ACCOUNT_INBOUND:Record<string,string>={quo:"/api/quo/webhook",mojo:"/api/mojo/webhook",website:"/api/website/lead",twilio:"/webhook/twilio"};
export function accountInboundPath(provider:string):string {
  const route=ACCOUNT_INBOUND[provider];if(!route)throw new Error("Unsupported inbound provider");
  return process.env.TENANT_OWNER_ID ? `/api/account-inbound/${encodeURIComponent(process.env.TENANT_OWNER_ID)}/${provider}` : route;
}
