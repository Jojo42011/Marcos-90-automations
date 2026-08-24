"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MARCO_TASK_STATUSES = exports.SELLER_STAGES = exports.BUYER_STAGES = exports.TRACKER_STATUSES = exports.COMMAND_TASK_STATUSES = exports.CRM_TASK_STATUSES = exports.ROLE_PERMISSIONS = exports.CRM_STAGES = exports.CRM_STATUSES = void 0;
/** Valid CRM status values (dashboard + API). */
exports.CRM_STATUSES = [
    "new", "hot", "nurture", "watch", "dead", "unresponsive", "archived", "trashed",
];
exports.CRM_STAGES = [
    "new",
    "hot",
    "warm",
    "cold",
    "pending",
    "appointment_set",
    "showing_set",
    "under_contract",
    "closed",
];
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
