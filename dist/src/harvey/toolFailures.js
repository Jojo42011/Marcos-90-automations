"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toolFailure = toolFailure;
/** Retain actionable errors without retaining tool arguments or credentials. */
function toolFailure(name, input, result) {
    const error = (value, depth = 0) => {
        if (!value || typeof value !== "object" || depth > 3)
            return "";
        if (typeof value.error === "string")
            return value.error;
        if (value.isError)
            return (value.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ") || "Tool returned isError";
        for (const v of Object.values(value)) {
            const found = error(v, depth + 1);
            if (found)
                return found;
        }
        return "";
    };
    let message = error(result);
    if (!message)
        return undefined;
    const original = message;
    const redact = (value, key = "") => { if (typeof value === "string" && value.length >= 4 && !['tool', 'action'].includes(key))
        message = message.split(value).join('[redacted]');
    else if (value && typeof value === "object")
        for (const [k, v] of Object.entries(value))
            redact(v, k); };
    redact(input);
    message = message.replace(/https?:\/\/[^\s"'<>]+/gi, '[url]').replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]').replace(/(?:bearer\s+|(?:password|token|secret|api.?key)\s*[:=]\s*)[^\s,;"']+/gi, '[credential]').replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[token]').replace(/monte\s+carlo/gi, '[passphrase]').slice(0, 500);
    const code = /REPEATED CALL REFUSED/i.test(original) ? 'repeat_refused' : /argument|schema|invalid type|invalid choice|deltas/i.test(original) ? 'arguments' : /unsupported|unknown|not available in this mode/i.test(original) ? 'unsupported_tool' : /disconnected|connection.*(?:closed|lost)|not connected|computer selection changed/i.test(original) ? 'browser_disconnected' : /timeout|timed out/i.test(original) ? 'timeout' : /target|selector|reference|ref=/i.test(original) ? 'targeting' : 'tool_error';
    const action = name === 'computer' && /^[a-z_]{1,80}$/.test(input?.tool || '') ? input.tool : undefined;
    return { code, message, detail: action ? name + '/' + action : name };
}
