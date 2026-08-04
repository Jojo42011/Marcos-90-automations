/** Seeds one fully-populated listing so the MLS pages can be driven without a live SABOR feed. */
const { fromSimplyRets, upsertListings } = await import("../dist/src/core/listingsStore.js");
const payload = {
  mlsId: "TEST-1001", listingId: "1799432", listPrice: 565000, modified: "2026-08-01T10:00:00Z",
  listDate: "2026-06-14T00:00:00Z",
  remarks: "Beautiful hill country home on a quiet cul-de-sac.\nOversized covered patio, mature oaks, and an open floor plan.",
  address: { full: "128 Cibolo Ridge", city: "Boerne", state: "TX", postalCode: "78006" },
  property: { bedrooms: 4, bathrooms: 3, area: 2840, acres: 0.62, yearBuilt: 2019, type: "Residential",
    subType: "Single Family Detached", subdivision: "Cibolo Ridge", garageSpaces: 3, stories: 1,
    pool: "In Ground", heating: "Central", cooling: "Central Air", roof: "Composition",
    style: "Texas Hill Country", construction: "Stone/Stucco", flooring: "Wood, Tile",
    laundryFeatures: "Main Level", interiorFeatures: "Island Kitchen, Walk-In Closets",
    exteriorFeatures: "Covered Patio, Sprinkler System" },
  mls: { status: "Active", daysOnMarket: 51 },
  geo: { lat: 29.7947, lng: -98.7319, county: "Kendall" },
  school: { district: "Boerne ISD", elementarySchool: "Fabra", middleSchool: "Boerne", highSchool: "Champion" },
  agent: { firstName: "Marco", lastName: "Puga", contact: "210-555-0142" },
  office: { name: "Marco Puga Real Estate" },
  tax: { taxAnnualAmount: 9840, taxYear: 2025 },
  sales: {},
  photos: ["https://example.test/p1.jpg","https://example.test/p2.jpg","https://example.test/p3.jpg"],
};
const n = upsertListings([fromSimplyRets(payload)]);
console.log("seeded", n);
