"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.agreementKey = agreementKey;
exports.assessApproval = assessApproval;
exports.corroboratedFacts = corroboratedFacts;
const text = (value) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const numbers = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
/** Only simple room totals are normalized. Units, ranges and qualifiers stay significant. */
function agreementKey(fact) {
    const value = text(fact.value);
    if (fact.field === 'bedrooms' || fact.field === 'bathrooms') {
        const match = value.match(/^(\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)( and a half| point five)?(?:[ -]+(full|half))?(?:[ -]+(bedrooms?|beds?|bathrooms?|baths?))?$/);
        if (match && (!match[4] || (fact.field === 'bedrooms' ? /^bed/.test(match[4]) : /^bath/.test(match[4])))) {
            const count = (numbers[match[1]] ?? Number(match[1])) + (match[2] ? 0.5 : 0);
            return `${fact.field}:${count}${match[3] === 'half' ? ':half-baths' : ''}`;
        }
    }
    return `${fact.field}:${value}`;
}
/** Absence of a contradiction is not agreement: retain explicit evidence from both sources. */
function assessApproval(notes, video, requireCore = true) {
    const reasons = [];
    if (notes.conflicts?.length)
        reasons.push('Resolve the source disagreements below.');
    if (notes.warnings?.length)
        reasons.push('Check the omitted or invalid extraction claims below.');
    if (!video.caption.trim() || !video.transcript.trim())
        reasons.push('Both a caption and a complete transcript are required.');
    if (requireCore) {
        if (!notes.facts.some(f => ['city', 'area', 'address'].includes(f.field)))
            reasons.push('Missing an undisputed property location.');
        for (const field of ['bedrooms', 'bathrooms'])
            if (!notes.facts.some(f => f.field === field))
                reasons.push(`Missing an undisputed ${field} count.`);
    }
    if (!notes.evidence?.length)
        reasons.push('Separate evidence from both sources is missing; reprocess or review this video.');
    const evidence = notes.evidence || [];
    const claims = [...evidence, ...notes.facts];
    const seen = new Set();
    for (const field of new Set(claims.map(f => f.field))) {
        if (field !== 'features' && new Set(claims.filter(f => f.field === field).map(agreementKey)).size > 1) {
            reasons.push(`${field}: more than one distinct value was extracted; confirm which value applies.`);
        }
    }
    for (const fact of claims) {
        const key = agreementKey(fact);
        if (seen.has(key))
            continue;
        seen.add(key);
        const matches = evidence.filter(f => agreementKey(f) === key);
        const missing = ['caption', 'transcript'].filter(source => !matches.some(f => f.source === source));
        if (missing.length)
            reasons.push(`${fact.field}: “${fact.value}” is missing matching evidence in ${missing.join(' and ')}.`);
    }
    // Auto-approval uses a stricter literal check than manual review, preserving numeric punctuation.
    if (claims.some(f => !text(video[f.source]).includes(text(f.quote)) || !text(f.quote).includes(text(f.value)))) {
        reasons.push('Some evidence needs human interpretation of its wording or punctuation.');
    }
    const negated = /\b(?:no|not|without|isn't|doesn't)\b/i;
    if (claims.some(f => {
        if (negated.test(f.value))
            return false;
        // Include the surrounding sentence: a model can quote just "pool" from "no pool".
        const source = text(video[f.source]);
        const quote = text(f.quote);
        let at = source.indexOf(quote);
        while (at >= 0) {
            const before = source.slice(0, at).split(/[.!?;\n]/).pop() || '';
            const after = source.slice(at + quote.length).split(/[.!?;\n]/)[0] || '';
            if (negated.test(before + quote + after))
                return true;
            at = source.indexOf(quote, at + quote.length);
        }
        return false;
    })) {
        reasons.push('A source quotation contains a negation missing from its extracted value.');
    }
    return { mode: reasons.length ? 'review_required' : 'automatic', policy: 'all-details-both-sources-v1', reasons: [...new Set(reasons)] };
}
/** Each usable claim must pass on its own; unsupported details never block unrelated facts. */
function corroboratedFacts(notes, video) {
    const fields = ['city', 'area', 'address', 'price', 'bedrooms', 'bathrooms', 'size', 'acreage', 'builder', 'features'];
    return notes.facts.filter(fact => {
        const evidence = (notes.evidence || []).filter(e => e.field === fact.field && (fact.field !== 'features' || agreementKey(e) === agreementKey(fact)));
        const warnings = (notes.warnings || []).filter(w => w.includes(` ${fact.field} `) || !fields.some(field => w.includes(` ${field} `)));
        return assessApproval({ facts: [fact], keywords: [], evidence, warnings, conflicts: (notes.conflicts || []).filter(c => c.field === fact.field) }, video, false).mode === 'automatic';
    });
}
