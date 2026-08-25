"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MARCO_TASK_STATUSES = exports.SELLER_STAGES = exports.BUYER_STAGES = exports.TRACKER_STATUSES = exports.COMMAND_TASK_INTERVALS = exports.COMMAND_TASK_STATUSES = exports.CRM_TASK_STATUSES = exports.ROLE_PERMISSIONS = exports.APPOINTMENT_TYPES = exports.APPOINTMENT_TYPE_GROUPS = exports.CRM_STAGES = exports.CRM_STAGE_LEGACY = exports.CRM_STAGE_GROUPS = exports.CRM_CANDIDATE_STAGES = exports.CRM_LEAD_STAGES = exports.CRM_STATUSES = void 0;
exports.crmStageLabel = crmStageLabel;
exports.isRecurringInterval = isRecurringInterval;
/** Valid CRM status values (dashboard + API). */
exports.CRM_STATUSES = [
    "new", "hot", "nurture", "watch", "dead", "unresponsive", "archived", "trashed",
];
exports.CRM_LEAD_STAGES = [
    { value: "new_lead", label: "New Lead" },
    { value: "attempted_contact", label: "Attempted Contact" },
    { value: "spoke_with_customer", label: "Spoke With Customer" },
    { value: "appointment_set", label: "Appointment Set" },
    { value: "met_with_customer", label: "Met With Customer" },
    { value: "showing_homes", label: "Showing Homes" },
    { value: "listing_agreement", label: "Listing Agreement" },
    { value: "active_listing", label: "Active Listing" },
    { value: "submitting_offers", label: "Submitting Offers" },
    { value: "under_contract", label: "Under Contract" },
    { value: "sale_closed", label: "Sale Closed" },
    { value: "nurture", label: "Nurture" },
    { value: "rejected", label: "Rejected" },
];
exports.CRM_CANDIDATE_STAGES = [
    { value: "new_candidate", label: "New Candidate" },
    { value: "attempted_contact_candidate", label: "Attempted Contact" },
    { value: "spoke_with_candidate", label: "Spoke With Candidate" },
    { value: "appointment_set_candidate", label: "Appointment Set" },
    { value: "met_with_candidate", label: "Met With Candidate" },
    { value: "screening", label: "Screening" },
    { value: "signing_appt_set", label: "Signing Appt Set" },
    { value: "signed", label: "Signed" },
    { value: "nurture_candidate", label: "Nurture Candidate" },
    { value: "rejected_candidate", label: "Rejected Candidate" },
    { value: "declined_offer", label: "Declined Offer" },
];
/** The two groups, in the order and under the headers the operator sees. */
exports.CRM_STAGE_GROUPS = [
    { group: "Lead Stages", stages: exports.CRM_LEAD_STAGES },
    { group: "Candidate Recruit Stages", stages: exports.CRM_CANDIDATE_STAGES },
];
/** Old value → nearest new stage. Read-only: nothing rewrites stored rows. */
exports.CRM_STAGE_LEGACY = {
    new: "new_lead",
    hot: "attempted_contact",
    warm: "attempted_contact",
    cold: "nurture",
    pending: "under_contract",
    showing_set: "showing_homes",
    closed: "sale_closed",
};
exports.CRM_STAGES = [].concat(exports.CRM_LEAD_STAGES.map((s) => s.value), exports.CRM_CANDIDATE_STAGES.map((s) => s.value), Object.keys(exports.CRM_STAGE_LEGACY));
/** Display label for any stage value, legacy included. Never returns blank. */
function crmStageLabel(value) {
    if (!value)
        return "";
    const all = exports.CRM_LEAD_STAGES.concat(exports.CRM_CANDIDATE_STAGES);
    const hit = all.find((s) => s.value === value);
    if (hit)
        return hit.label;
    const legacy = exports.CRM_STAGE_LEGACY[value];
    if (legacy) {
        const l = exports.CRM_LEAD_STAGES.find((s) => s.value === legacy);
        if (l)
            return l.label;
    }
    return String(value);
}
/**
 * Appointment types, exactly the twelve the operator listed.
 *
 * The previous list carried a thirteenth, "Recruiting", that is not on theirs;
 * it is dropped from the picker but still renders on any appointment already
 * saved with it, because deleting an option must not blank a record.
 */
exports.APPOINTMENT_TYPE_GROUPS = [
    {
        group: "Real Estate Consultation",
        types: [
            "Buyer Consultation",
            "Listing Consultation",
            "Buyer/Listing Consultation",
            "Showing Appointment",
            "Client Meeting",
            "General",
            "Follow Up",
        ],
    },
    {
        group: "Recruiting / Administrative",
        types: [
            "Meet & Greet",
            "Screening",
            "Recruiting Appointment",
            "Signing Appointment",
            "Recruiting Follow Up",
        ],
    },
];
exports.APPOINTMENT_TYPES = exports.APPOINTMENT_TYPE_GROUPS.flatMap((g) => g.types);
exports.ROLE_PERMISSIONS = {
    admin: {
        canDeleteTasks: true,
        canViewAllLeads: true,
        canAccessSettings: true,
        canAccessAutomations: true,
        canExportCSV: true,
        canMassText: true,
        canMassEmail: true,
        canManageTags: true,
        canManageAutoPlans: true,
        canViewReports: true,
    },
    agent: {
        canDeleteTasks: false,
        canViewAllLeads: false,
        canAccessSettings: false,
        canAccessAutomations: false,
        canExportCSV: true,
        canMassText: true,
        canMassEmail: true,
        canManageTags: false,
        canManageAutoPlans: false,
        canViewReports: true,
    },
    isa: {
        canDeleteTasks: false,
        canViewAllLeads: true,
        canAccessSettings: false,
        canAccessAutomations: false,
        canExportCSV: false,
        canMassText: true,
        canMassEmail: false,
        canManageTags: false,
        canManageAutoPlans: false,
        canViewReports: false,
    },
    custom: {
        canDeleteTasks: false,
        canViewAllLeads: false,
        canAccessSettings: false,
        canAccessAutomations: false,
        canExportCSV: false,
        canMassText: false,
        canMassEmail: false,
        canManageTags: false,
        canManageAutoPlans: false,
        canViewReports: false,
    },
};
exports.CRM_TASK_STATUSES = [
    "pending",
    "in_progress",
    "on_hold",
    "due_soon",
    "overdue",
    "completed",
    "cancelled",
];
exports.COMMAND_TASK_STATUSES = [
    "pending",
    "in_progress",
    "on_hold",
    "due_soon",
    "overdue",
    "done",
];
/** Fixed cadences. The two patterns above are checked separately. */
exports.COMMAND_TASK_INTERVALS = [
    "daily", "every_3_days", "every_5_days", "weekly", "biweekly",
    "monthly", "every_3_months", "every_6_months", "yearly",
];
function isRecurringInterval(v) {
    if (typeof v !== "string")
        return false;
    if (exports.COMMAND_TASK_INTERVALS.includes(v))
        return true;
    const days = /^every_(\d{1,3})_days$/.exec(v);
    if (days) {
        const n = Number(days[1]);
        return n >= 1 && n <= 365;
    }
    const dow = /^day_of_week_([0-6])$/.exec(v);
    return !!dow;
}
exports.TRACKER_STATUSES = [
    "new", "unqualified", "watch", "nurture", "hot", "pending",
];
/** Ordered, with labels, so UI and reporting share one source of truth. */
exports.BUYER_STAGES = [
    { key: "contacted", label: "Contacted" },
    { key: "qualified", label: "Qualified" },
    { key: "pre_approved", label: "Pre-Approved" },
    { key: "buyer_rep_signed", label: "Buyer Rep Signed" },
    { key: "actively_showing", label: "Actively Showing" },
    { key: "offer_submitted", label: "Offer Submitted" },
    { key: "under_contract", label: "Under Contract" },
    { key: "option_period", label: "Option Period" },
    { key: "clear_to_close", label: "Clear to Close" },
    { key: "closed", label: "Closed" },
    { key: "past_client", label: "Past Client" },
];
exports.SELLER_STAGES = [
    { key: "new", label: "New" },
    { key: "contacted", label: "Contacted" },
    { key: "cma_requested", label: "CMA Requested" },
    { key: "listing_appointment_set", label: "Listing Appointment Set" },
    { key: "appointment_held", label: "Appointment Held" },
    { key: "listing_agreement_signed", label: "Listing Agreement Signed" },
    { key: "prep_pre_market", label: "Prep/Pre-Market" },
    { key: "active_on_mls", label: "Active on MLS" },
    { key: "price_adjustment", label: "Price Adjustment" },
    { key: "offer_received", label: "Offer Received" },
    { key: "under_contract", label: "Under Contract" },
    { key: "option_period", label: "Option Period" },
    { key: "clear_to_close", label: "Clear to Close" },
    { key: "closed", label: "Closed" },
    { key: "past_client", label: "Past Client" },
];
exports.MARCO_TASK_STATUSES = [
    "pending",
    "in_progress",
    "on_hold",
    "due_soon",
    "overdue",
    "done",
];
