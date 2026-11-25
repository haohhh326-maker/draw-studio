import { computeEndpoint } from "../compute/providers";

export function sameAutoDLEndpoint(left: string, right: string): boolean {
  try { return computeEndpoint(new URL(left.trim()).href) === computeEndpoint(new URL(right.trim()).href); }
  catch { return false; }
}

/** The official ComfyUI gateway embeds its application instance ID in the hostname. */
export function autoDLInstanceUuidFromEndpoint(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname.endsWith(".seetacloud.com")) return;
    const match = /^u\d+-([a-f0-9]+)\./.exec(url.hostname);
    if (match) return "pro-" + match[1];
  } catch { /* An invalid address is handled by the connection settings. */ }
}
