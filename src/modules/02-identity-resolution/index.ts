export async function process<TLead extends object>(
  lead: TLead,
  _conversation: unknown,
): Promise<{ lead: TLead; reply: string | null }> {
  // For now we keep this intentionally simple: if a name is already present we
  // leave it alone; otherwise we rely on the platform username and avoid
  // forcing an extra "what's your name?" step.
  //
  // Later we can plug in the LLM with the identityResolution prompt to extract
  // names from conversation when it is clearly provided.
  return { lead, reply: null };
}

