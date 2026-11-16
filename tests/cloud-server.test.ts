import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createCanvasServer, canvasBasePath, canvasRequestOrigins, safeComfyPath } from "../scripts/cloud-server";
import { trustedCanvasRequest, trustedOrigins } from "../scripts/workflow-library-plugin";
import { buildWorkflowImport } from "../src/workflow/import-analyzer";
import { prepareWorkflowImport } from "../src/workflow/import-pipeline";

const publicOrigin = "https://canvas.example.test:8443";
const roots: string[] = [], servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith("canvas-cloud-test-")) throw new Error("Refusing cleanup outside the fixture");
    await rm(root, { recursive: true, force: true });
  }
});
async function listen(server: http.Server, port = 0) {
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  return (server.address() as net.AddressInfo).port;
}
async function fixture(allowedOrigins: string[] = [], autodlOrigins = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "canvas-cloud-test-")); roots.push(root);
  const dist = path.join(root, "dist"), library = path.join(root, "library"); await mkdir(dist); await mkdir(library);
  await mkdir(path.join(dist, "assets")); await writeFile(path.join(dist, "index.html"), "<html>canvas</html>"); await writeFile(path.join(dist, "assets", "style.css"), "body{color:white}");
  const port = await listen(createCanvasServer({ rootDir: root, distDir: dist, libraryDir: library, basePath: "/canvas/", allowedOrigins, autodlOrigins }));
  return { root, dist, port };
}
async function request(port: number, pathname: string, headers: http.OutgoingHttpHeaders = {}, method = "GET", body?: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method, headers }, response => {
      let data = ""; response.setEncoding("utf8"); response.on("data", chunk => { data += chunk; }); response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: data }));
    }); req.on("error", reject); req.end(body);
  });
}
async function websocketHandshake(port: number, host: string, origin: string, extraHeaders: Record<string, string> = {}) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1"); let data = "";
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error("Handshake timed out")); });
    socket.on("connect", () => socket.write("GET /canvas/comfy/ws?clientId=two-entries HTTP/1.1\r\nHost: " + host + "\r\nOrigin: " + origin + "\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdGNhbnZhcy10ZXN0\r\nSec-WebSocket-Version: 13\r\n" + Object.entries(extraHeaders).map(([name, value]) => name + ": " + value + "\r\n").join("") + "\r\n"));
    socket.on("data", chunk => { data += chunk.toString(); if (data.includes("\r\n\r\n")) { resolve(data); socket.destroy(); } });
    socket.on("error", reject);
  });
}

describe("cloud canvas service", () => {
  it("saves and resolves pending workflows through base-prefixed endpoints without generation", async () => {
    const { port } = await fixture([publicOrigin]);
    const source = { version: 0.4, nodes: [
      { id: 1, type: "OwnMaker", pos: [0, 0], widgets_values: { width: 64 }, inputs: [], outputs: [{ type: "IMAGE", links: [1] }] },
      { id: 2, type: "SaveImage", pos: [400, 0], widgets_values: { filename_prefix: "original" }, inputs: [{ name: "images", type: "IMAGE", link: 1 }], outputs: [] },
    ], links: [[1, 1, 0, 2, 0, "IMAGE"]] };
    const headers = { host: "canvas.example.test", origin: publicOrigin, "content-type": "application/json" };
    const prepared = await prepareWorkflowImport(source, "own-editor.json");
    const saved = await request(port, "/canvas/__canvas/workflow-library/import", headers, "POST", JSON.stringify(prepared));
    expect(saved.status).toBe(200); const identity = JSON.parse(saved.body);
    expect(identity.status).toBe("pending");
    const pending = JSON.parse((await request(port, "/canvas/__canvas/workflow-library", { origin: publicOrigin })).body);
    expect(pending.workflows[0].template).toBeUndefined();
    const original = await request(port, "/canvas/__canvas/workflow-library/source", headers, "POST", JSON.stringify({ workflowId: identity.workflowId }));
    expect(original.status).toBe(200);
    expect(JSON.parse(original.body)).toMatchObject({ source, filename: "own-editor.json", config: { id: identity.workflowId, importState: { status: "pending" } } });
    expect((await request(port, "/canvas/__canvas/workflow-library/source", { ...headers, origin: "https://foreign.example" }, "POST", JSON.stringify({ workflowId: identity.workflowId }))).status).toBe(403);
    const objectInfo = { OwnMaker: { input: { required: { width: ["INT"] } }, output: ["IMAGE"] }, SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true } };
    const resolved = await request(port, "/canvas/__canvas/workflow-library/resolve", headers, "POST", JSON.stringify({ workflowId: identity.workflowId, objectInfo }));
    expect(resolved.status).toBe(200); expect(JSON.parse(resolved.body)).toMatchObject({ workflowId: identity.workflowId, status: "ready" });
    const ready = JSON.parse((await request(port, "/canvas/__canvas/workflow-library", { origin: publicOrigin })).body);
    expect(ready.workflows[0].template["1"].inputs.width).toBe(64);
    expect((await request(port, "/canvas/__canvas/workflow-library/resolve?path=outside", headers, "POST", "{}")).status).toBe(405);
    expect((await request(port, "/canvas/__canvas/workflow-library/resolve", { ...headers, origin: "https://foreign.example" }, "POST", "{}")).status).toBe(403);
  });
  it("serves the configured base path and redirects root without changing desktop routes", async () => {
    const { port } = await fixture();
    expect((await request(port, "/")).headers.location).toBe("/canvas/");
    expect((await request(port, "/canvas")).headers.location).toBe("/canvas/");
    expect((await request(port, "/canvas/")).body).toContain("canvas");
    expect((await request(port, "/canvas/assets/style.css")).headers["content-type"]).toContain("text/css");
    expect((await request(port, "/canvas/assets/style.css", {}, "HEAD")).body).toBe("");
    expect((await request(port, "/canvas/assets/missing.js")).status).toBe(404);
    expect((await request(port, "/assets/style.css")).status).toBe(404);
    expect((await request(port, "/canvas/project/one")).status).toBe(200);
  });

  it("denies public hosts and foreign origins by default", async () => {
    const { port } = await fixture();
    expect((await request(port, "/canvas/", { host: "canvas.example.test:8443" })).status).toBe(403);
    expect((await request(port, "/canvas/__canvas/workflow-library", { origin: publicOrigin })).status).toBe(403);
  });

  it("allows only explicit origins through a localhost proxy and fixed library directory", async () => {
    const { port } = await fixture([publicOrigin]);
    const valid = await request(port, "/canvas/__canvas/workflow-library", { origin: publicOrigin });
    expect(valid.status).toBe(200); expect(JSON.parse(valid.body).scanned).toBe(0);
    expect((await request(port, "/canvas/__canvas/workflow-library?sourcePath=evil", { origin: publicOrigin })).status).toBe(405);
    expect((await request(port, "/canvas/__canvas/workflow-library", { origin: "https://foreign.example" })).status).toBe(403);
    expect((await request(port, "/canvas/", { host: "canvas.example.test:8443", origin: publicOrigin })).status).toBe(200);
    expect((await request(port, "/canvas/", { host: "canvas.example.test" })).status).toBe(200);
    expect((await request(port, "/canvas/", { host: "canvas.example.test", origin: publicOrigin })).status).toBe(200);
    expect((await request(port, "/canvas/", { host: "canvas.example.test", origin: "https://canvas.example.test" })).status).toBe(403);
    expect((await request(port, "/canvas/", { host: "canvas.example.test:8444", origin: publicOrigin })).status).toBe(403);
    expect((await request(port, "/canvas/__canvas/workflow-library/import", { host: "canvas.example.test:8443", "content-type": "application/json" }, "POST", "{}")).status).toBe(403);
    expect((await request(port, "/canvas/__canvas/workflow-library/import", { host: "canvas.example.test", "content-type": "application/json" }, "POST", "{}")).status).toBe(403);
  });

  it("registers an imported workflow on the base-prefixed endpoint without cloud generation", async () => {
    const { port } = await fixture([publicOrigin]);
    const graph = { source: { class_type: "EmptyImage", inputs: { width: 64, height: 64, batch_size: 1, color: 0 } }, out: { class_type: "SaveImage", inputs: { images: ["source", 0], filename_prefix: "test" } } };
    const id = "custom." + createHash("sha256").update(JSON.stringify(graph)).digest("hex");
    const built = buildWorkflowImport(graph, { id, name: "Own canvas workflow", family: "Custom" });
    const result = await request(port, "/canvas/__canvas/workflow-library/import", { host: "canvas.example.test", origin: publicOrigin, "content-type": "application/json" }, "POST", JSON.stringify({ filename: "own_api.json", source: graph, ...built }));
    expect(result.status).toBe(200); expect(JSON.parse(result.body).workflowId).toBe(id);
    const library = JSON.parse((await request(port, "/canvas/__canvas/workflow-library", { origin: publicOrigin })).body);
    expect(library.scanned).toBe(1); expect(library.workflows).toHaveLength(1); expect(library.issues).toEqual([]);
  });

  it("deletes only the verified workflow in its configured temporary library through the cloud endpoint", async () => {
    const { port, root } = await fixture([publicOrigin]);
    const libraryDir = path.join(root, "library"), outsideDir = path.join(root, "outside");
    const headers = { host: "canvas.example.test", origin: publicOrigin, "content-type": "application/json" };
    const ids: string[] = [];
    for (const color of [0, 1]) {
      const graph = { source: { class_type: "EmptyImage", inputs: { width: 64, height: 64, batch_size: 1, color } }, out: { class_type: "SaveImage", inputs: { images: ["source", 0], filename_prefix: "test" } } };
      const id = "custom." + createHash("sha256").update(JSON.stringify(graph)).digest("hex");
      ids.push(id);
      const built = buildWorkflowImport(graph, { id, name: color ? "Kept" : "Removed", family: "Custom" });
      expect((await request(port, "/canvas/__canvas/workflow-library/import", headers, "POST", JSON.stringify({ filename: "own-" + color + "_api.json", source: graph, ...built }))).status).toBe(200);
    }
    const before = JSON.parse((await request(port, "/canvas/__canvas/workflow-library", headers)).body);
    expect(before.workflows).toHaveLength(2); expect(before.issues).toEqual([]);
    const selected = before.workflows.find((workflow: { original: { id: string } }) => workflow.original.id === ids[0]);
    const neighbor = before.workflows.find((workflow: { original: { id: string } }) => workflow.original.id === ids[1]);
    const body = { workflowId: selected.original.id, folder: selected.original.folder, configSha256: selected.original.configSha256 };
    const configName = "workflow.config.json";
    const neighborConfig = await readFile(path.join(libraryDir, neighbor.original.folder, configName));
    const outsidePackage = path.join(outsideDir, body.folder);
    await mkdir(outsidePackage, { recursive: true });
    const outsideConfig = await readFile(path.join(libraryDir, body.folder, configName));
    await writeFile(path.join(outsidePackage, configName), outsideConfig);
    const endpoint = "/canvas/__canvas/workflow-library/delete";
    const get = await request(port, endpoint, headers);
    expect(get.status).toBe(405); expect(get.headers.allow).toBe("POST");
    expect((await request(port, endpoint, { ...headers, origin: "https://foreign.example" }, "POST", JSON.stringify(body))).status).toBe(403);
    expect((await request(port, endpoint + "?sourcePath=" + encodeURIComponent(outsideDir), headers, "POST", JSON.stringify(body))).status).toBe(405);
    expect((await request(port, endpoint, headers, "POST", JSON.stringify({ ...body, configSha256: "0".repeat(64) }))).status).toBe(409);
    expect((await readdir(libraryDir)).sort()).toEqual([body.folder, neighbor.original.folder].sort());
    const deleted = await request(port, endpoint, headers, "POST", JSON.stringify({ ...body, sourcePath: outsideDir }));
    expect(deleted.status).toBe(200);
    expect(JSON.parse(deleted.body)).toEqual({ workflowId: body.workflowId, folder: body.folder, deleted: true });
    expect(await readdir(libraryDir)).toEqual([neighbor.original.folder]);
    expect(await readFile(path.join(libraryDir, neighbor.original.folder, configName))).toEqual(neighborConfig);
    expect(await readFile(path.join(outsidePackage, configName))).toEqual(outsideConfig);
    const after = JSON.parse((await request(port, "/canvas/__canvas/workflow-library", headers)).body);
    expect(after.workflows.map((workflow: { id: string }) => workflow.id)).toEqual([neighbor.id]);
    expect(after.issues).toEqual([]);
  });

  it("allows two exact public entries to read and import while rejecting cross-entry origins", async () => {
    const origins = [publicOrigin, "https://direct-canvas.example.test:9443"];
    const { port } = await fixture(origins);
    let color = 0;
    for (const [index, origin] of origins.entries()) {
      const entry = new URL(origin), foreignOrigin = origins[1 - index];
      for (const host of [entry.host, entry.hostname]) {
        const headers = { host, origin };
        const root = await request(port, "/", { host });
        expect(root.status).toBe(302); expect(root.headers.location).toBe("/canvas/");
        expect((await request(port, "/canvas", headers)).headers.location).toBe("/canvas/");
        expect((await request(port, "/canvas/", headers)).status).toBe(200);
        expect((await request(port, "/canvas/assets/style.css", headers)).status).toBe(200);
        expect((await request(port, "/canvas/__canvas/workflow-library", { host })).status).toBe(200);
        expect((await request(port, "/canvas/__canvas/workflow-library", headers)).status).toBe(200);
        const graph = { source: { class_type: "EmptyImage", inputs: { width: 64, height: 64, batch_size: 1, color: ++color } }, out: { class_type: "SaveImage", inputs: { images: ["source", 0], filename_prefix: "test" } } };
        const id = "custom." + createHash("sha256").update(JSON.stringify(graph)).digest("hex");
        const built = buildWorkflowImport(graph, { id, name: "Entry " + color, family: "Custom" });
        const body = JSON.stringify({ filename: "entry-" + color + "_api.json", source: graph, ...built });
        const imported = await request(port, "/canvas/__canvas/workflow-library/import", { ...headers, "content-type": "application/json" }, "POST", body);
        expect(imported.status).toBe(200); expect(JSON.parse(imported.body).workflowId).toBe(id);
        for (const pathname of ["/", "/canvas/", "/canvas/__canvas/workflow-library"])
          expect((await request(port, pathname, { host, origin: foreignOrigin })).status).toBe(403);
        expect((await request(port, "/canvas/__canvas/workflow-library/import", { host, origin: foreignOrigin, "content-type": "application/json" }, "POST", body)).status).toBe(403);
        expect((await request(port, "/canvas/__canvas/workflow-library/import", { host, "content-type": "application/json" }, "POST", body)).status).toBe(403);
        expect((await request(port, "/canvas/__canvas/workflow-library", { host, origin: "https://unconfigured.example.test" })).status).toBe(403);
      }
    }
    const library = JSON.parse((await request(port, "/canvas/__canvas/workflow-library", { host: "direct-canvas.example.test", origin: origins[1] })).body);
    expect(library.scanned).toBe(4); expect(library.workflows).toHaveLength(4); expect(library.issues).toEqual([]);
    expect((await request(port, "/canvas/", { host: "direct-canvas.example.test:9444", origin: origins[1] })).status).toBe(403);
  });

  it("opts into new AutoDL instance origins for pages, workflow writes and HTTP/WebSocket proxies", async () => {
    const upstreamRequests: string[] = [];
    const upstream = http.createServer((req, res) => { upstreamRequests.push("HTTP " + req.url); res.setHeader("Content-Type", "application/json"); res.end("{}"); });
    upstream.on("upgrade", (req, socket) => { upstreamRequests.push("WS " + req.url); socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"); });
    await listen(upstream, 6006);
    const { port } = await fixture([], true);
    const instances = ["u2048-012345abcdef.westd.seetacloud.com", "uu3072-fedcba987654.eastd-2.seetacloud.com"];
    for (const instance of instances) {
      for (const [host, origin] of [[instance, "https://" + instance], [instance, "https://" + instance + ":8443"], [instance + ":8443", "https://" + instance + ":8443"]]) {
        const headers = { host, origin };
        expect((await request(port, "/canvas/", headers)).status).toBe(200);
        expect((await request(port, "/canvas/__canvas/workflow-library", headers)).status).toBe(200);
        expect((await request(port, "/canvas/comfy/system_stats", headers)).status).toBe(200);
        expect(await websocketHandshake(port, host, origin)).toContain("101 Switching Protocols");
      }
      expect((await request(port, "/canvas/", { host: instance })).status).toBe(200);
      expect((await request(port, "/canvas/__canvas/workflow-library/import", { host: instance, "content-type": "application/json" }, "POST", "{}")).status).toBe(403);
    }
    expect(upstreamRequests).toEqual(Array.from({ length: 6 }, () => ["HTTP /system_stats", "WS /ws?clientId=two-entries"]).flat());
    const headers = { host: instances[1], origin: "https://" + instances[1] + ":8443", "content-type": "application/json" };
    const source = { version: 0.4, nodes: [
      { id: 1, type: "OwnMaker", pos: [0, 0], widgets_values: { width: 64 }, inputs: [], outputs: [{ type: "IMAGE", links: [1] }] },
      { id: 2, type: "SaveImage", pos: [400, 0], widgets_values: { filename_prefix: "original" }, inputs: [{ name: "images", type: "IMAGE", link: 1 }], outputs: [] },
    ], links: [[1, 1, 0, 2, 0, "IMAGE"]] };
    const prepared = await prepareWorkflowImport(source, "new-instance.json");
    const imported = await request(port, "/canvas/__canvas/workflow-library/import", headers, "POST", JSON.stringify(prepared));
    expect(imported.status).toBe(200);
    const identity = JSON.parse(imported.body);
    const objectInfo = { OwnMaker: { input: { required: { width: ["INT"] } }, output: ["IMAGE"] }, SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true } };
    expect((await request(port, "/canvas/__canvas/workflow-library/resolve", headers, "POST", JSON.stringify({ workflowId: identity.workflowId, objectInfo }))).status).toBe(200);
    const ready = JSON.parse((await request(port, "/canvas/__canvas/workflow-library", headers)).body);
    expect(ready.workflows).toHaveLength(1); expect(ready.workflows[0].template["1"].inputs.width).toBe(64);
    const { original } = ready.workflows[0];
    expect((await request(port, "/canvas/__canvas/workflow-library/delete", headers, "POST", JSON.stringify({ workflowId: original.id, folder: original.folder, configSha256: original.configSha256 }))).status).toBe(200);
    expect(JSON.parse((await request(port, "/canvas/__canvas/workflow-library", headers)).body).workflows).toEqual([]);
  });

  it("rejects AutoDL sibling origins, misleading hosts, insecure schemes and crossed ports for HTTP and WebSocket", async () => {
    const { port } = await fixture([], true);
    const host = "u2048-012345abcdef.westd.seetacloud.com", origin = "https://" + host + ":8443";
    const rejected = [
      { host, origin: "https://uu2048-012345abcdef.westd.seetacloud.com:8443" },
      { host, origin: "https://u4096-fedcba987654.westd.seetacloud.com:8443" },
      { host: host + ".evil.test", origin },
      { host: host.replace("seetacloud.com", "seetacloudxcom"), origin },
      { host: host.replace("012345abcdef", "012345abcdef0"), origin },
      { host: host + ":443", origin: "https://" + host },
      { host: host + ":9443", origin: "https://" + host + ":9443" },
      { host: host + ":8443", origin: "https://" + host },
      { host, origin: "https://" + host + ":9443" },
      { host, origin: "http://" + host + ":8443" },
      { host, origin: origin + "/canvas/" },
      { host: "untrusted.example", origin, "x-forwarded-host": host },
    ];
    for (const headers of rejected) {
      expect((await request(port, "/canvas/", headers)).status).toBe(403);
      expect((await request(port, "/canvas/__canvas/workflow-library", headers)).status).toBe(403);
      expect((await request(port, "/canvas/__canvas/workflow-library/import", { ...headers, "content-type": "application/json" }, "POST", "{}")).status).toBe(403);
      expect((await request(port, "/canvas/comfy/system_stats", headers)).status).toBe(403);
      expect(await websocketHandshake(port, headers.host, headers.origin, "x-forwarded-host" in headers ? { "x-forwarded-host": headers["x-forwarded-host"]! } : {})).toContain("403 Forbidden");
    }
    // An accepted instance on one request must not authorize a later unrelated Host.
    expect((await request(port, "/canvas/", { host, origin })).status).toBe(200);
    expect((await request(port, "/canvas/", { host: "untrusted.example", origin })).status).toBe(403);
    const disabled = await fixture();
    expect((await request(disabled.port, "/canvas/", { host, origin })).status).toBe(403);
    expect(await websocketHandshake(disabled.port, host, origin)).toContain("403 Forbidden");
  });

  it("adds portable AutoDL origins only for explicitly enabled loopback gateway requests", () => {
    const host = "u2048-012345abcdef.westd.seetacloud.com";
    const gateway = (remoteAddress?: string) => ({ method: "POST", headers: { host, origin: "https://" + host + ":8443" }, socket: { remoteAddress } }) as http.IncomingMessage;
    const configured = trustedOrigins([publicOrigin]);
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const req = gateway(address), dynamic = canvasRequestOrigins(req, configured, true);
      expect(trustedCanvasRequest(req, dynamic)).toBe(true);
      expect(configured).toEqual([publicOrigin]);
      expect(canvasRequestOrigins(req, configured)).toBe(configured);
    }
    for (const address of ["10.0.0.10", "::ffff:10.0.0.10", "2001:db8::1", undefined]) {
      const req = gateway(address);
      expect(canvasRequestOrigins(req, configured, true)).toBe(configured);
      expect(trustedCanvasRequest(req, canvasRequestOrigins(req, configured, true))).toBe(false);
    }
  });

  it("rejects encoded traversal and symlinks outside the static directory", async () => {
    const { port, root, dist } = await fixture();
    expect((await request(port, "/canvas/%2e%2e%2fsecret.txt")).status).toBe(400);
    expect((await request(port, "/canvas/%00")).status).toBe(400);
    await writeFile(path.join(root, "secret.txt"), "not-public");
    try { await symlink(path.join(root, "secret.txt"), path.join(dist, "leak.txt")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
    expect((await request(port, "/canvas/leak.txt")).status).toBe(403);
  });

  it("proxies HTTP and WebSocket to the fixed local 6006 endpoint with the prefix removed", async () => {
    const requests: string[] = [];
    const upstream = http.createServer((req, res) => { requests.push(req.url!); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ url: req.url, method: req.method })); });
    upstream.on("upgrade", (req, socket) => { requests.push(req.url!); socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"); });
    await listen(upstream, 6006);
    const { port } = await fixture([publicOrigin]);
    const result = await request(port, "/canvas/comfy/object_info?check=1", { host: "canvas.example.test", origin: publicOrigin });
    expect(result.status).toBe(200); expect(JSON.parse(result.body).url).toBe("/object_info?check=1");
    expect((await request(port, "/canvas/comfy/prompt", { origin: "https://foreign.example", "content-type": "application/json" }, "POST", "{}")).status).toBe(403);
    for (const tail of ["canvas/", "%63anvas/", "%252fcanvas/", "%2e%2e%2fcanvas/"])
      expect((await request(port, "/canvas/comfy/" + tail, { origin: publicOrigin })).status).toBe(403);
    const handshake = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1"); let data = "";
      socket.setTimeout(3000, () => { socket.destroy(); reject(new Error("Handshake timed out")); });
      socket.on("connect", () => socket.write("GET /canvas/comfy/ws?clientId=test HTTP/1.1\r\nHost: canvas.example.test\r\nOrigin: " + publicOrigin + "\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdGNhbnZhcy10ZXN0\r\nSec-WebSocket-Version: 13\r\n\r\n"));
      socket.on("data", chunk => { data += chunk.toString(); if (data.includes("\r\n\r\n")) { resolve(data); socket.destroy(); } }); socket.on("error", reject);
    });
    expect(handshake).toContain("101 Switching Protocols"); expect(requests).toEqual(["/object_info?check=1", "/ws?clientId=test"]);
  });

  it("accepts each public entry's own Comfy HTTP and WebSocket origins without allowing cross-entry access", async () => {
    const requests: string[] = [];
    const upstream = http.createServer((req, res) => {
      requests.push(req.method + " " + req.url); req.resume();
      req.on("end", () => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ url: req.url, method: req.method })); });
    });
    upstream.on("upgrade", (req, socket) => { requests.push("WS " + req.url); socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"); });
    await listen(upstream, 6006);
    const origins = [publicOrigin, "https://direct-canvas.example.test:9443"];
    const { port } = await fixture(origins);
    for (const [index, origin] of origins.entries()) {
      const entry = new URL(origin), foreignOrigin = origins[1 - index];
      for (const host of [entry.host, entry.hostname]) {
        const result = await request(port, "/canvas/comfy/object_info", { host, origin });
        expect(result.status).toBe(200); expect(JSON.parse(result.body).url).toBe("/object_info");
        // The 6006 upstream is a local mock; this never submits a generation.
        const posted = await request(port, "/canvas/comfy/prompt", { host, origin, "content-type": "application/json" }, "POST", "{}");
        expect(posted.status).toBe(200); expect(JSON.parse(posted.body).method).toBe("POST");
        expect(await websocketHandshake(port, host, origin)).toContain("101 Switching Protocols");
        const acceptedCount = requests.length;
        expect((await request(port, "/canvas/comfy/object_info", { host, origin: foreignOrigin })).status).toBe(403);
        expect((await request(port, "/canvas/comfy/prompt", { host, origin: foreignOrigin, "content-type": "application/json" }, "POST", "{}")).status).toBe(403);
        expect(await websocketHandshake(port, host, foreignOrigin)).toContain("403 Forbidden");
        expect(requests).toHaveLength(acceptedCount);
      }
    }
    expect(requests).toEqual(Array.from({ length: 4 }, () => ["GET /object_info", "POST /prompt", "WS /ws?clientId=two-entries"]).flat());
  });

  it("contains malformed WebSocket URLs without stopping the server", async () => {
    const { port } = await fixture();
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1"); let data = "";
      socket.setTimeout(3000, () => { socket.destroy(); reject(new Error("Malformed handshake timed out")); });
      socket.on("connect", () => socket.write("GET http://[/canvas/comfy/ws HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"));
      socket.on("data", chunk => { data += chunk.toString(); if (data.includes("\r\n\r\n")) { resolve(data); socket.destroy(); } }); socket.on("error", reject);
    });
    expect(response).toContain("400 Bad Request"); expect((await request(port, "/canvas/")).status).toBe(200);
    expect(safeComfyPath("/view?filename=canvas%2Fresult.png")).toBe(true);
    expect(safeComfyPath("/canvas/comfy/ws")).toBe(false);
  });

  it("accepts exact origin configuration and rejects wildcard, paths and credentials", () => {
    expect(trustedOrigins([publicOrigin, publicOrigin])).toEqual([publicOrigin]);
    for (const origin of ["*", publicOrigin + "/canvas/", "https://user:pass@canvas.example", "ftp://canvas.example"]) expect(() => trustedOrigins([origin])).toThrow();
    expect(canvasBasePath("/canvas/")).toBe("/canvas/"); expect(() => canvasBasePath("/../")).toThrow();
    const remote = { method: "POST", headers: { host: "localhost:6008" }, socket: { remoteAddress: "10.0.0.10" } } as http.IncomingMessage;
    expect(trustedCanvasRequest(remote)).toBe(false);
    const publicRequest = (host: string, origin?: string, method = "GET") => ({ method, headers: { host, ...(origin ? { origin } : {}) }, socket: { remoteAddress: "10.0.0.10" } }) as http.IncomingMessage;
    expect(trustedCanvasRequest(publicRequest("canvas.example.test"), [publicOrigin])).toBe(true);
    expect(trustedCanvasRequest(publicRequest("canvas.example.test", publicOrigin, "POST"), [publicOrigin])).toBe(true);
    expect(trustedCanvasRequest(publicRequest("canvas.example.test", "https://canvas.example.test", "POST"), [publicOrigin])).toBe(false);
    expect(trustedCanvasRequest(publicRequest("canvas.example.test:443", publicOrigin), [publicOrigin])).toBe(false);
    expect(trustedCanvasRequest(publicRequest("canvas.example.test:8444", publicOrigin), [publicOrigin])).toBe(false);
  });
});
