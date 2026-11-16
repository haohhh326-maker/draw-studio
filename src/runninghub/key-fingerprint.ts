/** A local comparison aid; neither the key nor its fingerprint is transmitted. */
export async function runningHubKeyFingerprint(token: string): Promise<string | undefined> {
  const normalized = token.trim();
  if (!normalized) return;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].slice(0, 8).map(byte => byte.toString(16).padStart(2, "0")).join("");
}
