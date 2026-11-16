import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";

const db = vi.hoisted(() => {
  const records = new Map<string, unknown>();
  return {
    records,
    put: vi.fn(async (_store: string, value: unknown, key: string) => {
      records.set(key, structuredClone(value));
    }),
  };
});
vi.mock("idb", () => ({
  openDB: async () => ({
    get: async (_store: string, key: string) => structuredClone(db.records.get(key)),
    put: db.put,
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
vi.mock("../src/workflow/library-client", () => ({
  readWorkflowLibrary: async () => { throw new Error("Template directory unavailable"); },
}));

import { useStore } from "../src/stores/store";
import { projectArchive, readRecord } from "../src/projects/storage";
import type { Connection } from "../src/types";

const initialConnection = { ...useStore.getState().connection };
const configuredConnection: Connection = {
  ...initialConnection,
  name: "Test cloud",
  baseUrl: "https://example.test",
  token: "test-only-optimizer-credential",
  authHeader: "X-Optimizer-Token",
  authPrefix: "",
};

beforeEach(() => {
  useStore.setState({ ready: false, projectOpen: false, connection: initialConnection });
  db.records.clear();
  db.put.mockReset();
  db.put.mockImplementation(async (_store, value, key) => {
    db.records.set(key, structuredClone(value));
  });
  vi.stubGlobal("sessionStorage", { getItem: () => null });
});

afterEach(() => {
  useStore.setState({ ready: false, projectOpen: false });
  vi.unstubAllGlobals();
});

async function expectStored(connection: Connection) {
  await vi.waitFor(async () => expect(await readRecord("connection")).toEqual(connection));
}

describe("shared connection persistence", () => {
  it("saves authentication without an open project and restores it on startup", async () => {
    useStore.setState({ ready: true, connection: configuredConnection });
    await expectStored(configuredConnection);
    useStore.setState({ ready: false, connection: initialConnection });
    await useStore.getState().hydrate();
    expect(useStore.getState().connection).toEqual(configuredConnection);
    expect(useStore.getState().projectOpen).toBe(false);
  });

  it("persists the latest edit and an intentional credential removal in order", async () => {
    useStore.setState({ ready: true, connection: configuredConnection });
    useStore.setState({ connection: { ...configuredConnection, token: "second-test-credential" } });
    const cleared = { ...configuredConnection, token: "" };
    useStore.setState({ connection: cleared });
    await expectStored(cleared);
    useStore.setState({ ready: false, connection: initialConnection });
    await useStore.getState().hydrate();
    expect(useStore.getState().connection.token).toBe("");
  });

  it("does not let a delayed project save overwrite newer authentication", async () => {
    useStore.setState({ ready: true, connection: configuredConnection });
    await expectStored(configuredConnection);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    db.put.mockImplementation(async (_store, value, key) => {
      if (key === "project-library") await blocked;
      db.records.set(key, structuredClone(value));
    });
    const projectSave = useStore.getState().save(true);
    const updated = { ...configuredConnection, token: "newer-test-credential" };
    useStore.setState({ connection: updated });
    await expectStored(updated);
    release();
    await projectSave;
    await expectStored(updated);
  });

  it("reports a failed write without exposing the credential and allows retry", async () => {
    db.put.mockRejectedValueOnce(new Error(configuredConnection.token));
    const notify = vi.spyOn(useStore.getState(), "notify").mockImplementation(() => {});
    useStore.setState({ ready: true, connection: configuredConnection });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining("连接认证保存失败")));
    expect(JSON.stringify(notify.mock.calls)).not.toContain(configuredConnection.token);
    useStore.setState({ connection: { ...configuredConnection } });
    await expectStored(configuredConnection);
    notify.mockRestore();
  });

  it("restores legacy records without requiring an authentication token", async () => {
    const { token: _token, ...legacy } = configuredConnection;
    db.records.set("connection", legacy);
    await useStore.getState().hydrate();
    expect(useStore.getState().connection).toEqual({ ...legacy, token: "" });
  });

  it("excludes saved authentication from exported project archives", async () => {
    useStore.setState({ ready: true, connection: configuredConnection });
    await expectStored(configuredConnection);
    const archive = await projectArchive({ ...useStore.getState().project, assets: {} }, []);
    const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["project.json", "workflows.json"]);
    expect(Object.values(files).map(file => strFromU8(file)).join("\n")).not.toContain(configuredConnection.token);
  });
});
