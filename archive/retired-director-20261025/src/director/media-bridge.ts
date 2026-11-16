import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { getBlob, putBlob } from "../projects/storage";
import type { Asset, MediaKind } from "../types";

type Obj = Record<string, any>;
export type DirectorMediaBridgeOptions = {
  getAssets(): Record<string, Asset>;
  addAsset(asset: Asset): void;
  getMediaMap(): Record<string, string>;
  setMediaMap(map: Record<string, string>): void;
};

/** Strip session-only prompt drafts, including nested serialized timeline workspaces. */
export function stripDirectorPrompts<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripDirectorPrompts) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:global|negative)?prompt$/i.test(key.replace(/[_-]/g, ""))
          ? ""
          : stripDirectorPrompts(item),
      ]),
    ) as T;
  if (typeof value === "string" && /^\s*[\[{]/.test(value)) {
    try {
      return JSON.stringify(stripDirectorPrompts(JSON.parse(value))) as T;
    } catch {
      /* Ordinary text. */
    }
  }
  return value;
}
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  avif: "image/avif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  m4v: "video/mp4",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wma: "audio/x-ms-wma",
};
const MEDIA_FIELDS = new Set([
  "imageFile",
  "image_file",
  "audioFile",
  "audio_file",
  "videoFile",
  "video_file",
  "previewImageFile",
  "preview_image_file",
  "pairedAudioFile",
  "paired_audio_file",
]);
const object = (value: unknown): value is Obj =>
  !!value && typeof value === "object" && !Array.isArray(value);
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
const safeName = (name: string) =>
  name
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\x00-\x1f<>:"|?*]/g, "_")
    .slice(0, 180) || "media";
export const directorAssetPath = (asset: Asset) =>
  `canvas/${asset.id}/${safeName(asset.name)}`;
const assetPath = directorAssetPath;
function mediaPath(name: unknown, subfolder: unknown = "") {
  const raw = String(name || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, ""),
    sub = String(subfolder || "")
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "");
  return raw.includes("/") || !sub ? raw : `${sub}/${raw}`;
}
/** Only media paths are rewritten; independent controls remain untouched. */
export function rewriteDirectorMediaPaths(
  value: unknown,
  resolve: (path: string) => string | undefined,
  missing: string[] = [],
): any {
  if (Array.isArray(value))
    return value.map((item) =>
      rewriteDirectorMediaPaths(item, resolve, missing),
    );
  if (!object(value)) {
    if (typeof value === "string" && /^\s*[\[{]/.test(value)) {
      try {
        return JSON.stringify(
          rewriteDirectorMediaPaths(JSON.parse(value), resolve, missing),
        );
      } catch {
        /* Not JSON. */
      }
    }
    return value;
  }
  const copy: Obj = {};
  for (const [key, item] of Object.entries(value)) {
    if (MEDIA_FIELDS.has(key) && typeof item === "string" && item) {
      const path = mediaPath(item, value.subfolder),
        target = resolve(path);
      copy[key] = target || "";
      if (target) {
        copy.type = "input";
        copy.subfolder = target.slice(0, target.lastIndexOf("/"));
        copy.fileName = target.slice(target.lastIndexOf("/") + 1);
      } else missing.push(path);
    } else if (key === "imageB64" || key === "previewB64") copy[key] = "";
    else if (!["subfolder", "fileName", "type"].includes(key))
      copy[key] = rewriteDirectorMediaPaths(item, resolve, missing);
  }
  for (const key of ["subfolder", "fileName", "type"])
    if (!(key in copy) && key in value) copy[key] = value[key];
  return copy;
}
function unpack(bytes: Uint8Array) {
  let count = 0,
    total = 0;
  return unzipSync(bytes, {
    filter(info) {
      const name = info.name.replace(/\\/g, "/");
      if (
        ++count > 8000 ||
        name.startsWith("/") ||
        /^[a-z]:/i.test(name) ||
        name.split("/").includes("..")
      )
        throw new Error("导演包含无效文件路径。");
      total += info.originalSize;
      if (info.originalSize > 1024 ** 3 || total > 2 * 1024 ** 3)
        throw new Error("导演包解压后的素材过大，请拆分导入。");
      return !name.endsWith("/") && !name.startsWith("__MACOSX/");
    },
  });
}
export function createDirectorMediaBridge(options: DirectorMediaBridgeOptions) {
  const urls = new Map<string, string>(),
    preparing = new Map<string, Promise<void>>(),
    localAssets = new Map<string, Asset>();
  const uploads = new Map<
      string,
      { name: string; total: number; parts: Map<number, Blob> }
    >(),
    packs = new Map<string, Blob>();
  const lifetime = new AbortController();
  let disposed = false;
  const assets = () => ({
    ...options.getAssets(),
    ...Object.fromEntries(localAssets),
  });
  const active = () => {
    if (disposed) throw new DOMException("导演台已关闭。", "AbortError");
  };
  function mapAsset(asset: Asset) {
    const path = assetPath(asset),
      map = options.getMediaMap();
    if (map[path] !== asset.id)
      options.setMediaMap({ ...map, [path]: asset.id });
    return path;
  }
  function prepareAsset(asset: Asset): Promise<void> {
    if (urls.has(asset.id)) return Promise.resolve();
    const pending = preparing.get(asset.id);
    if (pending) return pending;
    const task = getBlob(asset.id, asset.mime)
      .then((blob) => {
        active();
        urls.set(asset.id, URL.createObjectURL(blob));
      })
      .finally(() => preparing.delete(asset.id));
    preparing.set(asset.id, task);
    return task;
  }
  function findAsset(path: string) {
    const all = assets(),
      id = options.getMediaMap()[path];
    return id
      ? all[id]
      : Object.values(all).find((asset) => assetPath(asset) === path);
  }
  async function storeMedia(file: Blob, name: string) {
    active();
    const clean = safeName(name),
      ext = clean.split(".").pop()?.toLowerCase() || "",
      mime = MIME[ext] || file.type,
      kind = mime.split("/")[0] as MediaKind;
    if (!["image", "video", "audio"].includes(kind))
      throw new Error("请选择图片、视频或音频素材。");
    const asset: Asset = {
      id: crypto.randomUUID(),
      name: clean,
      mime,
      kind,
      size: file.size,
      createdAt: Date.now(),
    };
    await putBlob(asset.id, new Blob([file], { type: mime }));
    active();
    localAssets.set(asset.id, asset);
    options.addAsset(asset);
    const path = mapAsset(asset);
    await prepareAsset(asset);
    return {
      asset,
      path,
      upload: {
        name: clean,
        subfolder: path.slice(0, path.lastIndexOf("/")),
        type: "input",
      },
    };
  }
  const bodyJson = async (init?: RequestInit): Promise<Obj> => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (!object(body)) throw new Error("请求参数无效。");
    return body;
  };
  async function probe(path: string, signal?: AbortSignal | null) {
    const asset = findAsset(path);
    if (!asset || asset.kind !== "video")
      throw new Error("找不到本地视频素材，请重新选择。");
    await prepareAsset(asset);
    const video = document.createElement("video");
    return new Promise<Obj>((resolve, reject) => {
      const cleanup = () => {
        video.onloadedmetadata = null;
        video.onerror = null;
        signal?.removeEventListener("abort", cancelled);
        lifetime.signal.removeEventListener("abort", cancelled);
        video.removeAttribute("src");
        video.load();
      };
      const cancelled = () => {
        cleanup();
        reject(new DOMException("视频读取已取消。", "AbortError"));
      };
      video.onloadedmetadata = () => {
        const info = {
          width: video.videoWidth,
          height: video.videoHeight,
          duration: video.duration,
          nativeFps: null,
          nativeFrameCount: null,
        };
        cleanup();
        if (!info.width || !info.height || !Number.isFinite(info.duration))
          reject(new Error("浏览器无法读取这个视频的尺寸或时长。"));
        else resolve(info);
      };
      video.onerror = () => {
        cleanup();
        reject(new Error("浏览器无法解码这个参考视频，请转换为 H.264 MP4。"));
      };
      signal?.addEventListener("abort", cancelled, { once: true });
      lifetime.signal.addEventListener("abort", cancelled, { once: true });
      if (signal?.aborted || disposed) {
        cancelled();
        return;
      }
      video.preload = "metadata";
      video.src = urls.get(asset.id)!;
    });
  }
  async function exportPack(body: Obj) {
    if (!object(body.timeline)) throw new Error("缺少导演台时间轴。");
    const selected = new Map<string, { asset: Asset; path: string }>(),
      missing: string[] = [];
    const timeline = rewriteDirectorMediaPaths(
      stripDirectorPrompts(body.timeline),
      (path) => {
        const asset = findAsset(path);
        if (!asset) return undefined;
        if (!selected.has(asset.id)) {
          const ext = asset.name.split(".").pop()?.toLowerCase() || "bin";
          selected.set(asset.id, {
            asset,
            path: `extra/Media${selected.size + 1}.${/^[a-z0-9]{1,8}$/.test(ext) ? ext : "bin"}`,
          });
        }
        return selected.get(asset.id)!.path;
      },
      missing,
    );
    const widgets = stripDirectorPrompts(
        object(body.widgets) ? body.widgets : {},
      ),
      taskType = String(
        widgets.task_type || timeline.global?.taskType || "r2v",
      ).split(/\s/)[0];
    const report = {
      missing: [...new Set(missing)],
      totalBytes: [...selected.values()].reduce(
        (sum, item) => sum + item.asset.size,
        0,
      ),
      fileCount: selected.size,
      taskType,
    };
    if (body.dryRun || body.dry_run) return json(report);
    const files: Record<string, Uint8Array> = {
      "pack.json": strToU8(
        JSON.stringify({
          format: "minimax-h3-director-pack",
          formatVersion: 1,
          taskType,
          widgets,
          output: timeline.output || {},
        }),
      ),
      "timeline.json": strToU8(JSON.stringify(timeline)),
      "shared_params/shared_params.json": strToU8(
        JSON.stringify(timeline.global || {}),
      ),
    };
    for (const [i, group] of (
      timeline.segments ||
      timeline.shots ||
      []
    ).entries())
      files[`asset_groups/${String(i + 1).padStart(2, "0")}/group.json`] =
        strToU8(JSON.stringify(group));
    for (const item of selected.values())
      files[item.path] = new Uint8Array(
        await (await getBlob(item.asset.id, item.asset.mime)).arrayBuffer(),
      );
    active();
    const bytes = zipSync(files, { level: 0 });
    return new Response(bytes as Uint8Array<ArrayBuffer>, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(bytes.length),
        "X-Pack-Download-Name": `MiniMaxH3Director-${taskType.replace(/[^a-z0-9_-]/gi, "")}.mmxpack.zip`,
        "X-Pack-Missing": JSON.stringify(report.missing).replace(
          /[\u007f-\uffff]/g,
          (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
        ),
      },
    });
  }
  async function importPack(file: Blob) {
    const files = unpack(new Uint8Array(await file.arrayBuffer()));
    const read = (path: string) =>
      files[path]
        ? stripDirectorPrompts(JSON.parse(strFromU8(files[path])))
        : {};
    const pack = read("pack.json");
    if (pack.format && pack.format !== "minimax-h3-director-pack")
      throw new Error("不是 MiniMax H3 导演包。");
    if (Number(pack.formatVersion || 1) > 1)
      throw new Error("导演包版本高于当前支持版本。");
    if (!files["timeline.json"])
      throw new Error(
        "导演包缺少 timeline.json，请使用原版导演台重新导出完整导演包。",
      );
    const timeline = read("timeline.json");
    if (!object(timeline)) throw new Error("导演包时间轴格式不正确。");
    const paths = new Map<string, string>();
    for (const [path, bytes] of Object.entries(files)) {
      const mime = MIME[path.split(".").pop()?.toLowerCase() || ""];
      if (!mime) continue;
      const result = await storeMedia(
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }),
        safeName(path),
      );
      paths.set(path, result.path);
    }
    const missing: string[] = [];
    return json({
      timeline: rewriteDirectorMediaPaths(
        timeline,
        (path) => paths.get(path),
        missing,
      ),
      widgets: pack.widgets || {},
      packId: crypto.randomUUID(),
      missing: [...new Set(missing)],
    });
  }
  async function fetchApi(path: string, init?: RequestInit): Promise<Response> {
    try {
      active();
      init?.signal?.throwIfAborted();
      const url = new URL(path, "http://canvas.local");
      if (url.pathname === "/upload/image") {
        const form = init?.body;
        if (!(form instanceof FormData)) throw new Error("缺少上传文件。");
        const file = form.get("image");
        if (!(file instanceof Blob)) throw new Error("缺少上传文件。");
        return json(
          (await storeMedia(file, (file as File).name || "media")).upload,
        );
      }
      if (url.pathname === "/minimax/director/upload_chunk") {
        const form = init?.body;
        if (!(form instanceof FormData)) throw new Error("缺少素材分块。");
        const id = String(form.get("upload_id") || ""),
          name = safeName(String(form.get("filename") || "media")),
          index = Number(form.get("chunk_index")),
          total = Number(form.get("total_chunks")),
          chunk = form.get("chunk");
        if (
          !id ||
          !(chunk instanceof Blob) ||
          !Number.isInteger(index) ||
          !Number.isInteger(total) ||
          total < 1 ||
          total > 8192 ||
          index < 0 ||
          index >= total
        )
          throw new Error("素材分块参数无效。");
        let entry = uploads.get(id);
        if (entry && (entry.total !== total || entry.name !== name))
          throw new Error("素材分块不属于同一文件。");
        if (!entry) {
          entry = { name, total, parts: new Map() };
          uploads.set(id, entry);
        }
        entry.parts.set(index, chunk);
        if (entry.parts.size < total)
          return json({ status: "ok", chunk_index: index });
        const blob = new Blob(
          Array.from({ length: total }, (_, i) => entry!.parts.get(i)!),
        );
        uploads.delete(id);
        if (/\.zip$/i.test(name)) {
          const subfolder = `director_packs/${crypto.randomUUID()}`;
          packs.set(`${subfolder}/${name}`, blob);
          return json({ name, subfolder, type: "input" });
        }
        return json((await storeMedia(blob, name)).upload);
      }
      if (url.pathname === "/minimax/director/list_input_media") {
        const kind = url.searchParams.get("kind") || "image",
          list = Object.values(assets()).filter((a) =>
            kind === "reference_audio"
              ? a.kind === "audio" || a.kind === "video"
              : a.kind === kind,
          );
        await Promise.all(list.map(prepareAsset));
        return json({
          items: list.map((asset) => {
            const relPath = mapAsset(asset);
            return {
              name: asset.name,
              fileName: asset.name,
              relPath,
              subfolder: relPath.slice(0, relPath.lastIndexOf("/")),
              type: "input",
              modified: asset.createdAt / 1000,
              width: asset.width || 0,
              height: asset.height || 0,
              mediaKind: asset.kind,
            };
          }),
        });
      }
      if (url.pathname === "/minimax/director/probe_video") {
        const body = init?.body
          ? await bodyJson(init)
          : Object.fromEntries(url.searchParams);
        return json(
          await probe(
            mediaPath(body.videoFile || body.video_file, body.subfolder),
            init?.signal,
          ),
        );
      }
      if (url.pathname === "/minimax/director/export_pack")
        return await exportPack(await bodyJson(init));
      if (url.pathname === "/minimax/director/import_pack") {
        if (init?.body instanceof FormData) {
          const file = init.body.get("pack") || init.body.get("file");
          if (!(file instanceof Blob))
            throw new Error("请选择导演包 ZIP 文件。");
          return await importPack(file);
        }
        const body = await bodyJson(init),
          key = mediaPath(body.filename, body.subfolder),
          file = packs.get(key);
        if (!file) throw new Error("导演包尚未上传或已关闭，请重新选择。");
        try {
          return await importPack(file);
        } finally {
          packs.delete(key);
        }
      }
      if (
        url.pathname === "/object_info/LoraLoader" ||
        url.pathname.startsWith("/minimax/director/lora_preview")
      )
        return new Response(
          "当前导演台未连接云端 LoRA 目录，无法读取 LoRA 列表和预览。",
          { status: 503 },
        );
      return new Response(
        "此功能需要云端导演台节点支持，当前本地素材服务尚未连接。",
        { status: 501 },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        throw error;
      return new Response(
        error instanceof Error ? error.message : "导演台素材操作失败。",
        { status: 400 },
      );
    }
  }
  return {
    fetchApi,
    apiURL(path: string) {
      const url = new URL(path, "http://canvas.local");
      if (url.pathname !== "/view") return path;
      const asset = findAsset(
        mediaPath(
          url.searchParams.get("filename"),
          url.searchParams.get("subfolder"),
        ),
      );
      return (asset && urls.get(asset.id)) || "data:,";
    },
    async prepare() {
      active();
      const list = Object.values(assets()).filter((a) =>
        ["image", "video", "audio"].includes(a.kind),
      );
      list.forEach(mapAsset);
      await Promise.allSettled(list.map(prepareAsset));
      active();
    },
    destroy() {
      disposed = true;
      lifetime.abort();
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
      uploads.clear();
      packs.clear();
      localAssets.clear();
    },
  };
}
