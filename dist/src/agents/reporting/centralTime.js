"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startOfCentralDayIso = startOfCentralDayIso;
exports.centralDateString = centralDateString;
/** Start of calendar day in America/Chicago as ISO UTC string. */
function startOfCentralDayIso(now = new Date()) {
    const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
    const [y, m, d] = dateStr.split("-").map(Number);
    const chicagoAsUtc = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
    const utcAsUtc = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
    const offsetMs = utcAsUtc.getTime() - chicagoAsUtc.getTime();
    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) + offsetMs).toISOString();
}
function centralDateString(now = new Date()) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
}
