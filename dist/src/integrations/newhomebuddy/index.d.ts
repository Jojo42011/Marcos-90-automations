/**
 * New Home Buddy (or alternative MLS) — property search by criteria.
 */
export interface SearchCriteria {
    priceCap?: number;
    beds?: number;
    baths?: number;
    area?: string;
}
export declare function searchListings(_criteria: SearchCriteria): Promise<unknown[]>;
//# sourceMappingURL=index.d.ts.map