import { describe, expect, it } from "vitest";
import { checkedOutput, outputKey } from "../src/comfyui/files";

describe("result provenance and recovery identity", () => {
  const file = { filename: "result.png", subfolder: "task", type: "output" as const, url: "https://cdn.example/result.png" };
  it("retains provenance and valid dimensions without redownloading the same result", () => {
    const detailed = { ...file, sourceNodeId: "42", sourceField: "images", width: 4096, height: 2048 };
    expect(checkedOutput(detailed)).toEqual(detailed);
    expect(outputKey(detailed)).toBe(outputKey(file));
    expect(outputKey({ ...detailed, sourceNodeId: "43", width: 8192 })).toBe(outputKey(file));
  });
  it("rejects unsafe file locations and drops invalid dimension hints", () => {
    expect(() => checkedOutput({ ...file, filename: "../private.png" })).toThrow();
    expect(() => checkedOutput({ ...file, type: "input" })).toThrow();
    expect(checkedOutput({ ...file, width: Infinity, height: -2, sourceNodeId: "" })).toEqual(file);
    expect(outputKey({ ...file, subfolder: "other" })).not.toBe(outputKey(file));
  });
});
