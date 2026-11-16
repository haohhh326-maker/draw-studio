import type { RemoteFile } from "../types";

/** Result order and expiring CDN query parameters are not asset identity. */
export function directorOutputKey(file: RemoteFile): string {
  return JSON.stringify([
    file.filename,
    file.subfolder ?? "",
    file.type ?? "output",
    file.url ? new URL(file.url).pathname : "",
  ]);
}

/** Read receipts written before order-independent output identities were introduced. */
export function normalizeDirectorOutputKey(key: string): string {
  try {
    const value: unknown = JSON.parse(key);
    if (
      Array.isArray(value) &&
      value.length === 5 &&
      typeof value[0] === "number"
    )
      return JSON.stringify(value.slice(1));
  } catch {
    /* Unknown identities retain their original value. */
  }
  return key;
}
