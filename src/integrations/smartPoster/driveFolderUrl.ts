/** Only a Google Drive folder link is accepted. Never follow an arbitrary URL. */
export function driveFolderIdFromUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "drive.google.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  let id: string | null = null;
  const folderIndex = parts.indexOf("folders");
  if (folderIndex >= 0 && parts[0] === "drive") id = parts[folderIndex + 1] || null;
  if (parts.length === 1 && parts[0] === "open") id = url.searchParams.get("id");
  return id && /^[A-Za-z0-9_-]{10,200}$/.test(id) ? id : null;
}

export function isDriveVideo(name: string, mimeType: string): boolean {
  if (mimeType.startsWith("video/")) return true;
  if (
    mimeType.startsWith("application/vnd.google-apps.") ||
    mimeType.startsWith("application/pdf") ||
    mimeType.startsWith("text/") ||
    mimeType.startsWith("application/vnd.openxmlformats-officedocument") ||
    mimeType === "application/msword"
  ) {
    return false;
  }
  return /\.(mp4|mov|m4v|webm|avi|mpeg|mpg)$/i.test(name);
}
