/** Pure stats utilities for the Content Manager Brain. */

export function pearsonCorrelation(xs: number[], ys: number[]): number {
  if (xs.length < 2 || ys.length < 2 || xs.length !== ys.length) return 0;
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return 0;
  return num / Math.sqrt(denX * denY);
}

export function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export function getCurrentWeekNumber(): number {
  return getWeekNumber(new Date());
}

export function getWeekStart(date = new Date()): string {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);
}

export function isSunday(date = new Date()): boolean {
  return (
    new Date(date).toLocaleDateString("en-US", { weekday: "long", timeZone: "America/Chicago" }) ===
    "Sunday"
  );
}

export function isMonday(date = new Date()): boolean {
  return (
    new Date(date).toLocaleDateString("en-US", { weekday: "long", timeZone: "America/Chicago" }) ===
    "Monday"
  );
}

export function gradeFromOutcomeScore(score: number): string {
  if (score >= 80) return "A";
  if (score >= 65) return "B";
  if (score >= 50) return "C";
  if (score >= 35) return "D";
  return "F";
}
