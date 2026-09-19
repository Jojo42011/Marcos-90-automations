"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelLayerError = void 0;
exports.redactSecrets = redactSecrets;
/**
 * Every failure this layer raises, with the upstream status and body attached.
 *
 * "The model call failed" is useless at 11pm. The status code and the first
 * few hundred characters of the provider's own error text are what turn it
 * into "402, insufficient credits" — so they travel with the error, redacted
 * so a key echoed back in an error body cannot reach a log or a browser.
 */
class ModelLayerError extends Error {
    code;
    status;
    provider;
    model;
    body;
    constructor(code, message, extra = {}) {
        super(redactSecrets(message));
        this.name = "ModelLayerError";
        this.code = code;
        this.status = extra.status;
        this.provider = extra.provider;
        this.model = extra.model;
        this.body = extra.body ? redactSecrets(extra.body).slice(0, 600) : undefined;
    }
    /** One line for the usage log and for the operator. Never contains a key. */
    get summary() {
        const bits = [this.provider, this.model, this.status ? `HTTP ${this.status}` : null]
            .filter(Boolean)
            .join(" ");
        return `${bits ? bits + ": " : ""}${this.message}${this.body ? ` — ${this.body}` : ""}`.slice(0, 1000);
    }
}
exports.ModelLayerError = ModelLayerError;
/**
 * Strip anything that looks like a credential.
 *
 * Providers do echo request headers back in some error bodies, and those
 * bodies end up in SQLite and on screen. Matching on the known key shapes
 * (`sk-…`, `Bearer …`) is cheap insurance against writing a live key into a
 * table anyone with the dashboard can read.
 */
function redactSecrets(text) {
    return String(text ?? "")
        .replace(/\b(sk|sk-or-v1|sk-ant)-[A-Za-z0-9._\-]{8,}/g, "[redacted-key]")
        .replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/gi, "Bearer [redacted]");
}
