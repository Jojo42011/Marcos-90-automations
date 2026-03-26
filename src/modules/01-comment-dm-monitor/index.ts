export async function process<TLead extends object>(
  lead: TLead,
  _conversation: unknown,
): Promise<{ lead: TLead; reply: string | null }> {
  return { lead, reply: null };
}

