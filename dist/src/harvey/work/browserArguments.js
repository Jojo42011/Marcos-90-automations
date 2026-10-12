"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.browserArguments = browserArguments;
/** Adapt known legacy locator keys to the installed tool schema, without guessing targets. */
function browserArguments(schema, input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Browser arguments must be an object");
    const args = { ...input }, props = schema?.properties || {};
    for (const [canonical, aliases] of [["target", ["ref", "selector"]], ["startTarget", ["startRef"]], ["endTarget", ["endRef"]]]) {
        if (!props[canonical])
            continue;
        for (const alias of aliases) {
            if (args[alias] === undefined)
                continue;
            if (args[canonical] !== undefined && args[canonical] !== args[alias])
                throw new Error("Conflicting browser target arguments; use only " + canonical);
            args[canonical] = args[alias];
            delete args[alias];
        }
    }
    if (Array.isArray(args.fields) && props.fields?.items)
        args.fields = args.fields.map((f) => browserArguments(props.fields.items, f));
    for (const required of schema?.required || [])
        if (args[required] === undefined)
            throw new Error("Missing browser argument: " + required + ". Use the attached installed schema.");
    return args;
}
