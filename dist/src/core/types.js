"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MARCO_TASK_STATUSES = exports.COMMAND_TASK_STATUSES = exports.CRM_TASK_STATUSES = exports.ROLE_PERMISSIONS = exports.CRM_STAGES = exports.CRM_STATUSES = void 0;
/** Valid CRM status values (dashboard + API). */
exports.CRM_STATUSES = ["new", "hot", "nurture", "watch", "dead", "unresponsive"];
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
    "on_hold",
    "due_soon",
    "overdue",
    "done",
];
exports.MARCO_TASK_STATUSES = [
    "pending",
    "in_progress",
    "on_hold",
    "due_soon",
    "overdue",
    "done",
];
