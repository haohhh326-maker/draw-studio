import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset, Project } from "../src/types";
const fake = vi.hoisted(() => ({
  state: {} as any,
  blobs: new Map<string, Blob>(),
  read: vi.fn(),
  write: vi.fn(),
}));
vi.mock("../src/projects/storage", () => ({
  getBlob: (...args: unknown[]) => fake.read(...args),
  putBlob: (...args: unknown[]) => fake.write(...args),
}));
vi.mock("../src/stores/store", () => ({
  useStore: { getState: () => fake.state },
}));
import {
  acquireDirectorMediaBridge,
  directorProjectMediaMap,
  type SharedDirectorMediaBridge,
} from "../src/director/shared-media-bridge";
import { directorAssetPath } from "../src/director/media-bridge";

const asset: Asset = {
  id: "photo",
  name: "photo.png",
  mime: "image/png",
  kind: "image",
  size: 3,
  createdAt: 1,
};
const leases: SharedDirectorMediaBridge[] = [];
const acquire = (id = "project") => {
  const lease = acquireDirectorMediaBridge(id);
  leases.push(lease);
  return lease;
};
const view = (item: Asset) =>
  `/view?filename=${encodeURIComponent(item.name)}&subfolder=canvas/${item.id}`;
function project(id = "project") {
  return {
    id,
    assets: { photo: { ...asset } },
    canvases: [
      {
        id: "canvas",
        nodes: [
          {
            id: "director-a",
            data: {
              kind: "director",
              director: {
                media: { "legacy/photo.png": "photo" },
                snapshot: { prompt: "PRIVATE PROMPT A" },
              },
            },
          },
          {
            id: "director-b",
            data: {
              kind: "director",
              director: { media: {}, snapshot: { prompt: "PRIVATE PROMPT B" } },
            },
          },
        ],
        edges: [],
      },
    ],
  } as unknown as Project;
}
beforeEach(() => {
  fake.blobs.clear();
  fake.blobs.set(asset.id, new Blob(["img"], { type: asset.mime }));
  fake.read.mockReset().mockImplementation(async (id: string) => {
    const blob = fake.blobs.get(id);
    if (!blob) throw new Error("missing");
    return blob;
  });
  fake.write.mockReset().mockImplementation(async (id: string, blob: Blob) => {
    fake.blobs.set(id, blob);
  });
  fake.state = {
    project: project(),
    editProject(fn: (project: Project) => Project) {
      this.project = fn(this.project);
    },
  };
});
afterEach(() => {
  leases.splice(0).forEach((lease) => lease.release());
  vi.restoreAllMocks();
});

describe("project-shared director media", () => {
  it("deduplicates concurrent blob reads and retains URLs until the last host releases", async () => {
    let finish!: (blob: Blob) => void;
    fake.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const create = vi
        .spyOn(URL, "createObjectURL")
        .mockReturnValue("blob:shared-photo"),
      revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const first = acquire(),
      second = acquire();
    expect(first.fetchApi).toBe(second.fetchApi);
    expect(first.apiURL).toBe(second.apiURL);
    const a = first.prepare(),
      b = second.prepare();
    expect(fake.read).toHaveBeenCalledTimes(1);
    first.release();
    expect(revoke).not.toHaveBeenCalled();
    finish(new Blob(["img"], { type: "image/png" }));
    await Promise.all([a, b]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(second.apiURL(view(asset))).toBe("blob:shared-photo");
    second.release();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:shared-photo");
    second.release();
    first.release();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(second.apiURL(view(asset))).toBe("data:,");
  });
  it("shares an uploaded asset across hosts without mutating any host snapshot or media table", async () => {
    const first = acquire(),
      second = acquire();
    await Promise.all([first.prepare(), second.prepare()]);
    const beforeNodes = JSON.stringify(fake.state.project.canvases[0].nodes);
    const form = new FormData();
    form.append(
      "image",
      new Blob(["new-image"], { type: "image/png" }),
      "another.png",
    );
    const response = await first.fetchApi("/upload/image", {
      method: "POST",
      body: form,
    });
    expect(response.ok).toBe(true);
    const uploaded = await response.json(),
      path = `${uploaded.subfolder}/${uploaded.name}`;
    const id = second.getMediaMap()[path];
    expect(id).toBeTruthy();
    expect(fake.state.project.assets[id].name).toBe("another.png");
    expect(
      second.apiURL(
        `/view?filename=another.png&subfolder=${uploaded.subfolder}`,
      ),
    ).toMatch(/^blob:/);
    first.release();
    const listed = await (
      await second.fetchApi("/minimax/director/list_input_media?kind=image")
    ).json();
    expect(listed.items.some((item: any) => item.relPath === path)).toBe(true);
    expect(fake.write).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fake.state.project.canvases[0].nodes)).toBe(
      beforeNodes,
    );
    expect(JSON.stringify(second.getMediaMap())).not.toContain(
      "PRIVATE PROMPT",
    );
  });
  it("reflects current project assets and media aliases from every node, rejecting ambiguous stale aliases", () => {
    const current = project(),
      other: Asset = { ...asset, id: "other", name: "other.png" };
    current.assets.other = other;
    current.canvases[0].nodes[1].data.director = {
      media: {
        "legacy/other.png": "other",
        "legacy/photo.png": "other",
        "missing.png": "gone",
      },
    };
    const map = directorProjectMediaMap(current);
    expect(map[directorAssetPath(asset)]).toBe("photo");
    expect(map[directorAssetPath(other)]).toBe("other");
    expect(map["legacy/other.png"]).toBe("other");
    expect(map["legacy/photo.png"]).toBeUndefined();
    expect(map["missing.png"]).toBeUndefined();
    const lease = acquire();
    fake.state.project = current;
    expect(lease.getMediaMap()["legacy/other.png"]).toBe("other");
    delete current.assets.other;
    expect(lease.getMediaMap()["legacy/other.png"]).toBeUndefined();
  });
  it("does not read or import media into a different project and recreates transport after final release", async () => {
    const first = acquire();
    await first.prepare();
    const oldFetch = first.fetchApi;
    fake.state.project = project("different-project");
    expect(() => first.getMediaMap()).toThrow("项目已切换");
    expect(first.apiURL(view(asset))).toBe("data:,");
    const form = new FormData();
    form.append(
      "image",
      new Blob(["x"], { type: "image/png" }),
      "not-imported.png",
    );
    await expect(
      first.fetchApi("/upload/image", { method: "POST", body: form }),
    ).rejects.toThrow("项目已切换");
    expect(fake.write).not.toHaveBeenCalled();
    const other = acquire("different-project");
    await other.prepare();
    expect(other.fetchApi).not.toBe(oldFetch);
    first.release();
    expect(other.apiURL(view(asset))).toMatch(/^blob:/);
    other.release();
    const reopened = acquire("different-project");
    expect(reopened.fetchApi).not.toBe(other.fetchApi);
    await reopened.prepare();
    expect(reopened.apiURL(view(asset))).toMatch(/^blob:/);
  });
});

describe("shared bridge disposal during loading", () => {
  it("does not create an object URL when the final host releases before the blob finishes reading", async () => {
    let finish!: (blob: Blob) => void;
    fake.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const create = vi.spyOn(URL, "createObjectURL");
    const lease = acquire(),
      pending = lease.prepare();
    lease.release();
    finish(new Blob(["img"], { type: "image/png" }));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(create).not.toHaveBeenCalled();
  });
});
