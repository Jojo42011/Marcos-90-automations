"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerHullWs = registerHullWs;
exports.broadcastHullEvent = broadcastHullEvent;
const ws_1 = require("ws");
const clients = new Set();
function registerHullWs(ws) {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
}
function broadcastHullEvent(payload) {
    const msg = JSON.stringify(payload);
    for (const c of clients) {
        if (c.readyState === ws_1.WebSocket.OPEN)
            c.send(msg);
    }
}
