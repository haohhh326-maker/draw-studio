import { describe, expect, it } from "vitest";
import { runningHubKeyFingerprint } from "../src/runninghub/key-fingerprint";

describe("RunningHub local key fingerprint", () => {
  it("returns the first 16 lowercase hex digits of SHA-256 without returning the input", async () => {
    expect(await runningHubKeyFingerprint("abc")).toBe("ba7816bf8f01cfea");
  });

  it("compares trimmed keys consistently while distinguishing different saved credentials", async () => {
    expect(await runningHubKeyFingerprint("  abc\r\n")).toBe(await runningHubKeyFingerprint("abc"));
    expect(await runningHubKeyFingerprint("abc")).not.toBe(await runningHubKeyFingerprint("abcd"));
  });

  it("does not fingerprint a missing or whitespace-only credential", async () => {
    expect(await runningHubKeyFingerprint("")).toBeUndefined();
    expect(await runningHubKeyFingerprint(" \t\n")).toBeUndefined();
  });
});
