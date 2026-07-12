"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LISTINGS = void 0;
exports.getListingFacts = getListingFacts;
exports.LISTINGS = {
// Example — replace with Marco's real listing IDs and facts:
// "monticello-park": {
//   label: "Monticello Park 4bd/2ba",
//   neighborhood: "Monticello Park",
//   city: "San Antonio",
//   beds: 4,
//   baths: 2,
//   hasCasita: false,
//   constructionType: "resale",
//   priceRangeLow: 280000,
//   priceRangeHigh: 320000,
// },
};
function getListingFacts(listingId) {
    if (!listingId)
        return null;
    return exports.LISTINGS[listingId] ?? null;
}
