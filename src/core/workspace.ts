import { existsSync, mkdirSync, promises as fs } from "fs";
import { dirname, join, normalize, relative, resolve, sep } from "path";

/**
 * Harvey's file workspace.
 *
 * Harvey could read the whole business but could not produce anything durable —
 * no listing sheet, no CMA draft, no exported report. This is that surface: a
 * plain directory Harvey can create, read, edit and list files in.
 *
 * SECURITY: every path is resolved and then checked to be inside the workspace
 * root before any I/O happens. Harvey composes these paths from model output, so
 * "../../etc/passwd", an absolute path, or a symlink escape must all be refused
 * — not sanitised into something that silently works. Writes are size-capped and
 * the extension allow-list keeps this to documents, not executables.
 */

function resolveWorkspaceRoot(): string {
  const explicit = process.env.HARVEY_WORKSPACE_PATH?.trim();
  if (explicit) return resolve(explicit);
  const flyDir = "/data";
  if (existsSync(flyDir)) return join(flyDir, "workspace");
  return join(process.cwd(), "data", "workspace");
}

export const WORKSPACE_ROOT = resolveWorkspaceRoot();

const MAX_FILE_BYTES = 2 * 1024 * 1024;      // 2 MB per file
const MAX_FILES = 2000;
/** Documents and data, not code that something else might execute. */
const ALLOWED_EXT = new Set([
  ".md", ".txt", ".csv", ".json", ".html", ".htm", ".yaml", ".yml",
  ".log", ".tsv", ".xml", ".sql", ".ics", "",
]);

export class WorkspaceError extends Error {}

function ensureRoot(): void {
  mkdirSync(WORKSPACE_ROOT, { recursive: true });
}

/**
 * Turn a caller-supplied path into an absolute path proven to sit inside the
 * workspace. Throws rather than coercing — a rejected path is a bug worth
 * surfacing to the model, not something to quietly rewrite.
 */
export function safePath(input: unknown): string {
  const raw = String(input ?? "").trim();
  if (!raw) throw new WorkspaceError("path is required");
  if (raw.includes("\0")) throw new WorkspaceError("path contains a null byte");

  // Reject absolute paths and drive letters outright; everything is relative.
  if (raw.startsWith("/") || raw.startsWith("\\") || /^[a-zA-Z]:/.test(raw)) {
    throw new WorkspaceError("path must be relative to the workspace");
  }

  const full = resolve(WORKSPACE_ROOT, normalize(raw));
  const rel = relative(WORKSPACE_ROOT, full);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep) || resolve(rel) === rel) {
    throw new WorkspaceError("path escapes the workspace");
  }

  const dot = rel.lastIndexOf(".");
  const ext = dot > rel.lastIndexOf(sep) ? rel.slice(dot).toLowerCase() : "";
  if (!ALLOWED_EXT.has(ext)) {
    throw new WorkspaceError(
      `'${ext || "(no extension)"}' is not an allowed file type. Allowed: ${[...ALLOWED_EXT].filter(Boolean).join(", ")}`,
    );
  }
  return full;
}

export interface WorkspaceFile {
  path: string;
  bytes: number;
  updatedAt: string;
}

async function walk(dir: string, out: WorkspaceFile[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const full = join(dir, e.name);
    // Never follow a symlink out of the workspace.
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      await walk(full, out);
    } else if (e.isFile()) {
      const st = await fs.stat(full);
      out.push({
        path: relative(WORKSPACE_ROOT, full).split(sep).join("/"),
        bytes: st.size,
        updatedAt: st.mtime.toISOString(),
      });
    }
  }
}

export async function listFiles(prefix?: string): Promise<WorkspaceFile[]> {
  ensureRoot();
  const files: WorkspaceFile[] = [];
  await walk(WORKSPACE_ROOT, files);
  const p = String(prefix ?? "").trim().replace(/^\/+/, "");
  const filtered = p ? files.filter((f) => f.path.startsWith(p)) : files;
  return filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readFile(path: string): Promise<{ path: string; content: string; bytes: number }> {
  const full = safePath(path);
  ensureRoot();
  let st;
  try {
    st = await fs.stat(full);
  } catch {
    throw new WorkspaceError(`No such file: ${path}`);
  }
  if (!st.isFile()) throw new WorkspaceError(`${path} is not a file`);
  if (st.size > MAX_FILE_BYTES) throw new WorkspaceError(`${path} is too large to read (${st.size} bytes)`);
  const content = await fs.readFile(full, "utf8");
  return { path: String(path), content, bytes: st.size };
}

export async function writeFile(
  path: string,
  content: string,
  opts: { append?: boolean } = {},
): Promise<WorkspaceFile> {
  const full = safePath(path);
  const body = String(content ?? "");
  if (Buffer.byteLength(body, "utf8") > MAX_FILE_BYTES) {
    throw new WorkspaceError(`Content exceeds the ${MAX_FILE_BYTES} byte limit`);
  }
  ensureRoot();
  mkdirSync(dirname(full), { recursive: true });
  if (opts.append) await fs.appendFile(full, body, "utf8");
  else await fs.writeFile(full, body, "utf8");
  const st = await fs.stat(full);
  return {
    path: relative(WORKSPACE_ROOT, full).split(sep).join("/"),
    bytes: st.size,
    updatedAt: st.mtime.toISOString(),
  };
}

/**
 * Replace an exact substring. Refuses when the target is missing or ambiguous,
 * so a partial match can never silently rewrite the wrong line.
 */
export async function editFile(
  path: string,
  find: string,
  replace: string,
  replaceAll = false,
): Promise<{ path: string; replacements: number; bytes: number }> {
  const full = safePath(path);
  if (!find) throw new WorkspaceError("find text is required");
  const { content } = await readFile(path);

  const occurrences = content.split(find).length - 1;
  if (occurrences === 0) throw new WorkspaceError(`Text not found in ${path}`);
  if (occurrences > 1 && !replaceAll) {
    throw new WorkspaceError(
      `Found ${occurrences} matches in ${path}. Pass replaceAll, or use a longer, unique snippet.`,
    );
  }

  const next = replaceAll ? content.split(find).join(replace) : content.replace(find, replace);
  if (Buffer.byteLength(next, "utf8") > MAX_FILE_BYTES) {
    throw new WorkspaceError(`Result exceeds the ${MAX_FILE_BYTES} byte limit`);
  }
  await fs.writeFile(full, next, "utf8");
  const st = await fs.stat(full);
  return { path: String(path), replacements: replaceAll ? occurrences : 1, bytes: st.size };
}

export async function deleteFile(path: string): Promise<boolean> {
  const full = safePath(path);
  try {
    await fs.unlink(full);
    return true;
  } catch {
    return false;
  }
}
