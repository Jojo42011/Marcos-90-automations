import type { Lead } from "../core/types.js";
interface BrivityContact {
    id?: string | number;
    first_name?: string;
    phone?: string;
    email?: string;
    source?: string;
    stage?: string;
}
export declare function createOrUpdateLead(lead: Lead): Promise<BrivityContact | null>;
export declare function syncLead(lead: Lead): Promise<BrivityContact | null>;
export {};
//# sourceMappingURL=brivity.d.ts.map