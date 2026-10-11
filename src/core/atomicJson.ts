import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Publish a complete file in the same filesystem. Failures before rename leave the original intact. */
export function atomicJson(path: string, value: unknown): void {
  const text = JSON.stringify(value);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.pending`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    // Directory fsync makes the rename durable on filesystems which support it.
    // Publication has already happened: a platform-specific sync error must not roll memory back.
    let directory: number | undefined;
    try { directory=openSync(dirname(path),"r"); fsyncSync(directory); }
    catch(error) { if(!["EINVAL","ENOTSUP","EISDIR","EPERM"].includes((error as NodeJS.ErrnoException).code || ""))console.error("[storage] directory sync failed",error); }
    finally { if(directory!==undefined)closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[storage] temporary cleanup failed", error); }
  }
}
