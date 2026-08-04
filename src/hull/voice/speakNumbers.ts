/**
 * Spoken numbers — CODE, not a prompt line (playbook §6.2).
 *
 * The model writes "$40k" because that's how the CRM holds it, and low-latency
 * TTS models skip full text normalization: a raw digit comes out flat, clipped,
 * or in the wrong register. So everything headed for the synthesizer passes
 * through sanitizeForSpeech, which strips markdown and then runs speakNumbers
 * LAST: phone numbers, money, percents, times, ordinals, ranges, years,
 * decimals, plain integers → words; a short acronym list is spelled out.
 *
 * Applied ONLY where text goes to TTS (the /api/jarvis/voice route). The UI
 * text keeps "$40k" because that's easier to READ — the whole point is that
 * ear-text and eye-text are different registers.
 */

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const r = n % 10;
  return r ? `${TENS[t]}-${ONES[r]}` : TENS[t];
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (!h) return twoDigits(r);
  return r ? `${ONES[h]} hundred ${twoDigits(r)}` : `${ONES[h]} hundred`;
}

/** Integer → words, up to the billions (plenty for a real-estate business). */
export function integerToWords(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `minus ${integerToWords(-n)}`;
  n = Math.floor(n);
  if (n < 1000) return threeDigits(n);
  const units: [number, string][] = [
    [1_000_000_000, "billion"],
    [1_000_000, "million"],
    [1_000, "thousand"],
  ];
  const parts: string[] = [];
  for (const [value, name] of units) {
    if (n >= value) {
      parts.push(`${threeDigits(Math.floor(n / value))} ${name}`);
      n %= value;
    }
  }
  if (n) parts.push(threeDigits(n));
  return parts.join(" ");
}

function digitsSpoken(digits: string): string {
  return digits
    .split("")
    .map((d) => (d === "0" ? "zero" : ONES[Number(d)]))
    .join(" ");
}

function yearToWords(year: number): string {
  const century = Math.floor(year / 100);
  const rest = year % 100;
  // 2000–2009 read naturally as "two thousand (and) N", not "twenty oh-N".
  if (year >= 2000 && year < 2010) {
    return rest ? `two thousand ${ONES[rest]}` : "two thousand";
  }
  return rest ? `${twoDigits(century)} ${rest < 10 ? `oh ${ONES[rest]}` : twoDigits(rest)}` : `${twoDigits(century)} hundred`;
}

function moneyToWords(numRaw: string, suffix: string): string {
  const clean = numRaw.replace(/,/g, "");
  const value = parseFloat(clean);
  if (!Number.isFinite(value)) return numRaw;
  const scale = /k/i.test(suffix) ? 1_000 : /m/i.test(suffix) ? 1_000_000 : /b/i.test(suffix) ? 1_000_000_000 : 1;
  const total = value * scale;
  const dollars = Math.floor(total);
  const cents = Math.round((total - dollars) * 100);
  // "$1.2M" style: value*scale is exact enough; "$99.50" keeps its cents.
  if (scale === 1 && cents > 0) {
    return `${integerToWords(dollars)} dollars and ${twoDigits(cents)} cents`;
  }
  const rounded = Math.round(total);
  return `${integerToWords(rounded)} dollar${rounded === 1 ? "" : "s"}`;
}

/* Acronyms ElevenLabs reads as words unless spaced out. Kept short on purpose:
   every entry is one we have actually heard mangled, not a dictionary. */
const ACRONYMS: Record<string, string> = {
  GCI: "G C I",
  CRM: "C R M",
  SMS: "S M S",
  KPI: "K P I",
  ROI: "R O I",
  DM: "D M",
  DMs: "D Ms",
};

export function speakNumbers(text: string): string {
  let out = text;

  // Phone numbers first — later rules would shred them into "seven hundred
  // eighteen". (210) 718-3874, 210-718-3874, 210.718.3874, +1 210 718 3874.
  out = out.replace(
    /(?:\+1[\s.-]?)?\(?(\d{3})\)?[\s.-](\d{3})[\s.-](\d{4})\b/g,
    (_m, a: string, b: string, c: string) => `${digitsSpoken(a)}, ${digitsSpoken(b)}, ${digitsSpoken(c)}`,
  );

  // Money: $425,000 / $40k / $1.2M / $99.50.
  out = out.replace(
    /\$\s?([\d,]+(?:\.\d+)?)\s*([kKmMbB])?\b/g,
    (_m, num: string, suffix: string | undefined) => moneyToWords(num, suffix || ""),
  );

  // Times: 3:30pm / 10:05 AM / 9:00.
  out = out.replace(
    /\b(\d{1,2}):(\d{2})\s*(am|pm|AM|PM|a\.m\.|p\.m\.)?\b/g,
    (_m, h: string, mnt: string, ap: string | undefined) => {
      const hour = twoDigits(parseInt(h, 10));
      const minutes = parseInt(mnt, 10);
      const min = minutes === 0 ? "o'clock" : minutes < 10 ? `oh ${ONES[minutes]}` : twoDigits(minutes);
      const suffix = ap ? ` ${/a/i.test(ap) ? "A M" : "P M"}` : "";
      return minutes === 0 && ap ? `${hour}${suffix}` : `${hour} ${min}${suffix}`;
    },
  );

  // Percents: 12% / 3.5%.
  out = out.replace(/\b(\d+(?:\.\d+)?)\s?%/g, (_m, num: string) => `${plainNumberToWords(num)} percent`);

  // Ordinals: 1st, 2nd, 3rd, 4th…
  out = out.replace(/\b(\d+)(st|nd|rd|th)\b/g, (_m, num: string) => ordinalToWords(parseInt(num, 10)));

  // Ranges between plain integers: 6-8 → "six to eight".
  out = out.replace(
    /\b(\d{1,3})\s?-\s?(\d{1,3})\b/g,
    (_m, a: string, b: string) => `${integerToWords(parseInt(a, 10))} to ${integerToWords(parseInt(b, 10))}`,
  );

  // Years: 1900–2099, standing alone.
  out = out.replace(/\b(19\d{2}|20\d{2})\b/g, (_m, y: string) => yearToWords(parseInt(y, 10)));

  // Decimals: 3.5 → "three point five".
  out = out.replace(
    /\b(\d+)\.(\d+)\b/g,
    (_m, whole: string, frac: string) => `${integerToWords(parseInt(whole, 10))} point ${digitsSpoken(frac)}`,
  );

  // Remaining integers, commas included: 725 / 6,006.
  out = out.replace(/\b\d{1,3}(?:,\d{3})+\b|\b\d+\b/g, (m) => integerToWords(parseInt(m.replace(/,/g, ""), 10)));

  // Acronyms last — they contain no digits, nothing above touches them.
  for (const [acronym, spoken] of Object.entries(ACRONYMS)) {
    out = out.replace(new RegExp(`\\b${acronym}\\b`, "g"), spoken);
  }

  return out;
}

function plainNumberToWords(num: string): string {
  if (num.includes(".")) {
    const [whole, frac] = num.split(".");
    return `${integerToWords(parseInt(whole, 10))} point ${digitsSpoken(frac)}`;
  }
  return integerToWords(parseInt(num, 10));
}

const ORDINAL_ONES = [
  "zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh",
  "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth",
  "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth",
];
const ORDINAL_TENS: Record<number, string> = {
  2: "twentieth", 3: "thirtieth", 4: "fortieth", 5: "fiftieth",
  6: "sixtieth", 7: "seventieth", 8: "eightieth", 9: "ninetieth",
};

function ordinalToWords(n: number): string {
  if (n < 20) return ORDINAL_ONES[n] ?? String(n);
  if (n < 100) {
    const t = Math.floor(n / 10);
    const r = n % 10;
    return r ? `${TENS[t]}-${ORDINAL_ONES[r]}` : ORDINAL_TENS[t] ?? String(n);
  }
  // Rare in speech ("the 123rd") — words for the bulk, ordinal tail.
  const rest = n % 100;
  const head = integerToWords(n - rest);
  return rest ? `${head} ${ordinalToWords(rest)}` : `${head}th`;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/^[-•]\s+/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Everything headed for the synthesizer goes through this, numbers LAST. */
export function sanitizeForSpeech(text: string): string {
  if (!text) return text;
  return speakNumbers(stripMarkdown(text));
}
