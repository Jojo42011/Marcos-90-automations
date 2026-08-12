/**
 * Minimal SMTP client — enough of RFC 5321 to send one message reliably.
 *
 * Hand-rolled on Node's built-in `net`/`tls` rather than nodemailer for the
 * reason stated in CLAUDE.md: the fast overlay deploy path cannot run
 * `npm install`, so a new dependency would force a full image rebuild. Same
 * argument that produced the hand-rolled ZIP writer and markdown renderer.
 *
 * Supports both Gmail submission ports:
 *   587 — plain connect, EHLO, STARTTLS, upgrade, EHLO again  (default)
 *   465 — implicit TLS from the first byte
 *
 * Everything is CRLF, every step is timed out, and the socket is destroyed on
 * any failure — a hung submission must never wedge the agent that called it.
 */
import net from "net";
import tls from "tls";

export interface SmtpAuth {
  user: string;
  /** Gmail app password. Spaces are stripped by the caller. */
  pass: string;
}

export interface SmtpServer {
  host: string;
  port: number;
  /** true = implicit TLS (465). false = plain + STARTTLS (587). */
  secure: boolean;
  /** Per-command timeout. */
  timeoutMs?: number;
}

export interface SmtpMessage {
  from: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  /** Rendered as text/html when `html`, else text/plain. */
  body: string;
  html?: boolean;
}

const DEFAULT_TIMEOUT = 20000;

/** A 3-digit reply plus its (possibly multiline) text. */
interface SmtpReply {
  code: number;
  text: string;
}

class SmtpConnection {
  private socket: net.Socket | tls.TLSSocket;
  private buffer = "";
  private pending: {
    resolve: (r: SmtpReply) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private closedError: Error | null = null;

  constructor(socket: net.Socket | tls.TLSSocket, private timeoutMs: number) {
    this.socket = socket;
    this.attach();
  }

  private attach(): void {
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.onData(chunk));
    this.socket.on("error", (err: Error) => this.fail(err));
    this.socket.on("close", () => this.fail(new Error("SMTP connection closed unexpectedly")));
  }

  /** Swap in the TLS socket after STARTTLS without losing the reader. */
  replaceSocket(socket: tls.TLSSocket): void {
    this.socket.removeAllListeners("data");
    this.socket.removeAllListeners("error");
    this.socket.removeAllListeners("close");
    this.socket = socket;
    this.buffer = "";
    this.attach();
  }

  get raw(): net.Socket | tls.TLSSocket {
    return this.socket;
  }

  private fail(err: Error): void {
    this.closedError = err;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(err);
      this.pending = null;
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    /* A reply ends on a line whose 4th character is a space ("250 OK");
       "250-EXTENSION" means more lines follow. */
    const lines = this.buffer.split("\r\n");
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      if (/^\d{3} /.test(line)) {
        const complete = lines.slice(0, i + 1).join("\r\n");
        this.buffer = lines.slice(i + 1).join("\r\n");
        const code = Number(line.slice(0, 3));
        if (this.pending) {
          clearTimeout(this.pending.timer);
          const { resolve } = this.pending;
          this.pending = null;
          resolve({ code, text: complete });
        }
        return;
      }
    }
  }

  /** Wait for the next complete reply. */
  read(): Promise<SmtpReply> {
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`SMTP timed out after ${this.timeoutMs}ms waiting for a reply`));
      }, this.timeoutMs);
      this.pending = { resolve, reject, timer };
    });
  }

  write(line: string): void {
    this.socket.write(line + "\r\n");
  }

  /** Send a command and assert the reply code. */
  async command(line: string, expect: number[], redact = false): Promise<SmtpReply> {
    this.write(line);
    const reply = await this.read();
    if (!expect.includes(reply.code)) {
      const shown = redact ? "<redacted>" : line;
      throw new Error(`SMTP "${shown}" failed: ${reply.text.trim()}`);
    }
    return reply;
  }

  end(): void {
    try {
      this.socket.destroy();
    } catch {
      /* already gone */
    }
  }
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/** RFC 2047 for a non-ASCII subject; plain when it is already ASCII. */
function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${b64(value)}?=`;
}

/** Strip anything that could inject a second header line. */
function sanitizeHeader(value: string): string {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function formatAddress(email: string, name?: string): string {
  const clean = sanitizeHeader(email);
  if (!name) return clean;
  return `${encodeHeaderValue(sanitizeHeader(name))} <${clean}>`;
}

/**
 * Base64 the body at 76 chars per line.
 *
 * Not an aesthetic choice: SMTP caps a line at 998 octets, and an HTML email
 * built by this system is one long line far past that. Base64 sidesteps both
 * the line limit and any 8-bit/UTF-8 transport question in one move, and it
 * makes dot-stuffing impossible to get wrong (no encoded line ever starts
 * with a ".").
 */
function encodeBody(body: string): string {
  const raw = Buffer.from(body, "utf8").toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i += 76) lines.push(raw.slice(i, i + 76));
  return lines.join("\r\n");
}

function messageId(fromDomain: string): string {
  const rand = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `<${rand}@${fromDomain || "localhost"}>`;
}

/** Compose the RFC 5322 message. Exported for tests. */
export function buildMimeMessage(msg: SmtpMessage): string {
  const domain = (msg.from.split("@")[1] || "localhost").trim();
  const headers = [
    `From: ${formatAddress(msg.from, msg.fromName)}`,
    `To: ${msg.to.map((a) => sanitizeHeader(a)).join(", ")}`,
  ];
  if (msg.cc?.length) headers.push(`Cc: ${msg.cc.map((a) => sanitizeHeader(a)).join(", ")}`);
  /* Bcc is deliberately NOT a header — it goes in RCPT TO only, which is what
     makes it blind. Writing it here would show every hidden recipient. */
  if (msg.replyTo) headers.push(`Reply-To: ${sanitizeHeader(msg.replyTo)}`);
  headers.push(
    `Subject: ${encodeHeaderValue(sanitizeHeader(msg.subject))}`,
    `Message-ID: ${messageId(domain)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: ${msg.html ? "text/html" : "text/plain"}; charset=utf-8`,
    "Content-Transfer-Encoding: base64",
  );
  return headers.join("\r\n") + "\r\n\r\n" + encodeBody(msg.body);
}

/**
 * Connect, upgrade, authenticate, disconnect — no MAIL FROM, no message.
 *
 * The only honest way to answer "do these credentials work?" without putting
 * a test email in somebody's inbox. Throws with the server's reply if not.
 */
export async function smtpLoginCheck(server: SmtpServer, auth: SmtpAuth): Promise<void> {
  const timeoutMs = server.timeoutMs ?? DEFAULT_TIMEOUT;
  const socket: net.Socket | tls.TLSSocket = server.secure
    ? tls.connect({ host: server.host, port: server.port, servername: server.host })
    : net.connect({ host: server.host, port: server.port });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SMTP connect to ${server.host}:${server.port} timed out`)), timeoutMs);
    socket.once(server.secure ? "secureConnect" : "connect", () => { clearTimeout(timer); resolve(); });
    socket.once("error", (err) => { clearTimeout(timer); reject(err); });
  });

  const conn = new SmtpConnection(socket, timeoutMs);
  try {
    const greeting = await conn.read();
    if (greeting.code !== 220) throw new Error(`SMTP greeting was ${greeting.text.trim()}`);
    const ehloName = "marco-90-automation";
    await conn.command(`EHLO ${ehloName}`, [250]);
    if (!server.secure) {
      await conn.command("STARTTLS", [220]);
      const upgraded: tls.TLSSocket = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket: conn.raw as net.Socket, servername: server.host }, () => resolve(t));
        t.once("error", reject);
      });
      conn.replaceSocket(upgraded);
      await conn.command(`EHLO ${ehloName}`, [250]);
    }
    await conn.command("AUTH LOGIN", [334]);
    await conn.command(b64(auth.user), [334], true);
    await conn.command(b64(auth.pass), [235], true);
    try {
      await conn.command("QUIT", [221]);
    } catch {
      /* authenticated already — a rude close on QUIT is not a failure */
    }
  } finally {
    conn.end();
  }
}

export interface SmtpSendResult {
  ok: true;
  /** The server's own DATA acceptance line — the receipt that it took it. */
  response: string;
  accepted: string[];
}

/**
 * Deliver one message. Resolves only when the server has ACCEPTED the DATA
 * block; any other outcome throws with the server's own words, because
 * "email sent" must never be reported on a guess.
 */
export async function smtpSend(
  server: SmtpServer,
  auth: SmtpAuth,
  msg: SmtpMessage,
): Promise<SmtpSendResult> {
  const timeoutMs = server.timeoutMs ?? DEFAULT_TIMEOUT;
  const recipients = [...msg.to, ...(msg.cc || []), ...(msg.bcc || [])]
    .map((a) => sanitizeHeader(a))
    .filter(Boolean);
  if (!recipients.length) throw new Error("No recipients");

  const socket: net.Socket | tls.TLSSocket = server.secure
    ? tls.connect({ host: server.host, port: server.port, servername: server.host })
    : net.connect({ host: server.host, port: server.port });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SMTP connect to ${server.host}:${server.port} timed out`)), timeoutMs);
    socket.once(server.secure ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  const conn = new SmtpConnection(socket, timeoutMs);
  try {
    const greeting = await conn.read();
    if (greeting.code !== 220) throw new Error(`SMTP greeting was ${greeting.text.trim()}`);

    const ehloName = "marco-90-automation";
    await conn.command(`EHLO ${ehloName}`, [250]);

    if (!server.secure) {
      await conn.command("STARTTLS", [220]);
      const upgraded: tls.TLSSocket = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket: conn.raw as net.Socket, servername: server.host }, () => resolve(t));
        t.once("error", reject);
      });
      conn.replaceSocket(upgraded);
      /* EHLO again: the extension list before TLS is not trustworthy and the
         server will not offer AUTH until the channel is encrypted. */
      await conn.command(`EHLO ${ehloName}`, [250]);
    }

    await conn.command("AUTH LOGIN", [334]);
    await conn.command(b64(auth.user), [334], true);
    /* 535 here is the app password being wrong/revoked, or 2-Step Verification
       not enabled on the account — which is what makes app passwords possible
       in the first place. */
    await conn.command(b64(auth.pass), [235], true);

    await conn.command(`MAIL FROM:<${sanitizeHeader(msg.from)}>`, [250]);
    const accepted: string[] = [];
    for (const rcpt of recipients) {
      const reply = await conn.command(`RCPT TO:<${rcpt}>`, [250, 251]);
      if (reply.code === 250 || reply.code === 251) accepted.push(rcpt);
    }

    await conn.command("DATA", [354]);
    conn.raw.write(buildMimeMessage(msg) + "\r\n.\r\n");
    const done = await conn.read();
    if (done.code !== 250) throw new Error(`SMTP refused the message: ${done.text.trim()}`);

    try {
      await conn.command("QUIT", [221]);
    } catch {
      /* The message is already accepted; a rude close on QUIT is not a failure. */
    }
    return { ok: true, response: done.text.trim(), accepted };
  } finally {
    conn.end();
  }
}
