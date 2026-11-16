import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { trustedCanvasRequest } from "./workflow-library-plugin";

const formats = "mov,matroska,webm,avi,mpeg,mpegts";
function run(binary: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("已取消视频兼容处理。")); return; }
    const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", data => { if (stdout.length < 100000) stdout += data.toString(); });
    child.stderr.resume(); // Never return raw filenames/decoder diagnostics to the UI.
    const cancel = () => child.kill();
    signal.addEventListener("abort", cancel, { once: true });
    child.once("error", error => { signal.removeEventListener("abort", cancel); reject(new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? "本机未找到 FFmpeg，无法创建兼容视频。原文件仍可下载。" : "无法启动本地视频兼容处理。")); });
    child.once("close", code => { signal.removeEventListener("abort", cancel); code === 0 && !signal.aborted ? resolve(stdout) : reject(new Error("视频无法解码或处理已取消，原文件仍可下载。")); });
  });
}
export async function createCompatibleVideo(input: string, output: string, signal: AbortSignal) {
  const probe = JSON.parse(await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", formats, "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,pix_fmt", "-of", "json", input], signal));
  const video = probe.streams?.[0];
  if (!video || !(video.width > 0 && video.height > 0)) throw new Error("结果文件没有可解码的视频画面。请核对 RunningHub 的输出文件。原文件已保留。");
  await run("ffmpeg", ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", formats, "-i", input,
    "-map", "0:v:0", "-map", "0:a:0?", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-y", output], signal);
  return { codec: String(video.codec_name ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, ""), width: video.width, height: video.height };
}
export function videoPlaybackHandler() {
  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (request.url !== "/__canvas/video-playback") { next(); return; }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (!trustedCanvasRequest(request)) { response.statusCode = 403; response.end(); return; }
    if (request.method !== "POST" || !/^(video\/[^;]+|application\/octet-stream)(;|$)/i.test(request.headers["content-type"] ?? "")) { response.statusCode = 415; response.end(); return; }
    const controller = new AbortController();
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    request.once("aborted", cancel); response.once("close", cancel);
    let directory: string | undefined;
    try {
      directory = await mkdtemp(path.join(os.tmpdir(), "canvas-video-playback-"));
      const input = path.join(directory, "input.bin"), output = path.join(directory, "playback.mp4");
      let size = 0;
      const limit = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; callback(size > 1024 ** 3 ? new Error("视频超过本地兼容处理的文件大小限制。") : null, chunk); } });
      await pipeline(request, limit, createWriteStream(input), { signal: controller.signal });
      const info = await createCompatibleVideo(input, output, controller.signal);
      response.setHeader("Content-Type", "video/mp4");
      response.setHeader("Content-Length", (await stat(output)).size);
      response.setHeader("X-Video-Source-Codec", info.codec);
      await pipeline(createReadStream(output), response, { signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted && !response.headersSent && !response.destroyed) {
        response.statusCode = 422; response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "本地视频兼容处理失败。" }));
      }
    } finally {
      request.off("aborted", cancel); response.off("close", cancel);
      // This directory was created exclusively for this request, never a caller path.
      if (directory && path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith("canvas-video-playback-")) await rm(directory, { recursive: true, force: true });
    }
  };
}
export function videoPlaybackPlugin(): Plugin {
  const handler = videoPlaybackHandler();
  return { name: "canvas-local-video-playback", configureServer(server) { server.middlewares.use((req, res, next) => { void handler(req, res, next).catch(next); }); }, configurePreviewServer(server) { server.middlewares.use((req, res, next) => { void handler(req, res, next).catch(next); }); } };
}
