import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { videoPlaybackHandler } from "../scripts/video-playback-plugin";
const available = spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0 && spawnSync("ffprobe", ["-version"], { windowsHide: true }).status === 0;
let directory: string, server: Server, origin: string, source: Buffer;
beforeAll(async () => {
  if (!available) return;
  directory = await mkdtemp(path.join(os.tmpdir(), "canvas-video-test-"));
  const input = path.join(directory, "hevc.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x96:rate=8", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "0.5", "-c:v", "libx265", "-x265-params", "log-level=error", "-pix_fmt", "yuv420p10le", "-c:a", "aac", "-y", input], { windowsHide: true, stdio: "ignore" });
  source = await readFile(input);
  const handler = videoPlaybackHandler();
  server = createServer((req, res) => { void handler(req, res, () => { res.statusCode = 404; res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  if (directory && path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith("canvas-video-test-")) await rm(directory, {recursive:true,force:true});
});
it.skipIf(!available)("converts a real 10-bit HEVC video to playable H.264 with preserved dimensions and audio", async () => {
  const response = await fetch(origin + "/__canvas/video-playback", {method:"POST",headers:{Origin:origin,"Content-Type":"application/octet-stream"},body:new Uint8Array(source)});
  expect(response.status).toBe(200); expect(response.headers.get("x-video-source-codec")).toBe("hevc");
  const output = path.join(directory, "playable.mp4"); await writeFile(output,new Uint8Array(await response.arrayBuffer()));
  const probe = JSON.parse(execFileSync("ffprobe", ["-v","error","-show_streams","-of","json",output], {windowsHide:true,encoding:"utf8"}));
  expect(probe.streams.find((stream:any)=>stream.codec_type==="video")).toMatchObject({codec_name:"h264",pix_fmt:"yuv420p",width:64,height:96});
  expect(probe.streams.find((stream:any)=>stream.codec_type==="audio").codec_name).toBe("aac");
  expect(await readFile(path.join(directory,"hevc.mp4"))).toEqual(source);
});
it.skipIf(!available)("rejects cross-origin requests and reports invalid media as an error rather than a video", async () => {
  const denied = await fetch(origin + "/__canvas/video-playback", {method:"POST",headers:{Origin:"https://untrusted.example","Content-Type":"video/mp4"},body:"notvideo"});
  expect(denied.status).toBe(403);
  const invalid = await fetch(origin + "/__canvas/video-playback", {method:"POST",headers:{Origin:origin,"Content-Type":"video/mp4"},body:"notvideo"});
  expect(invalid.status).toBe(422); expect((await invalid.json()).error).toContain("无法解码");
});
