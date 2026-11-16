import { beforeEach, expect, it, vi } from "vitest";
const records = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../src/projects/storage", () => ({
  readRecord: async (key: string) => records.get(key),
  writeRecord: async (key: string, value: unknown) => {
    records.set(key, value);
  },
  projectArchive: vi.fn(async () => new Blob(["archive-with-assets"])),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));
import {
  chooseDirectory,
  syncProjectDirectory,
  clearDirectory,
  readDirectory,
} from "../src/projects/directory";
import { projectArchive } from "../src/projects/storage";
import type { Project } from "../src/types";
const project = { id: "project-1" } as Project;
beforeEach(() => {
  records.clear();
  vi.clearAllMocks();
});

function setup(permission = "granted") {
  const stream = {
    write: vi.fn(async (_: Blob) => {}),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  const handle = {
    name: "Projects",
    queryPermission: vi.fn(async () => permission),
    requestPermission: vi.fn(async () => permission),
    getFileHandle: vi.fn(async () => ({ createWritable: async () => stream })),
  };
  vi.stubGlobal("window", { showDirectoryPicker: vi.fn(async () => handle) });
  return { stream, handle };
}
it("writes the complete archive to the chosen folder and remembers its handle", async () => {
  const { stream, handle } = setup();
  await chooseDirectory(project.id);
  expect((await readDirectory(project.id))?.label).toBe("Projects");
  await syncProjectDirectory(project, []);
  expect(handle.getFileHandle).toHaveBeenCalledWith(
    "project-project-1.aicanvas",
    { create: true },
  );
  expect(await stream.write.mock.calls[0][0].text()).toBe(
    "archive-with-assets",
  );
  expect(stream.close).toHaveBeenCalledOnce();
  await clearDirectory(project.id);
  expect(await readDirectory(project.id)).toBeNull();
});
it("does not write or prompt during background sync when directory permission expired", async () => {
  const { handle } = setup("prompt");
  await chooseDirectory(project.id);
  await expect(syncProjectDirectory(project, [])).rejects.toThrow("重新授权");
  expect(handle.getFileHandle).not.toHaveBeenCalled();
  expect(handle.requestPermission).not.toHaveBeenCalled();
  expect(projectArchive).not.toHaveBeenCalled();
});
it("aborts an incomplete write and preserves the chosen location for retry", async () => {
  const { stream } = setup();
  await chooseDirectory(project.id);
  stream.write.mockRejectedValueOnce(new Error("disk full"));
  await expect(syncProjectDirectory(project, [])).rejects.toThrow("disk full");
  expect(stream.abort).toHaveBeenCalledOnce();
  expect(stream.close).not.toHaveBeenCalled();
  expect((await readDirectory(project.id))?.label).toBe("Projects");
});
it("rejects path separators in archive filenames", async () => {
  const { handle } = setup();
  await chooseDirectory("../escape");
  await expect(
    syncProjectDirectory({ id: "../escape" } as Project, []),
  ).rejects.toThrow("标识");
  expect(handle.getFileHandle).not.toHaveBeenCalled();
});
