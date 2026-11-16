import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, WorkflowDefinition } from "../src/types";

const storage = vi.hoisted(() => ({ records: new Map<string, unknown>(), read: vi.fn(), write: vi.fn() }));
vi.mock("../src/projects/storage", () => ({
  readRecord: storage.read, writeRecord: storage.write, safeConnection: (value: object) => value,
}));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
import { useStore, type ProjectLibrary } from "../src/stores/store";

const initial = structuredClone(useStore.getState().project);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function holdFirstRead() {
  const started = deferred(), release = deferred();
  storage.read.mockImplementationOnce(async (key: string) => {
    started.resolve(); await release.promise;
    return structuredClone(storage.records.get(key));
  });
  return { started, release };
}
function project(name: string): Project { return { ...structuredClone(initial), id: "save-queue-project", name }; }
const projectWrites = () => storage.write.mock.calls.filter(([key]) => key === "project-library");

beforeEach(() => {
  storage.records.clear(); storage.read.mockReset(); storage.write.mockReset();
  storage.read.mockImplementation(async (key: string) => structuredClone(storage.records.get(key)));
  storage.write.mockImplementation(async (key: string, value: unknown) => { storage.records.set(key, structuredClone(value)); });
  useStore.setState({ ready: false, projectOpen: false, navigating: false, project: project("A"), projects: {}, workflows: [], runningHubWorkflows: [], notify: vi.fn() });
});

describe("project save checkpoint coalescing", () => {
  it("shares concurrent identical checkpoints without duplicating full-library writes", async () => {
    const gate = holdFirstRead();
    const first = useStore.getState().save(true), second = useStore.getState().save(), third = useStore.getState().save(true);
    await gate.started.promise;
    expect(storage.read).toHaveBeenCalledOnce();
    gate.release.resolve(); await Promise.all([first, second, third]);
    expect(projectWrites()).toHaveLength(1);
    expect(storage.write.mock.calls.filter(([key]) => key === "workflows")).toHaveLength(1);
  });

  it("preserves different project checkpoints in order", async () => {
    const gate = holdFirstRead();
    const first = useStore.getState().save(true);
    await gate.started.promise;
    useStore.setState({ project: project("B") });
    const second = useStore.getState().save(true), duplicate = useStore.getState().save(true);
    gate.release.resolve(); await Promise.all([first, second, duplicate]);
    expect(projectWrites().map(([,value]) => value["save-queue-project"].project.name)).toEqual(["A", "B"]);
  });

  it.each(["workflows", "runningHubWorkflows"] as const)("keeps a new checkpoint when only %s changes", async field => {
    const gate = holdFirstRead(), first = useStore.getState().save(true);
    await gate.started.promise;
    const changed = [{ id: "new-workflow", name: "New" }] as WorkflowDefinition[];
    useStore.setState({ [field]: changed });
    const second = useStore.getState().save(true);
    gate.release.resolve(); await Promise.all([first, second]);
    expect(projectWrites()).toHaveLength(2);
    expect(projectWrites()[1][1]["save-queue-project"].workflows).toEqual(changed);
  });

  it("does not reuse an older checkpoint across an intervening different snapshot", async () => {
    const a = useStore.getState().project, gate = holdFirstRead(), first = useStore.getState().save(true);
    await gate.started.promise;
    useStore.setState({ project: project("B") }); const second = useStore.getState().save(true);
    useStore.setState({ project: a }); const third = useStore.getState().save(true);
    gate.release.resolve(); await Promise.all([first, second, third]);
    expect(projectWrites().map(([,value]) => value["save-queue-project"].project.name)).toEqual(["A", "B", "A"]);
  });

  it("preserves strict errors for every caller and allows a fresh retry", async () => {
    const gate = holdFirstRead(), error = new Error("storage write failed");
    storage.write.mockRejectedValueOnce(error);
    const first = useStore.getState().save(true), nonStrict = useStore.getState().save(), second = useStore.getState().save(true);
    const outcomes = Promise.allSettled([first, nonStrict, second]);
    await gate.started.promise; gate.release.resolve();
    expect(await outcomes).toEqual([{ status: "rejected", reason: error }, { status: "fulfilled", value: undefined }, { status: "rejected", reason: error }]);
    expect(projectWrites()).toHaveLength(1);
    await useStore.getState().save(true);
    expect(projectWrites()).toHaveLength(2);
  });

  it("rechecks cross-tab library changes after an identical save has completed", async () => {
    await useStore.getState().save(true);
    const library = storage.records.get("project-library") as ProjectLibrary;
    library.external = { project: { ...project("External"), id: "external" }, workflows: [] };
    storage.records.set("project-library", library);
    await useStore.getState().save(true);
    expect(storage.read).toHaveBeenCalledTimes(2);
    expect((storage.records.get("project-library") as ProjectLibrary).external.project.name).toBe("External");
    library["save-queue-project"].deletedAt = 1;
    storage.records.set("project-library", library);
    await expect(useStore.getState().save(true)).rejects.toThrow("已删除");
    expect(projectWrites()).toHaveLength(2);
  });
});
