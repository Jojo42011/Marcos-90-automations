import { randomUUID } from "crypto";
import WebSocket from "ws";

const MARCO_E164 = process.env.HARVEY_OWNER_NUMBER?.trim() || "+19804430453";

const CONTACT_ALIASES: Record<string, string> = {
  jahan: "+17373461943",
  marco: MARCO_E164,
};

function normalizeE164(input: string): string {
  const raw = input.trim().replace(/[^\d+]/g, "");
  if (!raw) return "";
  if (raw.startsWith("+")) return raw;
  if (raw.length === 10) return `+1${raw}`;
  if (raw.length === 11 && raw.startsWith("1")) return `+${raw}`;
  return `+${raw}`;
}

function allowedTargets(): Set<string> {
  const fromEnv = process.env.WHATSAPP_ALLOWED_TARGETS?.trim();
  const list = fromEnv ? fromEnv.split(/[,;\s]+/) : ["+17373461943"];
  return new Set(list.map(normalizeE164).filter(Boolean));
}

export function resolveWhatsAppTarget(input: string): string | null {
  const trimmed = input.trim();
  const alias = CONTACT_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  const norm = normalizeE164(trimmed);
  if (!norm) return null;
  return allowedTargets().has(norm) ? norm : null;
}

export function getHarveyOwnerNumber(): string {
  return normalizeE164(MARCO_E164);
}

type GatewayFrame = {
  id?: number;
  ok?: boolean;
  error?: { message?: string };
  event?: string;
};

export async function sendWhatsAppViaGateway(
  to: string,
  message: string,
): Promise<{ ok: boolean; error?: string; to?: string }> {
  const target = resolveWhatsAppTarget(to);
  if (!target) {
    return { ok: false, error: `Target not allowed: ${to}` };
  }

  const text = message.trim();
  if (!text) return { ok: false, error: "message required" };

  const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (!token) return { ok: false, error: "OPENCLAW_GATEWAY_TOKEN not configured" };

  const base =
    process.env.OPENCLAW_GATEWAY_URL?.trim() || "https://harvey-claw.fly.dev";
  const wsUrl = `${base.replace(/^http/, "ws").replace(/\/$/, "")}/`;

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 15000 });
    const timeout = setTimeout(() => {
      ws.close();
      resolve({ ok: false, error: "OpenClaw gateway timeout" });
    }, 25000);

    const finish = (result: { ok: boolean; error?: string; to?: string }) => {
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    ws.on("error", (err) => finish({ ok: false, error: err.message }));

    ws.on("message", (data) => {
      let frame: GatewayFrame;
      try {
        frame = JSON.parse(data.toString()) as GatewayFrame;
      } catch {
        return;
      }
      if (frame.event) return;

      if (frame.id === 1) {
        if (!frame.ok) {
          finish({ ok: false, error: frame.error?.message || "gateway auth failed" });
          return;
        }
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "send",
            params: {
              to: target,
              message: text,
              channel: "whatsapp",
              idempotencyKey: randomUUID(),
            },
          }),
        );
        return;
      }

      if (frame.id === 2) {
        if (frame.ok) finish({ ok: true, to: target });
        else finish({ ok: false, error: frame.error?.message || "whatsapp send failed" });
      }
    });

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "connect",
          params: {
            role: "control",
            auth: { token },
            client: {
              name: "marco-harvey-brain",
              version: "1.0.0",
              platform: "node",
            },
          },
        }),
      );
    });
  });
}
