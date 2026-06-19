/** Start of calendar day in America/Chicago as ISO UTC string. */
export function startOfCentralDayIso(now = new Date()): string {
  const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
  const [y, m, d] = dateStr.split("-").map(Number);
  const chicagoAsUtc = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const utcAsUtc = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
  const offsetMs = utcAsUtc.getTime() - chicagoAsUtc.getTime();
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) + offsetMs).toISOString();
}

export function centralDateString(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
}
