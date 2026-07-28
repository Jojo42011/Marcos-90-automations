"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WORKSPACE_TOOL_NAMES = exports.WORKSPACE_TOOL_DEFINITIONS = exports.PLATFORM_TOOL_NAMES = exports.PLATFORM_TOOL_DEFINITIONS = void 0;
exports.normalizeNavigateUrl = normalizeNavigateUrl;
exports.executePlatformTool = executePlatformTool;
exports.executeWorkspaceTool = executeWorkspaceTool;
const types_js_1 = require("../core/types.js");
const trackerStore_js_1 = require("../core/trackerStore.js");
const trackerTasks_js_1 = require("../core/trackerTasks.js");
const db_js_1 = require("../core/db.js");
const teamStore_js_1 = require("../core/teamStore.js");
const commandSettings_js_1 = require("../core/commandSettings.js");
const scheduledMessages_js_1 = require("../core/scheduledMessages.js");
const scheduledSender_js_1 = require("../core/scheduledSender.js");
const scheduleTime_js_1 = require("../core/scheduleTime.js");
const db_js_2 = require("../core/db.js");
const messageChannels_js_1 = require("../core/messageChannels.js");
const knowledgeStore_js_1 = require("../core/knowledgeStore.js");
const browserControl_js_1 = require("../core/browserControl.js");
/**
 * Harvey tools for the platform surfaces that had none — the Buyers & Sellers
 * Tracker, Task Command, the team board and command settings.
 *
 * These existed as working subsystems Harvey simply could not see: it could
 * describe the CRM in detail while being blind to the 1,219-record tracker and
 * the task board the team actually works from. "No feature in a silo Harvey
 * cannot see" is the point of this file.
 *
 * Reads are unrestricted. Writes are deliberately narrow — stage moves, status
 * and notes, task create/update — because those are the actions someone would
 * genuinely delegate out loud. Deleting anything is not offered.
 */
const BUYER_STAGE_KEYS = types_js_1.BUYER_STAGES.map((s) => s.key);
const SELLER_STAGE_KEYS = types_js_1.SELLER_STAGES.map((s) => s.key);
const TASK_COLUMNS = ["urgent", "today", "tomorrow", "this_week", "this_month"];
const TASK_STATUSES = ["pending", "in_progress", "on_hold", "due_soon", "overdue", "done"];
/** Cards carry a lot of noise for a language model; this is the useful part. */
function slimRecord(r) {
    const checklist = r.checklist || [];
    return {
        id: r.id,
        name: r.name,
        sides: r.sides,
        status: r.status,
        buyerStage: r.buyerStage ?? null,
        sellerStage: r.sellerStage ?? null,
        phone: r.phone ?? null,
        email: r.email ?? null,
        address: r.address ?? null,
        source: r.source ?? null,
        assignedTo: r.assignedTo ?? null,
        contactable: Boolean((r.phone || "").trim() || (r.email || "").trim()),
        lastInteractionAt: r.lastInteractionAt ?? null,
        checklist: checklist.length
            ? { total: checklist.length, done: checklist.filter((c) => c.done).length }
            : null,
        notes: r.notes ? r.notes.slice(0, 400) : null,
    };
}
function slimTask(t) {
    return {
        id: t.id,
        title: t.title,
        column: t.column,
        status: t.status,
        assignedTo: t.assignedTo ?? null,
        dueDate: t.dueDate ?? null,
        dueTime: t.dueTime ?? null,
        recurring: Boolean(t.recurring),
        checklist: t.checklist?.length
            ? { total: t.checklist.length, done: t.checklist.filter((c) => c.done).length }
            : null,
        tags: t.tags ?? [],
    };
}
const str = (v) => (typeof v === "string" ? v.trim() : "");
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
/**
 * Accept what a person actually says. "Open books.toscrape.com" is a complete
 * instruction to a human, and making Harvey demand the scheme back turned a
 * one-word request into an argument — he told the operator to retype the URL
 * four times in a row rather than just adding `https://`.
 *
 * Returns "" for anything that isn't plausibly an address, so a stray phrase
 * doesn't get turned into a navigation to https://some%20words.
 */
function normalizeNavigateUrl(raw) {
    const s = String(raw || "").trim().replace(/^["'<]+|["'>]+$/g, "");
    if (!s || /\s/.test(s))
        return "";
    const withScheme = /^https?:\/\//i.test(s) ? s : "https://" + s.replace(/^\/+/, "");
    let u;
    try {
        u = new URL(withScheme);
    }
    catch {
        return "";
    }
    // A hostname with no dot is a search phrase or a typo, not a site. localhost
    // is the one real exception and is worth keeping for testing.
    if (!u.hostname.includes(".") && u.hostname !== "localhost")
        return "";
    return u.toString();
}
exports.PLATFORM_TOOL_DEFINITIONS = [
    {
        name: "browser_status",
        description: "Whether the Harvey browser extension is connected and armed, and what page the operator is currently on. ALWAYS call this before trying to drive the browser — if it isn't connected or is switched off, say so and tell them how to fix it instead of attempting actions that will fail.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "browser_navigate",
        description: "Open a URL in Harvey's own browser tab and wait for it to load. Use for sites with no API — a listing portal, a title company's form, an MLS back office. Returns the resulting page URL and title. A bare domain is fine ('books.toscrape.com', 'zillow.com/homes/123') — https:// is added for you, so NEVER ask the operator to retype an address with the scheme on it.",
        input_schema: {
            type: "object",
            properties: { url: { type: "string", description: "A URL or a bare domain — 'books.toscrape.com' works." } },
            required: ["url"],
        },
    },
    {
        name: "browser_disable",
        description: "Switch browser control OFF. Use whenever the operator says they're done, or asks you to turn it off / stop / disarm the browser. This genuinely disarms the extension — do NOT claim the browser is off unless this tool returned success.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "browser_enable",
        description: "Switch browser control back ON when the operator asks you to. Only works on a browser they already paired, and they can set a lock in the extension popup that refuses this — if it comes back locked, say so and tell them to flip the switch themselves. Never claim the browser is on unless this returned success.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "browser_wait_for",
        description: "Wait until something appears on the page. Use on sites that load their content after the page itself (most modern listing portals): if a read or extract comes back empty or looks like a loading state, wait for the thing you expect and then retry rather than reporting the page as empty.",
        input_schema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "CSS selector to wait for." },
                text: { type: "string", description: "Visible text to wait for." },
                timeoutMs: { type: "number", description: "Default 15000." },
            },
            required: [],
        },
    },
    {
        name: "browser_structured_data",
        description: "Read the page's own schema.org JSON-LD and OpenGraph data. TRY THIS FIRST on any listing or product page: portals publish their real data here for search engines — price, address, beds, baths, agent — and it survives redesigns that break every CSS selector. Fall back to browser_read + browser_extract only when this returns nothing.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "browser_scroll",
        description: "Scroll Harvey's tab. Use before reading a search-results page: portals lazy-load listings as you scroll, so a plain read only sees the first few. Defaults to stepping to the bottom until the page stops growing.",
        input_schema: {
            type: "object",
            properties: { to: { type: "string", description: '"bottom" (default), "top", or a pixel number.' } },
            required: [],
        },
    },
    {
        name: "browser_screenshot",
        description: "SEE Harvey's tab as a picture. Use when the page is visual rather than textual and reading it isn't enough — a map or chart of comps, a scanned disclosure or PDF, a floor plan, a layout where the number you need is baked into an image, or when a read/extract came back empty and you want to know what is actually on screen before guessing again. Prefer browser_read or browser_extract for ordinary text: this is slower, and it briefly flicks the operator's screen over to Harvey's tab to take the picture.",
        input_schema: {
            type: "object",
            properties: { maxWidth: { type: "number", description: "Longest edge in px, 320-1568. Default 1000." } },
            required: [],
        },
    },
    {
        name: "browser_show_tab",
        description: "Bring Harvey's tab to the front so the operator can see it and take over. THIS IS THE ANSWER TO A LOGIN WALL: never ask for a password — call this, then ask them to sign in. Their session persists in that tab and you carry on from there.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "browser_read",
        description: "Read the visible text of the current page, or of one region. Call this after navigating so you can see what's actually there before clicking or extracting — never guess a page's structure.",
        input_schema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "Optional CSS selector to read just one part. Omit for the whole page." },
            },
            required: [],
        },
    },
    {
        name: "browser_click",
        description: "Click something on the page. Prefer `text` (the visible label, e.g. 'Next' or 'Save') since that's what a person would say; use `selector` when you know the exact element. One of the two is required.",
        input_schema: {
            type: "object",
            properties: {
                text: { type: "string", description: "Visible label of the link or button." },
                selector: { type: "string", description: "CSS selector." },
            },
            required: [],
        },
    },
    {
        name: "browser_fill",
        description: "Type values into form fields — a map of CSS selector to value. Handles text inputs, textareas, contenteditable, checkboxes and radios (pass true/false), and <select> (match by option value OR visible text, e.g. 'Texas'). If you don't know the selectors, call browser_read first; common ones ('#email', 'input[name=username]') can be tried directly. " +
            "ALWAYS ATTEMPT THE FILL. Password fields are the single exception and are refused per-field at the page, with the refusal returned in the result — so a form containing a password box still gets every other field filled. " +
            "Never decline the whole request up front because a password is mentioned: run the tool, then report exactly which fields were filled and which were refused. " +
            "When you explain the password refusal, be accurate: it is HARVEY'S OWN safety rule, NOT a Chrome or browser restriction — do not tell the operator it is 'browser security', because they will go looking for a setting that does not exist. " +
            "And do not treat it as a dead end: if the site needs a login, call browser_show_tab and ask them to sign in themselves. The tab keeps their session, so you never need their password at all.",
        input_schema: {
            type: "object",
            properties: {
                fields: {
                    type: "object",
                    description: 'e.g. {"#firstName": "Marco", "input[name=email]": "marco@example.com"}',
                },
            },
            required: ["fields"],
        },
    },
    {
        name: "browser_extract",
        description: "Pull named values off the page in one shot — a map of field name to CSS selector. Use this to lift a listing (price, address, beds, baths) into structured data instead of reading the whole page and parsing prose. A selector matching several nodes returns a list.",
        input_schema: {
            type: "object",
            properties: {
                schema: {
                    type: "object",
                    description: 'e.g. {"price": ".listing-price", "address": "h1.address", "features": ".feature-list li"}',
                },
            },
            required: ["schema"],
        },
    },
    {
        name: "search_knowledge",
        description: "Search the Knowledge Center — the team's SOPs and internal documentation. Use this whenever someone asks how a process works, what the policy is, or what they should do next in a workflow ('what's our listing process', 'how do we handle a price drop', 'what do I do after a showing'). ALWAYS search here before answering a process question from general knowledge, and say which document the answer came from. If nothing matches, say so plainly — do not invent a procedure.",
        input_schema: {
            type: "object",
            properties: {
                query: { type: "string", description: "What you're looking for, in plain words." },
                limit: { type: "number", description: "Default 5." },
            },
            required: ["query"],
        },
    },
    {
        name: "read_knowledge_doc",
        description: "Read one Knowledge Center document in full. Use after search_knowledge when the excerpt isn't enough to answer properly — quote the actual steps rather than paraphrasing from a snippet.",
        input_schema: {
            type: "object",
            properties: { id: { type: "string", description: "Document id from search_knowledge." } },
            required: ["id"],
        },
    },
    {
        name: "list_knowledge",
        description: "What documentation exists, by category. Use for 'what SOPs do we have', or when onboarding someone who doesn't know what to ask for yet.",
        input_schema: {
            type: "object",
            properties: { category: { type: "string" } },
            required: [],
        },
    },
    {
        name: "update_lead",
        description: "Change a contact's CRM fields: status, pipeline stage, intent, priority, name, phone, email, or notes. Only pass the fields you are actually changing — anything omitted is left alone. Call search_leads first to get the id. Use log_lead_activity (not this) to record that a call or text happened.",
        input_schema: {
            type: "object",
            properties: {
                leadId: { type: "string", description: "Lead id from search_leads." },
                crmStatus: { type: "string", enum: [...types_js_1.CRM_STATUSES], description: "Lead temperature." },
                crmStage: { type: "string", enum: [...types_js_1.CRM_STAGES], description: "Pipeline stage." },
                crmIntent: { type: "string", enum: ["buyer", "seller", "buyer_seller"] },
                crmPriority: { type: "string", enum: ["low", "normal", "high"] },
                name: { type: "string" },
                phone: { type: "string" },
                email: { type: "string" },
                notes: { type: "string", description: "REPLACES the notes field. To add without losing what's there, read the lead first and send the combined text." },
            },
            required: ["leadId"],
        },
    },
    {
        name: "log_lead_activity",
        description: "Record something that happened with a contact on their timeline — a call, a text, an email, a note. This is how 'I just called Kenneth, he wants to see it Saturday' gets written down. Does NOT send anything; it only records that it happened.",
        input_schema: {
            type: "object",
            properties: {
                leadId: { type: "string" },
                type: {
                    type: "string",
                    enum: ["call", "call_made", "text_sent", "text_received", "email_sent", "task", "note"],
                    description: "Use 'note' for a plain observation.",
                },
                description: { type: "string", description: "One line: what happened." },
                notes: { type: "string", description: "Longer detail, optional." },
            },
            required: ["leadId", "type", "description"],
        },
    },
    {
        name: "create_lead",
        description: "Add a brand-new contact to the CRM. Search first — creating a duplicate of someone already in the system is worse than not adding them. Needs at least a name plus a phone or email.",
        input_schema: {
            type: "object",
            properties: {
                name: { type: "string" },
                phone: { type: "string" },
                email: { type: "string" },
                crmIntent: { type: "string", enum: ["buyer", "seller", "buyer_seller"] },
                source: { type: "string", description: "Where they came from, e.g. 'Referral - Jane D'." },
                notes: { type: "string" },
            },
            required: ["name"],
        },
    },
    {
        name: "get_lead",
        description: "The full record for one contact: CRM fields, criteria, notes, tags, recent activity and how many messages are in the thread. Read this before changing anything so an update doesn't overwrite something that mattered.",
        input_schema: {
            type: "object",
            properties: { leadId: { type: "string" } },
            required: ["leadId"],
        },
    },
    {
        name: "schedule_message",
        description: "Queue a text or email to a lead to go out at a later time. Give `when` in plain language — 'Tuesday morning', 'tomorrow at 9am', 'in 2 hours' — or an exact date; omit it to use the next good business hour. ALWAYS tell the user the interpreted time that comes back, and if a `warning` is returned say so plainly: the message is queued but that channel cannot currently deliver. If the time can't be understood the tool returns an error — ask the user rather than picking a time yourself.",
        input_schema: {
            type: "object",
            properties: {
                leadId: { type: "string", description: "Lead id. Use search_leads first if you only have a name." },
                channel: { type: "string", enum: ["sms", "email"], description: "sms or email." },
                body: { type: "string", description: "The message to send." },
                subject: { type: "string", description: "Subject line — email only." },
                when: {
                    type: "string",
                    description: "Plain-language or exact send time. Omit for the next good business hour.",
                },
            },
            required: ["leadId", "channel", "body"],
        },
    },
    {
        name: "list_scheduled_messages",
        description: "Messages queued to send later, newest first. Filter by status (pending/sent/failed/canceled) or by lead. Also reports whether SMS and email can actually deliver right now — use that to explain failures instead of guessing.",
        input_schema: {
            type: "object",
            properties: {
                status: { type: "string", enum: ["pending", "sent", "failed", "canceled"] },
                leadId: { type: "string" },
                limit: { type: "number", description: "Default 20." },
            },
            required: [],
        },
    },
    {
        name: "cancel_scheduled_message",
        description: "Cancel a queued message that hasn't gone out yet. Returns an error if it already sent — a sent message cannot be unsent.",
        input_schema: {
            type: "object",
            properties: { id: { type: "string", description: "Scheduled message id." } },
            required: ["id"],
        },
    },
    {
        name: "get_tracker_summary",
        description: "Buyers & Sellers Tracker totals: how many people, how many on each side, counts by status and by pipeline stage, and how many are actually contactable (have a phone or email). Use this for 'how many sellers do we have', 'what's in the pipeline', 'how many hot leads'.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "get_tracker_pipelines",
        description: "The stage vocabulary: the ordered buyer pipeline (11 stages) and seller pipeline (15 stages), plus the status list. Call this before moving anyone so the stage key used is valid.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "search_tracker",
        description: "Find people in the tracker. Filter by side (buyer/seller), status, pipeline stage, source, assignee, or a free-text query matching name, phone digits, email or address. Returns the matching people with their stage and contact details.",
        input_schema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Name, phone, email or address fragment." },
                side: { type: "string", enum: ["buyer", "seller"] },
                status: { type: "string", description: `One of: ${types_js_1.TRACKER_STATUSES.join(", ")}` },
                buyerStage: { type: "string", description: `One of: ${BUYER_STAGE_KEYS.join(", ")}` },
                sellerStage: { type: "string", description: `One of: ${SELLER_STAGE_KEYS.join(", ")}` },
                source: { type: "string" },
                assignedTo: { type: "string" },
                contactableOnly: {
                    type: "boolean",
                    description: "Only people with a phone or email. 472 records are social handles with neither.",
                },
                limit: { type: "number", description: "Default 25, max 200." },
            },
            required: [],
        },
    },
    {
        name: "get_tracker_record",
        description: "Everything about one tracker person: both pipeline stages, stage history and timeline dates, notes, full checklist including which items are linked to Task Command.",
        input_schema: {
            type: "object",
            properties: { id: { type: "string", description: "Tracker record id." } },
            required: ["id"],
        },
    },
    {
        name: "set_tracker_stage",
        description: "Move one side of a person along their pipeline — e.g. move a seller to 'listing_appointment_set'. Buyer and seller sides move independently. Pass stage null to move them back to Unstaged. Call get_tracker_pipelines first if unsure of the stage key.",
        input_schema: {
            type: "object",
            properties: {
                id: { type: "string" },
                side: { type: "string", enum: ["buyer", "seller"] },
                stage: { type: "string", description: "Stage key, or empty string for Unstaged." },
                timelineDate: {
                    type: "string",
                    description: "Optional YYYY-MM-DD, when they are looking to buy or list.",
                },
            },
            required: ["id", "side", "stage"],
        },
    },
    {
        name: "update_tracker_record",
        description: "Update a tracker person's status, notes, assignee, or record that they were contacted today. Does not move pipeline stages — use set_tracker_stage for that.",
        input_schema: {
            type: "object",
            properties: {
                id: { type: "string" },
                status: { type: "string", description: `One of: ${types_js_1.TRACKER_STATUSES.join(", ")}` },
                notes: { type: "string" },
                assignedTo: { type: "string" },
                contactedNow: { type: "boolean", description: "Stamp last contact as right now." },
            },
            required: ["id"],
        },
    },
    {
        name: "push_tracker_checklist_to_tasks",
        description: "Send a tracker person's checklist items to the Task Command board as real tasks, assigned to whoever that person is assigned to. Already-sent items are skipped. Completion then syncs both ways between the checklist and the task.",
        input_schema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Tracker record id." },
                column: { type: "string", enum: TASK_COLUMNS, description: "Default 'today'." },
            },
            required: ["id"],
        },
    },
    {
        name: "get_task_board",
        description: "Task Command board: counts plus the tasks themselves. Filter by column (urgent/today/tomorrow/this_week/this_month), status, or assignee. Use for 'what's due today', 'what is Wesley working on', 'what's overdue'.",
        input_schema: {
            type: "object",
            properties: {
                column: { type: "string", enum: TASK_COLUMNS },
                status: { type: "string", enum: TASK_STATUSES },
                assignedTo: { type: "string", description: "marco, wesley, kendrick or carlos." },
                includeDone: { type: "boolean", description: "Default false." },
                limit: { type: "number", description: "Default 40, max 200." },
            },
            required: [],
        },
    },
    {
        name: "create_task",
        description: "Put a task on the Task Command board. Use when asked to remember, schedule or delegate something.",
        input_schema: {
            type: "object",
            properties: {
                title: { type: "string" },
                column: { type: "string", enum: TASK_COLUMNS, description: "Default 'today'." },
                assignedTo: { type: "string", description: "marco, wesley, kendrick or carlos." },
                description: { type: "string" },
                dueDate: { type: "string", description: "YYYY-MM-DD." },
                dueTime: { type: "string", description: "HH:MM, 24h." },
                urgent: { type: "boolean", description: "Puts it in the urgent column, red." },
            },
            required: ["title"],
        },
    },
    {
        name: "update_task",
        description: "Change a task: mark it done, move it to another column, reassign it, or change its due date.",
        input_schema: {
            type: "object",
            properties: {
                id: { type: "string" },
                status: { type: "string", enum: TASK_STATUSES },
                column: { type: "string", enum: TASK_COLUMNS },
                assignedTo: { type: "string" },
                dueDate: { type: "string", description: "YYYY-MM-DD." },
                title: { type: "string" },
            },
            required: ["id"],
        },
    },
    {
        name: "get_team_status",
        description: "Who is online, unread team chat counts, and recent notifications for a team member. Use for 'is Wesley around', 'what did I miss'.",
        input_schema: {
            type: "object",
            properties: {
                user: { type: "string", description: "Team member id; default marco." },
                limit: { type: "number", description: "Notifications to return, default 15." },
            },
            required: [],
        },
    },
    {
        name: "get_command_settings",
        description: "The team-wide command settings — most importantly the shared time zone that every due date, deadline and task rollover resolves against, plus today's date in that zone.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
];
exports.PLATFORM_TOOL_NAMES = new Set(exports.PLATFORM_TOOL_DEFINITIONS.map((t) => t.name));
async function executePlatformTool(name, input) {
    switch (name) {
        case "browser_status": {
            const st = (0, browserControl_js_1.status)();
            if (!st.configured) {
                return { ...st, hint: "BROWSER_CONTROL_TOKEN is not set on the server, so browser control is disabled entirely." };
            }
            if (!st.connected) {
                return { ...st, hint: "Extension not connected. The operator needs Chrome open with the Harvey extension installed and paired." };
            }
            if (!st.enabled) {
                return { ...st, hint: "Extension is connected but switched OFF. Ask the operator to turn on 'Let Harvey control this browser' in the extension popup." };
            }
            return { ...st, recent: (0, browserControl_js_1.recentActivity)(5) };
        }
        case "browser_navigate": {
            const url = normalizeNavigateUrl(str(input.url));
            if (!url) {
                return { error: "That doesn't look like a web address. Give a domain or URL, e.g. books.toscrape.com" };
            }
            return await (0, browserControl_js_1.run)({ action: "navigate", url });
        }
        case "browser_wait_for":
            return await (0, browserControl_js_1.run)({
                action: "waitFor",
                selector: str(input.selector) || undefined,
                text: str(input.text) || undefined,
                timeoutMs: num(input.timeoutMs, 15000),
            }, { timeoutMs: num(input.timeoutMs, 15000) + 8000 });
        case "browser_structured_data":
            return await (0, browserControl_js_1.run)({ action: "structured" });
        case "browser_scroll":
            return await (0, browserControl_js_1.run)({ action: "scroll", to: str(input.to) || "bottom" }, { timeoutMs: 30000 });
        case "browser_show_tab":
            return await (0, browserControl_js_1.run)({ action: "focus" });
        case "browser_screenshot": {
            const r = await (0, browserControl_js_1.run)({ action: "screenshot", maxWidth: num(input.maxWidth, 1000) }, { timeoutMs: 40000 });
            if (!r.ok || !r.image)
                return r;
            // `_image` is the convention the agent loop understands: it lifts this
            // into a real image block so the model actually looks at the page
            // instead of being handed a base64 string it can only describe.
            const { image, ...rest } = r;
            return { ...rest, _image: image };
        }
        case "browser_enable": {
            const st = (0, browserControl_js_1.status)();
            if (!st.configured) {
                return { ok: false, error: "Browser control isn't configured on the server (BROWSER_CONTROL_TOKEN is unset), so there's nothing to switch on." };
            }
            const r = (0, browserControl_js_1.requestArm)();
            if (!r.connected) {
                return { ok: false, error: "No paired browser is reachable. The operator needs Chrome open with the Harvey extension installed." };
            }
            if (r.locked) {
                return {
                    ok: false,
                    locked: true,
                    error: "The operator locked remote arming in the extension popup. Tell them to switch 'Let Harvey control this browser' on themselves — you cannot do it while that lock is set.",
                };
            }
            if (r.alreadyOn)
                return { ok: true, enabled: true, note: "Browser control was already on." };
            return { ok: true, enabled: true, note: "Browser control switched on — the extension arms within a second or two." };
        }
        case "browser_disable": {
            const st = (0, browserControl_js_1.status)();
            if (!st.configured)
                return { ok: true, enabled: false, note: "Browser control isn't configured at all, so nothing is armed." };
            const r = (0, browserControl_js_1.requestDisarm)();
            if (!r.connected) {
                return { ok: true, enabled: false, note: "The extension isn't connected, so nothing can run. It starts switched off when it reconnects." };
            }
            if (r.alreadyOff)
                return { ok: true, enabled: false, note: "Browser control was already off." };
            return {
                ok: true,
                enabled: false,
                note: "Browser control switched off — the extension disarms on its next poll (within ~2 seconds) and any queued actions were dropped. To turn it back on, the operator flips the switch in the extension popup; you cannot.",
            };
        }
        case "browser_read": {
            const r = await (0, browserControl_js_1.run)({ action: "read", selector: str(input.selector) || undefined });
            const meta = (r.meta || {});
            if (r.ok && meta.needsLogin) {
                // Without this, a sign-in wall looks like a thin page and gets
                // reported as "there's nothing on this listing".
                return {
                    ...r,
                    hint: "This page is a SIGN-IN WALL, not the content — do not report it as an empty or missing listing. Do NOT ask for their password and do not try to type one. Call browser_show_tab, ask the operator to sign in themselves, then continue: their session stays in that tab.",
                };
            }
            if (r.ok && meta.truncated) {
                return { ...r, hint: "The page was longer than the limit and this is the top of it. Use browser_extract or a selector for anything further down." };
            }
            return r;
        }
        case "browser_click": {
            const text = str(input.text);
            const selector = str(input.selector);
            if (!text && !selector)
                return { error: "Give either text (the visible label) or selector." };
            return await (0, browserControl_js_1.run)({ action: "click", text: text || undefined, selector: selector || undefined });
        }
        case "browser_fill": {
            const fields = (input.fields && typeof input.fields === "object" ? input.fields : {});
            if (!Object.keys(fields).length)
                return { error: "fields is required — a map of CSS selector to value." };
            return await (0, browserControl_js_1.run)({ action: "fill", fields });
        }
        case "browser_extract": {
            const schema = (input.schema && typeof input.schema === "object" ? input.schema : {});
            if (!Object.keys(schema).length)
                return { error: "schema is required — a map of field name to CSS selector." };
            return await (0, browserControl_js_1.run)({ action: "extract", schema });
        }
        case "search_knowledge": {
            const query = str(input.query);
            if (!query)
                return { error: "query is required" };
            const results = (0, knowledgeStore_js_1.searchDocs)(query, Math.min(10, Math.max(1, num(input.limit, 5))));
            if (!results.length) {
                // An empty shelf and a wrong answer are very different failures. Make
                // sure Harvey reports the former instead of improvising a procedure.
                return {
                    results: [],
                    note: `Nothing in the Knowledge Center matches "${query}". Say so plainly — do not invent a process. Suggest the SOP be written and added.`,
                    available: (0, knowledgeStore_js_1.listCategories)(),
                };
            }
            return {
                results,
                note: "Cite the document title when answering. Call read_knowledge_doc for the full steps if the excerpt isn't enough.",
            };
        }
        case "read_knowledge_doc": {
            const doc = (0, knowledgeStore_js_1.getDoc)(str(input.id));
            if (!doc)
                return { error: `No document with id ${str(input.id)}` };
            return {
                id: doc.id, title: doc.title, category: doc.category, tags: doc.tags,
                body: doc.body, updatedAt: doc.updatedAt,
                builtIn: Boolean(doc.builtIn),
            };
        }
        case "list_knowledge": {
            const category = str(input.category) || undefined;
            return {
                categories: (0, knowledgeStore_js_1.listCategories)(),
                stats: (0, knowledgeStore_js_1.knowledgeStats)(),
                docs: (0, knowledgeStore_js_1.listDocs)(category).map((d) => ({
                    id: d.id, title: d.title, category: d.category, tags: d.tags, updatedAt: d.updatedAt,
                })),
            };
        }
        case "get_lead": {
            const lead = await (0, db_js_2.getLeadById)(str(input.leadId));
            if (!lead)
                return { error: `No lead with id ${str(input.leadId)}` };
            const convo = await (0, db_js_2.getConversation)(lead.id);
            return {
                id: lead.id,
                name: lead.name || lead.username || null,
                phone: lead.phone || null,
                email: lead.email || null,
                channel: (0, messageChannels_js_1.channelForLead)(lead),
                source: lead.source || null,
                crmStatus: lead.crmStatus,
                crmStage: lead.crmStage,
                crmIntent: lead.crmIntent,
                crmPriority: lead.crmPriority,
                notes: lead.crmNotes || null,
                tags: lead.tags || [],
                criteria: lead.criteria || null,
                propertyInquired: lead.propertyInquired || null,
                messages: convo?.messages?.length || 0,
                lastActivity: lead.lastActivity || null,
                recentActivity: (lead.activity || []).slice(-6).map((a) => ({
                    type: a.type, description: a.description, at: a.timestamp,
                })),
            };
        }
        case "update_lead": {
            const leadId = str(input.leadId);
            const lead = await (0, db_js_2.getLeadById)(leadId);
            if (!lead)
                return { error: `No lead with id ${leadId}` };
            // Only what was actually passed — an omitted field must never be
            // blanked, or "mark him hot" would quietly wipe his phone number.
            const patch = { leadId };
            const changed = [];
            const setIf = (key, value, valid) => {
                if (!value)
                    return true;
                if (valid && !valid.includes(value))
                    return false;
                patch[key] = value;
                changed.push(`${key}=${value}`);
                return true;
            };
            if (!setIf("crmStatus", str(input.crmStatus), types_js_1.CRM_STATUSES)) {
                return { error: `Invalid crmStatus. Use one of: ${types_js_1.CRM_STATUSES.join(", ")}` };
            }
            if (!setIf("crmStage", str(input.crmStage), types_js_1.CRM_STAGES)) {
                return { error: `Invalid crmStage. Use one of: ${types_js_1.CRM_STAGES.join(", ")}` };
            }
            if (!setIf("crmIntent", str(input.crmIntent), ["buyer", "seller", "buyer_seller"])) {
                return { error: "Invalid crmIntent. Use buyer, seller or buyer_seller." };
            }
            if (!setIf("crmPriority", str(input.crmPriority), ["low", "normal", "high"])) {
                return { error: "Invalid crmPriority. Use low, normal or high." };
            }
            setIf("name", str(input.name));
            setIf("phone", str(input.phone));
            setIf("email", str(input.email));
            if (str(input.notes)) {
                patch.crmNotes = str(input.notes);
                changed.push("notes");
            }
            if (changed.length === 0)
                return { error: "Nothing to change — pass at least one field." };
            const updated = await (0, db_js_2.updateLeadCrmFields)(patch);
            if (!updated)
                return { error: "Update failed" };
            return {
                updated: true,
                leadId,
                name: updated.name || updated.username || null,
                changed,
                crmStatus: updated.crmStatus,
                crmStage: updated.crmStage,
            };
        }
        case "log_lead_activity": {
            const leadId = str(input.leadId);
            const lead = await (0, db_js_2.getLeadById)(leadId);
            if (!lead)
                return { error: `No lead with id ${leadId}` };
            const type = str(input.type) || "note";
            const description = str(input.description);
            if (!description)
                return { error: "description is required" };
            const entry = {
                type: (type === "note" ? "task" : type),
                description,
                timestamp: new Date().toISOString(),
                ...(str(input.notes) ? { notes: str(input.notes) } : {}),
            };
            // appendLeadActivity already normalises and merges — rebuilding the
            // array here would bypass that and risk dropping existing entries.
            const updated = await (0, db_js_2.appendLeadActivity)(leadId, [entry], { lastActivity: entry.timestamp });
            if (!updated)
                return { error: "Could not write the activity" };
            return {
                logged: true,
                leadId,
                name: updated.name || updated.username || null,
                type: entry.type,
                description,
                at: entry.timestamp,
                totalActivity: (updated.activity || []).length,
            };
        }
        case "create_lead": {
            const name = str(input.name);
            const phone = str(input.phone);
            const email = str(input.email);
            if (!name)
                return { error: "name is required" };
            if (!phone && !email) {
                return { error: "A phone or an email is required — a contact with neither can't be reached." };
            }
            // Cheap duplicate guard. A second copy of someone already in the CRM
            // is worse than not adding them, because it splits their history.
            let existing = phone ? await (0, db_js_2.findLeadByPhoneDigits)(phone) : null;
            if (!existing && email) {
                const target = email.toLowerCase();
                existing = (await (0, db_js_2.listAllLeads)()).find((l) => (l.email || "").toLowerCase() === target) || null;
            }
            if (existing) {
                return {
                    error: "That contact already exists — use update_lead instead of creating a duplicate.",
                    existingLeadId: existing.id,
                    existingName: existing.name || existing.username || null,
                };
            }
            const created = await (0, db_js_2.createLead)({
                platform: "manual",
                userId: `manual_${Date.now()}`,
                username: null,
                name,
                phone: phone || null,
                email: email || null,
                state: "new",
                source: str(input.source) || "Added by Harvey",
                adCampaign: null,
                propertyInquired: null,
                criteria: null,
                brivityId: null,
                crmStatus: "new",
                crmStage: "new",
                crmPriority: "normal",
                crmIntent: (str(input.crmIntent) || "buyer"),
                crmCallQueue: null,
                crmNotes: str(input.notes) || null,
            });
            return { created: true, leadId: created.id, name: created.name, phone: created.phone, email: created.email };
        }
        case "schedule_message": {
            const leadId = str(input.leadId);
            const channel = input.channel === "email" ? "email" : "sms";
            const body = str(input.body);
            if (!leadId || !body)
                return { error: "leadId and body are required" };
            const whenRaw = str(input.when);
            // Refuse to invent a time. A wrong guess here is a real message to a
            // real client at the wrong hour, so an unparseable phrase comes back as
            // a question for the user instead of a best guess.
            const parsed = whenRaw ? (0, scheduleTime_js_1.parseSendTime)(whenRaw) : (0, scheduleTime_js_1.suggestNextGoodTime)();
            if (!parsed) {
                return {
                    error: `Couldn't understand the send time "${whenRaw}". Ask the user for a clearer time.`,
                    examples: ["tomorrow at 9am", "Tuesday morning", "in 2 hours", "2026-08-05 14:30"],
                };
            }
            const lead = await (0, db_js_2.getLeadById)(leadId);
            if (!lead)
                return { error: `No lead with id ${leadId}` };
            const leadName = lead.name || lead.username || "Lead";
            const to = channel === "sms" ? lead.phone : lead.email;
            if (!to)
                return { error: `${leadName} has no ${channel === "sms" ? "phone number" : "email address"} on file` };
            const msg = (0, scheduledMessages_js_1.scheduleMessage)({
                leadId,
                leadName,
                channel,
                to,
                subject: str(input.subject) || undefined,
                body,
                sendAt: parsed.sendAt,
                createdBy: "harvey",
                requestedTime: whenRaw || undefined,
            });
            const capability = await (0, scheduledSender_js_1.canSendOn)(channel);
            return {
                scheduled: true,
                id: msg.id,
                to,
                leadName,
                channel,
                sendAt: msg.sendAt,
                interpreted: parsed.interpreted,
                // Queued ≠ deliverable. Never let Harvey imply this will arrive.
                warning: capability.ok
                    ? undefined
                    : `Queued, but it will NOT be delivered: ${capability.reason}`,
            };
        }
        case "list_scheduled_messages": {
            const msgs = (0, scheduledMessages_js_1.listScheduled)({
                status: (str(input.status) || undefined),
                leadId: str(input.leadId) || undefined,
                limit: Math.min(100, Math.max(1, num(input.limit, 20))),
            });
            return {
                counts: (0, scheduledMessages_js_1.scheduledCounts)(),
                canDeliver: { sms: await (0, scheduledSender_js_1.canSendOn)("sms"), email: await (0, scheduledSender_js_1.canSendOn)("email") },
                messages: msgs.map((m) => ({
                    id: m.id,
                    leadName: m.leadName,
                    channel: m.channel,
                    to: m.to,
                    sendAt: m.sendAt,
                    status: m.status,
                    createdBy: m.createdBy,
                    preview: m.body.slice(0, 120),
                    error: m.error,
                })),
            };
        }
        case "cancel_scheduled_message": {
            const id = str(input.id);
            if (!id)
                return { error: "id is required" };
            const existing = (0, scheduledMessages_js_1.getScheduled)(id);
            if (!existing)
                return { error: `No scheduled message with id ${id}` };
            if (!(0, scheduledMessages_js_1.cancelScheduled)(id)) {
                return { error: `That message is already ${existing.status} — it can't be canceled.` };
            }
            return { canceled: true, id, leadName: existing.leadName, channel: existing.channel };
        }
        case "get_tracker_summary": {
            const c = (0, trackerStore_js_1.trackerCounts)();
            const all = (0, trackerStore_js_1.listTrackerRecords)({});
            const contactable = all.filter((r) => (r.phone || "").trim() || (r.email || "").trim()).length;
            return {
                ...c,
                contactable,
                noContactInfo: all.length - contactable,
                note: "Records with no phone or email are Instagram/TikTok handles from the DM funnel — they cannot be called or emailed yet.",
            };
        }
        case "get_tracker_pipelines":
            return {
                statuses: types_js_1.TRACKER_STATUSES,
                buyerStages: types_js_1.BUYER_STAGES,
                sellerStages: types_js_1.SELLER_STAGES,
                note: "Stages are per side and move independently; a person can be both a buyer and a seller.",
            };
        case "search_tracker": {
            const filter = {
                q: str(input.query) || undefined,
                side: input.side === "buyer" || input.side === "seller" ? input.side : undefined,
                status: str(input.status) ? [str(input.status)] : undefined,
                buyerStage: str(input.buyerStage) ? [str(input.buyerStage)] : undefined,
                sellerStage: str(input.sellerStage) ? [str(input.sellerStage)] : undefined,
                source: str(input.source) ? [str(input.source)] : undefined,
                assignedTo: str(input.assignedTo) || undefined,
            };
            let rows = (0, trackerTasks_js_1.applyTaskStateAll)((0, trackerStore_js_1.listTrackerRecords)(filter));
            if (input.contactableOnly === true) {
                rows = rows.filter((r) => (r.phone || "").trim() || (r.email || "").trim());
            }
            const limit = Math.min(200, Math.max(1, num(input.limit, 25)));
            return {
                matched: rows.length,
                returned: Math.min(limit, rows.length),
                records: rows.slice(0, limit).map(slimRecord),
            };
        }
        case "get_tracker_record": {
            const raw = (0, trackerStore_js_1.getTrackerRecord)(str(input.id));
            if (!raw)
                return { error: "No tracker record with that id." };
            const r = (0, trackerTasks_js_1.applyTaskState)(raw);
            return {
                ...slimRecord(r),
                stageMeta: r.stageMeta || {},
                checklistItems: (r.checklist || []).map((c) => ({
                    id: c.id,
                    text: c.text,
                    done: c.done,
                    inTaskManager: Boolean(c.taskId),
                })),
                legacyStage: r.legacyStage ?? null,
                leadId: r.leadId ?? null,
                addedAt: r.addedAt,
            };
        }
        case "set_tracker_stage": {
            const id = str(input.id);
            const side = input.side === "seller" ? "seller" : "buyer";
            const stage = str(input.stage);
            const valid = side === "buyer" ? BUYER_STAGE_KEYS : SELLER_STAGE_KEYS;
            if (stage && !valid.includes(stage)) {
                return { error: `'${stage}' is not a ${side} stage.`, validStages: valid };
            }
            const meta = str(input.timelineDate) ? { timelineDate: str(input.timelineDate) } : undefined;
            const rec = (0, trackerStore_js_1.setTrackerStage)(id, side, stage || null, meta);
            if (!rec)
                return { error: "No tracker record with that id." };
            return {
                ok: true,
                moved: `${rec.name} → ${side}: ${stage || "Unstaged"}`,
                record: slimRecord(rec),
            };
        }
        case "update_tracker_record": {
            const id = str(input.id);
            const patch = {};
            if (str(input.status)) {
                if (!types_js_1.TRACKER_STATUSES.includes(str(input.status))) {
                    return { error: `'${input.status}' is not a status.`, validStatuses: types_js_1.TRACKER_STATUSES };
                }
                patch.status = str(input.status);
            }
            if (typeof input.notes === "string")
                patch.notes = input.notes;
            if (str(input.assignedTo))
                patch.assignedTo = str(input.assignedTo);
            if (input.contactedNow === true)
                patch.lastInteractionAt = new Date().toISOString();
            if (!Object.keys(patch).length)
                return { error: "Nothing to update." };
            const rec = (0, trackerStore_js_1.updateTrackerRecord)(id, patch);
            if (!rec)
                return { error: "No tracker record with that id." };
            return { ok: true, updated: Object.keys(patch), record: slimRecord(rec) };
        }
        case "push_tracker_checklist_to_tasks": {
            const column = TASK_COLUMNS.includes(input.column)
                ? input.column
                : "today";
            const out = (0, trackerTasks_js_1.pushChecklistToTasks)(str(input.id), undefined, column);
            if (!out)
                return { error: "No tracker record with that id." };
            return {
                ok: true,
                created: out.created.length,
                alreadyLinked: out.skipped,
                tasks: out.created.map((t) => ({ id: t.id, title: t.title, assignedTo: t.assignedTo })),
            };
        }
        case "get_task_board": {
            const all = (0, db_js_1.getCommandTasks)();
            const includeDone = input.includeDone === true;
            const column = str(input.column);
            const status = str(input.status);
            const who = str(input.assignedTo).toLowerCase();
            let rows = all.filter((t) => {
                if (!includeDone && t.status === "done")
                    return false;
                if (column && t.column !== column)
                    return false;
                if (status && t.status !== status)
                    return false;
                if (who && String(t.assignedTo || "").toLowerCase() !== who)
                    return false;
                return true;
            });
            const limit = Math.min(200, Math.max(1, num(input.limit, 40)));
            const today = (0, commandSettings_js_1.commandDateString)();
            return {
                summary: (0, db_js_1.buildCommandTasksSummary)(all),
                today,
                timeZone: (0, commandSettings_js_1.getCommandSettings)().timeZone,
                overdue: rows.filter((t) => t.dueDate && t.dueDate < today && t.status !== "done").length,
                matched: rows.length,
                tasks: rows.slice(0, limit).map(slimTask),
            };
        }
        case "create_task": {
            const title = str(input.title);
            if (!title)
                return { error: "title is required." };
            const urgent = input.urgent === true;
            const column = urgent
                ? "urgent"
                : TASK_COLUMNS.includes(input.column)
                    ? input.column
                    : "today";
            const task = (0, db_js_1.createCommandTask)({
                title: title.slice(0, 300),
                description: str(input.description) || undefined,
                column,
                status: "pending",
                color: urgent ? "red" : "blue",
                assignedTo: str(input.assignedTo).toLowerCase() || "carlos",
                createdBy: "harvey",
                dueDate: str(input.dueDate).slice(0, 10) || undefined,
                dueTime: /^\d{2}:\d{2}$/.test(str(input.dueTime)) ? str(input.dueTime) : undefined,
                tags: ["harvey"],
            });
            return { ok: true, task: slimTask(task) };
        }
        case "update_task": {
            const id = str(input.id);
            const patch = {};
            if (str(input.status))
                patch.status = str(input.status);
            if (str(input.column))
                patch.column = str(input.column);
            if (str(input.assignedTo))
                patch.assignedTo = str(input.assignedTo).toLowerCase();
            if (str(input.dueDate))
                patch.dueDate = str(input.dueDate).slice(0, 10);
            if (str(input.title))
                patch.title = str(input.title).slice(0, 300);
            if (patch.status === "done")
                patch.completedAt = new Date().toISOString();
            if (!Object.keys(patch).length)
                return { error: "Nothing to update." };
            const task = (0, db_js_1.updateCommandTask)(id, patch);
            if (!task)
                return { error: "No task with that id." };
            return { ok: true, task: slimTask(task) };
        }
        case "get_team_status": {
            const user = str(input.user).toLowerCase() || "marco";
            const limit = Math.min(100, Math.max(1, num(input.limit, 15)));
            return {
                user,
                presence: (0, teamStore_js_1.getPresence)(),
                unreadChat: (0, teamStore_js_1.chatUnreadCounts)(user),
                notifications: (0, teamStore_js_1.getNotifications)(user, limit).map((n) => ({
                    type: n.type,
                    title: n.title,
                    body: n.body,
                    from: n.from ?? null,
                    read: Boolean(n.readAt),
                    at: n.at,
                })),
            };
        }
        case "get_command_settings": {
            const s = (0, commandSettings_js_1.getCommandSettings)();
            return {
                timeZone: s.timeZone,
                todayInCommandZone: (0, commandSettings_js_1.commandDateString)(),
                note: "This one zone drives every due date, deadline and task rollover for the whole team, regardless of where each person is.",
                updatedAt: s.updatedAt,
            };
        }
        default:
            return { error: `Unknown platform tool: ${name}` };
    }
}
/* ===================== Workspace files + background jobs =====================
   Harvey could read everything and produce nothing durable, and could not run
   anything longer than 8 tool rounds inside one HTTP request. These close both. */
exports.WORKSPACE_TOOL_DEFINITIONS = [
    {
        name: "list_files",
        description: "List files in Harvey's workspace — the durable scratch space where drafts, reports, exports and notes live. Optionally filter by a path prefix like 'reports/'.",
        input_schema: {
            type: "object",
            properties: { prefix: { type: "string", description: "Optional folder prefix." } },
            required: [],
        },
    },
    {
        name: "read_file",
        description: "Read a file from the workspace.",
        input_schema: {
            type: "object",
            properties: { path: { type: "string", description: "Relative path, e.g. 'reports/hot-sellers.md'." } },
            required: ["path"],
        },
    },
    {
        name: "write_file",
        description: "Create or overwrite a workspace file. Use for drafts, reports, exports, call lists, notes — anything that should outlive the conversation. Paths are relative and folders are created as needed. Allowed types: .md .txt .csv .json .html .yaml .log .tsv .xml .sql .ics",
        input_schema: {
            type: "object",
            properties: {
                path: { type: "string" },
                content: { type: "string" },
                append: { type: "boolean", description: "Append instead of overwriting." },
            },
            required: ["path", "content"],
        },
    },
    {
        name: "edit_file",
        description: "Replace an exact snippet in a workspace file. Fails if the snippet is missing or appears more than once (unless replaceAll), so a partial match can never rewrite the wrong line.",
        input_schema: {
            type: "object",
            properties: {
                path: { type: "string" },
                find: { type: "string", description: "Exact text to replace." },
                replace: { type: "string" },
                replaceAll: { type: "boolean" },
            },
            required: ["path", "find", "replace"],
        },
    },
    {
        name: "delete_file",
        description: "Delete a workspace file.",
        input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
        },
    },
    {
        name: "start_background_job",
        description: "Hand a long task to a background worker that runs to completion on its own — many tool calls, minutes of work, no further prompting. Use when the task is too big to finish in this reply (e.g. 'go through every hot seller and draft a follow-up'). Returns a job id immediately; check it with get_job. Do NOT use for quick questions you can answer directly.",
        input_schema: {
            type: "object",
            properties: {
                task: {
                    type: "string",
                    description: "Complete, self-contained instructions. The worker cannot ask questions.",
                },
            },
            required: ["task"],
        },
    },
    {
        name: "get_job",
        description: "Status, steps taken and result of a background job.",
        input_schema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
        },
    },
    {
        name: "list_jobs",
        description: "Recent background jobs and their status.",
        input_schema: {
            type: "object",
            properties: { limit: { type: "number", description: "Default 10." } },
            required: [],
        },
    },
];
exports.WORKSPACE_TOOL_NAMES = new Set(exports.WORKSPACE_TOOL_DEFINITIONS.map((t) => t.name));
async function executeWorkspaceTool(name, input) {
    const ws = await Promise.resolve().then(() => __importStar(require("../core/workspace.js")));
    const jobs = await Promise.resolve().then(() => __importStar(require("../core/jobStore.js")));
    try {
        switch (name) {
            case "list_files": {
                const files = await ws.listFiles(str(input.prefix) || undefined);
                return { count: files.length, files: files.slice(0, 200) };
            }
            case "read_file":
                return await ws.readFile(str(input.path));
            case "write_file": {
                const f = await ws.writeFile(str(input.path), String(input.content ?? ""), {
                    append: input.append === true,
                });
                return { ok: true, ...f };
            }
            case "edit_file":
                return {
                    ok: true,
                    ...(await ws.editFile(str(input.path), String(input.find ?? ""), String(input.replace ?? ""), input.replaceAll === true)),
                };
            case "delete_file": {
                const gone = await ws.deleteFile(str(input.path));
                return gone ? { ok: true, deleted: str(input.path) } : { error: "No such file." };
            }
            case "start_background_job": {
                const task = str(input.task);
                if (!task)
                    return { error: "task is required." };
                const { startJob } = await Promise.resolve().then(() => __importStar(require("../hull/jobRunner.js")));
                const job = startJob(task, "harvey");
                return {
                    ok: true,
                    id: job.id,
                    status: job.status,
                    note: "Running in the background. Check it with get_job.",
                };
            }
            case "get_job": {
                const j = jobs.getJob(str(input.id));
                if (!j)
                    return { error: "No job with that id." };
                return {
                    id: j.id,
                    status: j.status,
                    prompt: j.prompt,
                    toolCalls: j.toolCalls,
                    steps: j.steps.length,
                    result: j.result,
                    error: j.error,
                    startedAt: j.startedAt,
                    finishedAt: j.finishedAt,
                    recentSteps: j.steps.slice(-8).map((s) => ({ n: s.n, kind: s.kind, tool: s.tool ?? null })),
                };
            }
            case "list_jobs":
                return {
                    jobs: jobs.listJobs(Math.min(50, Math.max(1, num(input.limit, 10)))).map((j) => ({
                        id: j.id,
                        status: j.status,
                        prompt: j.prompt.slice(0, 120),
                        toolCalls: j.toolCalls,
                        createdAt: j.createdAt,
                    })),
                };
            default:
                return { error: `Unknown workspace tool: ${name}` };
        }
    }
    catch (err) {
        // Workspace errors are meaningful to the model (bad path, missing file,
        // ambiguous edit) — surface them rather than throwing the job away.
        return { error: err instanceof Error ? err.message : String(err) };
    }
}
