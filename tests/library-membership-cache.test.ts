import { describe, expect, it } from "vitest";
import { generatedAssetIds, isAssetInLibrary } from "../src/assets/library-membership";
import type { Asset, GenerationTask, Project } from "../src/types";

const asset: Asset = { id: "result", name: "result.png", kind: "image", mime: "image/png", size: 1, createdAt: 1 };
describe("canvas membership lookup cost", () => {
  it.each([true, false])("does not read history for explicit membership %s", inLibrary => {
    const project = {
      get history() { throw new Error("Unnecessary history scan"); },
      get tasks() { throw new Error("Unnecessary task scan"); },
    } as Pick<Project, "history" | "tasks">;
    expect(isAssetInLibrary({ ...asset, inLibrary }, project)).toBe(inLibrary);
  });

  it("shares one legacy history scan across node subscriptions and invalidates on new results", () => {
    let scans = 0;
    const history = [{ get outputs() { scans++; return ["result"]; } }] as Project["history"];
    const project = { history, tasks: {} };
    for (let n = 0; n < 100; n++) expect(isAssetInLibrary(asset, project)).toBe(false);
    expect(scans).toBe(1);
    const next = { ...project, tasks: { done: { outputs: ["new-result"] } as GenerationTask } };
    expect(generatedAssetIds(next).has("new-result")).toBe(true);
    expect(scans).toBe(2);
    const edited = { ...next, history: [] };
    expect(isAssetInLibrary(asset, edited)).toBe(true);
    expect(isAssetInLibrary({ ...asset, id: "new-result" }, edited)).toBe(false);
  });
});
