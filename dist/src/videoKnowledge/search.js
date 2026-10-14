"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.describeVideo = describeVideo;
exports.descriptorTokens = descriptorTokens;
exports.matchDescriptions = matchDescriptions;
function describeVideo(notes) {
    return [...new Set((notes.evidence || notes.facts).map(f => f.value.trim()))].slice(0, 24).join('; ').slice(0, 1600);
}
const stop = new Set('a an the that this it one house home property video tour with has have had and or in on of for to is was you your showed posted saw looking about please can could do me i want tell more information info details price pricing cost location address size sqft square feet area city builder much how where what which when available still sold many big old brief description describe remember mentioned bedrooms bedroom bathrooms bathroom'.split(' '));
function descriptorTokens(value) {
    return [...new Set(value.toLowerCase().normalize('NFKC').replace(/guest[ -]?house|guest suite|apartment/g, 'casita').replace(/\b(one|two|three|four|five|six)\b(?=[ -]+(?:bed|bath|car|acre))/g, word => ({ one: '1', two: '2', three: '3', four: '4', five: '5', six: '6' }[word])).replace(/(\d+(?:\.\d+)?)[ -]+(bedrooms?|beds?|bathrooms?|baths?|acres?|cars?)\b/g, (_m, n, unit) => n + (/^bed/.test(unit) ? 'bedrooms' : /^bath/.test(unit) ? 'bathrooms' : /^acre/.test(unit) ? 'acres' : 'cars')).match(/\d+(?:\.\d+)?(?:bedrooms|bathrooms|acres|cars)|\d+(?:\.\d+)?|[\p{L}]+/gu) || [])].filter(t => (t.length >= 3 || /^\d/.test(t)) && !stop.has(t));
}
/** Require every descriptive token, not just the highest-scoring house. */
function matchDescriptions(rows, message) {
    if (/\b(?:my budget|i (?:live|work)|do you (?:work|sell|cover)|looking (?:for|to buy)|want to buy)\b/i.test(message))
        return [];
    if (/\b(?:no|not|without)\b/i.test(message))
        return [];
    const tokens = descriptorTokens(message);
    if (!tokens.length)
        return [];
    // Avoid selecting a video from a city alone; ask for a distinguishing description instead.
    const distinctive = /\b(?:pool|elevator|garage|barn|casita|fireplace|kitchen|acre|acres|patio|balcony|glass|brick|stone|modern|black|white)\b/i.test(message);
    if (tokens.length < 2 && !distinctive)
        return [];
    return rows.filter(r => { const terms = new Set(descriptorTokens(r.description)); return tokens.every(t => terms.has(t)); });
}
