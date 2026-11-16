import { describe, expect, it } from "vitest";
import { filterMuseSessionExport, validateMuseSessionImport } from "../scripts/muse-browser-service";
import { filterDeepSeekSessionExport, validateDeepSeekSessionImport } from "../scripts/deepseek-browser-service";

const cookie = (domain: string) => ({
  name: "session", value: "secret", domain, path: "/", httpOnly: true, secure: true, sameSite: "Lax" as const,
});

describe("native service auth import", () => {
  it("accepts only Muse session data from Muse", () => {
    const valid = { cookies: [cookie(".muse.ai")], origins: [{ origin: "https://muse.ai", localStorage: [{ name: "auth", value: "value" }] }] };
    expect(validateMuseSessionImport(valid)).toEqual(valid);
    expect(() => validateMuseSessionImport({ ...valid, cookies: [cookie(".deepseek.com")] })).toThrow();
    expect(() => validateMuseSessionImport({ ...valid, origins: [{ origin: "https://evil.example", localStorage: [] }] })).toThrow();
  });

  it("accepts only DeepSeek session data from DeepSeek", () => {
    const valid = { cookies: [cookie(".deepseek.com")], origins: [{ origin: "https://chat.deepseek.com", localStorage: [{ name: "auth", value: "value" }] }] };
    expect(validateDeepSeekSessionImport(valid)).toEqual(valid);
    expect(() => validateDeepSeekSessionImport({ ...valid, cookies: [cookie(".muse.ai")] })).toThrow();
    expect(() => validateDeepSeekSessionImport({ ...valid, origins: [{ origin: "https://muse.ai", localStorage: [] }] })).toThrow();
  });

  it("rejects oversized credentials and malformed cookie paths", () => {
    expect(() => validateMuseSessionImport({ cookies: [{ ...cookie("muse.ai"), value: "x".repeat(8193) }], origins: [] })).toThrow();
    expect(() => validateDeepSeekSessionImport({ cookies: [{ ...cookie("deepseek.com"), path: "other" }], origins: [] })).toThrow();
  });

  it("exports only each service's own cookies and localStorage", () => {
    const state = {
      cookies: [cookie(".muse.ai"), cookie(".deepseek.com"), cookie(".evil.example")],
      origins: [
        { origin: "https://muse.ai", localStorage: [{ name: "muse", value: "muse-private" }] },
        { origin: "https://chat.deepseek.com", localStorage: [{ name: "deepseek", value: "deepseek-private" }] },
        { origin: "https://evil.example", localStorage: [{ name: "evil", value: "evil-private" }] },
      ],
    };
    expect(filterMuseSessionExport(state as never)).toEqual({
      cookies: [cookie(".muse.ai")], origins: [state.origins[0]],
    });
    expect(filterDeepSeekSessionExport(state as never)).toEqual({
      cookies: [cookie(".deepseek.com")], origins: [state.origins[1]],
    });
  });
});
