import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { FileZillaNativeConnection, nativeTransferStatus } from "../../scripts/filezilla-native";

// Opt-in: the only ssh2 use is an ephemeral LOCAL TEST SERVER. The product
// connects through the compiled upstream FileZilla client engine. Its official
// SFTP transfer and directory operation classes execute against this fixture.
// Install server fixtures under .cache, never into product dependencies:
// npm install --prefix .cache/native-transfer-testdeps --no-save --package-lock=false --ignore-scripts ssh2@1.17.0
// $env:CANVAS_NATIVE_TRANSFER_TEST='1'; npx vitest run tests/native/filezilla-native.integration.test.ts
const enabled = process.env.CANVAS_NATIVE_TRANSFER_TEST === "1";
type FileHandle = { kind: "file"; path: string } | { kind: "dir"; path: string; sent: number };
type ServerFixture = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const require = createRequire(import.meta.url);
  const { Server, utils } = require(path.join(process.cwd(), ".cache", "native-transfer-testdeps", "node_modules", "ssh2"));
  const status = utils.sftp.STATUS_CODE;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } });
  const rawPublicKey: Buffer = utils.parseKey(privateKey).getPublicSSH();
  const hostKey = createHash("sha256").update(rawPublicKey).digest("hex");
  const password = randomBytes(20).toString("hex"), username = "local-fixture";
  const directories = new Set(["/", "/fixture", "/target"]), files = new Map<string, Buffer>(), removals: string[] = [];
  const renames: { from: string; to: string }[] = [];
  const denied = new Set<string>(), links = new Map<string, string>();
  const nameBatches = new Map<string, string[][]>(), readDirRequests = new Map<string, number>();
  const statRequests: string[] = [], stalledStats: (() => void)[] = [];
  const stalledOpens: { path: string; reply: () => void }[] = [];
  const stalledRenames: { from: string; to: string; reply: () => void }[] = [];
  const clients = new Set<any>();
  let conflictOnRename: Buffer | undefined;
  let holdNextOpen = false;
  let holdNextRename = false;
  let authAttempts = 0, writes = 0, slowWrites = false, holdLinkStats = false, heldRequests = 0;
  const normalize = (value: string) => value === "." ? "/fixture" : path.posix.resolve("/fixture", value);
  const attributes = (location: string) => ({ mode: links.has(location) ? 0o120777 : directories.has(location) ? 0o040755 : 0o100644, size: files.get(location)?.length || 0, uid: 1000, gid: 1000, atime: 1_700_000_000, mtime: 1_700_000_000 });
  const exists = (location: string) => directories.has(location) || files.has(location) || links.has(location);
  // SFTP v3 includes Unix-format longname metadata. The complete FileZilla
  // engine passes it through its directory parser, unlike the earlier bridge.
  const entry = (location: string, filename = path.posix.basename(location)) => ({
    filename,
    longname: `${links.has(location) ? "lrwxrwxrwx" : directories.has(location) ? "drwxr-xr-x" : "-rw-r--r--"} 1 fixture fixture ${attributes(location).size} Nov 14 22:13 ${filename}${links.has(location) ? ` -> ${links.get(location)}` : ""}`,
    attrs: attributes(location),
  });
  const server = new Server({ hostKeys: [privateKey] }, (client: any) => {
    clients.add(client); client.on("close", () => clients.delete(client)); client.on("error", () => undefined);
    client.on("authentication", (ctx: any) => { authAttempts++; if (ctx.method === "password" && ctx.username === username && ctx.password === password) ctx.accept(); else ctx.reject(["password"]); });
    client.on("ready", () => client.on("session", (accept: any) => {
      const session = accept(); session.on("sftp", (acceptSftp: any) => {
        const sftp = acceptSftp(), handles = new Map<string, FileHandle>(); let nextHandle = 0;
        const handle = (value: FileHandle) => { const raw = Buffer.from(String(++nextHandle)); handles.set(raw.toString("hex"), value); return raw; };
        const get = (raw: Buffer) => handles.get(raw.toString("hex"));
        const sendStatus = (id: number, code: number) => { if (!sftp.destroyed) sftp.status(id, code); };
        sftp.on("REALPATH", (id: number, value: string) => {
          const raw = normalize(value), location = links.get(raw) || raw;
          const reply = () => { if (!exists(location)) sendStatus(id, status.NO_SUCH_FILE); else sftp.name(id, [entry(location, location)]); };
          if (holdLinkStats && links.has(raw)) { heldRequests++; stalledStats.push(reply); } else reply();
        });
        for (const operation of ["STAT", "LSTAT"]) sftp.on(operation, (id: number, value: string) => {
          const raw = normalize(value); if (operation === "STAT") statRequests.push(raw);
          const location = operation === "STAT" && links.has(raw) ? links.get(raw)! : raw;
          const reply = () => { if (exists(location)) sftp.attrs(id, attributes(location)); else sendStatus(id, status.NO_SUCH_FILE); };
          if (operation === "STAT" && holdLinkStats && links.has(raw)) { heldRequests++; stalledStats.push(reply); } else reply();
        });
        sftp.on("FSTAT", (id: number, raw: Buffer) => { const item = get(raw); if (item) sftp.attrs(id, attributes(item.path)); else sendStatus(id, status.FAILURE); });
        sftp.on("OPENDIR", (id: number, value: string) => { const raw = normalize(value), location = links.get(raw) || raw; if (denied.has(location)) sendStatus(id, status.PERMISSION_DENIED); else if (directories.has(location)) sftp.handle(id, handle({ kind: "dir", path: location, sent: 0 })); else sendStatus(id, status.NO_SUCH_FILE); });
        sftp.on("READDIR", (id: number, raw: Buffer) => {
          const item = get(raw); if (!item || item.kind !== "dir") { sendStatus(id, status.FAILURE); return; }
          readDirRequests.set(item.path, (readDirRequests.get(item.path) || 0) + 1);
          const scripted = nameBatches.get(item.path);
          if (scripted) {
            const batch = scripted[item.sent++];
            if (batch !== undefined) sftp.name(id, batch.map(filename => entry(path.posix.join(item.path, filename), filename)));
            else sendStatus(id, status.EOF);
            return;
          }
          const children = [entry(item.path, "."), entry(path.posix.dirname(item.path), ".."), ...[...directories, ...files.keys(), ...links.keys()].filter(location => location !== item.path && path.posix.dirname(location) === item.path).map(location => entry(location))];
          const batch = children.slice(item.sent, item.sent + 3); item.sent += batch.length;
          if (batch.length) sftp.name(id, batch); else sendStatus(id, status.EOF);
        });
        sftp.on("OPEN", (id: number, value: string, flags: number) => {
          const location = normalize(value);
          if ((flags & 32) && exists(location)) { sendStatus(id, status.FAILURE); return; }
          if (!directories.has(path.posix.dirname(location))) { sendStatus(id, status.NO_SUCH_FILE); return; }
          if (!files.has(location)) files.set(location, Buffer.alloc(0));
          const reply = () => sftp.handle(id, handle({ kind: "file", path: location }));
          if (holdNextOpen) { holdNextOpen = false; stalledOpens.push({ path: location, reply }); } else reply();
        });
        sftp.on("WRITE", (id: number, raw: Buffer, offset: number, data: Buffer) => {
          const item = get(raw); if (!item || item.kind !== "file") { sendStatus(id, status.FAILURE); return; }
          const old = files.get(item.path) || Buffer.alloc(0), next = Buffer.alloc(Math.max(old.length, offset + data.length)); old.copy(next); data.copy(next, offset); files.set(item.path, next); writes++;
          if (slowWrites) setTimeout(() => sendStatus(id, status.OK), 30); else sendStatus(id, status.OK);
        });
        sftp.on("CLOSE", (id: number, raw: Buffer) => { handles.delete(raw.toString("hex")); sendStatus(id, status.OK); });
        // Standard SFTP RENAME must reject an existing destination. No
        // posix-rename extension is advertised, so publishing a staging file
        // cannot overwrite a concurrently created user file.
        sftp.on("RENAME", (id: number, from: string, to: string) => {
          const source = normalize(from), destination = normalize(to);
          const reply = () => {
            if (!files.has(source)) { sendStatus(id, status.NO_SUCH_FILE); return; }
            if (conflictOnRename) { files.set(destination, conflictOnRename); conflictOnRename = undefined; }
            if (exists(destination)) { sendStatus(id, status.FAILURE); return; }
            if (!directories.has(path.posix.dirname(destination))) { sendStatus(id, status.NO_SUCH_FILE); return; }
            files.set(destination, files.get(source)!); files.delete(source); renames.push({ from: source, to: destination }); sendStatus(id, status.OK);
          };
          if (holdNextRename) { holdNextRename = false; stalledRenames.push({ from: source, to: destination, reply }); } else reply();
        });
        sftp.on("MKDIR", (id: number, value: string) => { const location = normalize(value); if (exists(location)) sendStatus(id, status.FAILURE); else if (!directories.has(path.posix.dirname(location))) sendStatus(id, status.NO_SUCH_FILE); else { directories.add(location); sendStatus(id, status.OK); } });
        sftp.on("REMOVE", (id: number, value: string) => { const location = normalize(value); if (files.delete(location)) { removals.push(location); sendStatus(id, status.OK); } else sendStatus(id, status.NO_SUCH_FILE); });
        for (const operation of ["SETSTAT", "FSETSTAT"]) sftp.on(operation, (id: number) => sendStatus(id, status.OK));
        sftp.on("error", () => undefined);
      });
    }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { hostKey, username, password, port: (server.address() as AddressInfo).port, files, directories, denied, links, nameBatches, readDirRequests, removals, renames, statRequests, stalledOpens, stalledRenames, holdNextOpen: () => { holdNextOpen = true; }, releaseOpens: () => { for (const pending of stalledOpens.splice(0)) pending.reply(); }, holdNextRename: () => { holdNextRename = true; }, releaseRenames: () => { for (const pending of stalledRenames.splice(0)) pending.reply(); }, heldRequests: () => heldRequests, conflictNextRename: (payload: Buffer) => { conflictOnRename = payload; }, dropClients: () => { for (const client of clients) client.end(); }, holdLinks: (value: boolean) => { holdLinkStats = value; if (!value) for (const release of stalledStats.splice(0)) release(); }, authAttempts: () => authAttempts, writes: () => writes, slow: (value: boolean) => { slowWrites = value; }, close: async () => { for (const pending of stalledOpens.splice(0)) pending.reply(); for (const pending of stalledRenames.splice(0)) pending.reply(); for (const release of stalledStats.splice(0)) release(); for (const client of clients) client.end(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

describe.skipIf(!enabled)("actual official FileZilla client engine against a localhost-only SFTP fixture", () => {
  let server: ServerFixture, localRoot: string;
  let client: FileZillaNativeConnection | undefined;
  beforeAll(async () => {
    server = await fixture(); localRoot = await realpath(await mkdtemp(path.join(process.cwd(), ".cache", "native-upload-fixture-")));
    expect(await nativeTransferStatus()).toMatchObject({ available: true, engine: "FileZilla 官方引擎", version: "3.71.0" });
  }, 20_000);
  afterAll(async () => { await client?.close(); await server?.close(); if (localRoot) { const parent = await realpath(path.join(process.cwd(), ".cache")); if (path.dirname(localRoot) !== parent || !path.basename(localRoot).startsWith("native-upload-fixture-")) throw new Error("Refusing fixture cleanup outside cache"); await rm(localRoot, { recursive: true, force: true }); } }, 15_000);
  it("rejects unknown/changed host keys before authentication, then authenticates the confirmed key", async () => {
    const config = { host: "127.0.0.1", port: server.port, username: server.username, password: server.password };
    const first = await FileZillaNativeConnection.connect(config).then(() => null, error => error);
    expect(first).toMatchObject({ code: "HOST_KEY_REQUIRED", hostKey: server.hostKey }); expect(server.authAttempts()).toBe(0);
    await expect(FileZillaNativeConnection.connect({ ...config, hostKey: "0".repeat(64) })).rejects.toMatchObject({ code: "HOST_KEY_MISMATCH", hostKey: server.hostKey }); expect(server.authAttempts()).toBe(0);
    await expect(FileZillaNativeConnection.connect({ ...config, password: "incorrect-fixture-password", hostKey: server.hostKey })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    client = await FileZillaNativeConnection.connect({ ...config, hostKey: server.hostKey }); expect(path.posix.resolve(client.home)).toBe("/fixture"); expect(client.hostKey).toBe(server.hostKey); expect(client.isClosed()).toBe(false);
  }, 90_000);
  it("performs actual list/stat/mkdir/upload with byte equality and progress and refuses overwrite", async () => {
    expect(client).toBeDefined(); await client!.mkdir("/target/nested"); expect(await client!.stat("/target/nested")).toEqual({ directory: true, size: 0 });
    const source = path.join(localRoot, "模型 file %.bin"), payload = randomBytes(200_003); await writeFile(source, payload); const details = await stat(source), progress: number[] = [];
    await client!.upload(source, "/target/nested/模型 file %.bin", { allowedRoot: localRoot, expectedIdentity: { dev: details.dev, ino: details.ino, size: details.size, mtimeMs: details.mtimeMs }, onProgress: value => progress.push(value) });
    expect(server.files.get("/target/nested/模型 file %.bin")?.equals(payload)).toBe(true); expect(progress.at(-1)).toBe(payload.length); expect(progress.length).toBeGreaterThan(1);
    expect(server.renames).toContainEqual({ from: expect.any(String), to: "/target/nested/模型 file %.bin" });
    expect([...server.files.keys()].filter(location => location.startsWith("/target/nested/"))).toEqual(["/target/nested/模型 file %.bin"]);
    expect(await client!.list("/target/nested")).toContainEqual(expect.objectContaining({ name: "模型 file %.bin", directory: false, size: payload.length }));
    await expect(client!.upload(source, "/target/nested/模型 file %.bin", { allowedRoot: localRoot })).rejects.toMatchObject({ code: "FILE_EXISTS" }); expect(server.files.get("/target/nested/模型 file %.bin")?.equals(payload)).toBe(true);
  }, 35_000);
  it("cancels only its owned partial upload and keeps the native session usable", async () => {
    expect(client).toBeDefined(); const source = path.join(localRoot, "cancel.bin"); await writeFile(source, randomBytes(4 * 1024 * 1024)); server.slow(true);
    const removalsBefore = server.removals.length;
    const controller = new AbortController(); let progressed = 0;
    const transfer = client!.upload(source, "/target/cancel.bin", { allowedRoot: localRoot, signal: controller.signal, onProgress: value => { progressed = value; controller.abort(); } });
    await expect(transfer).rejects.toMatchObject({ code: "CANCELLED" }); server.slow(false); expect(progressed).toBeGreaterThan(0);
    expect(server.files.has("/target/cancel.bin")).toBe(false);
    const cancelledPaths = server.removals.slice(removalsBefore);
    expect(cancelledPaths).toHaveLength(1); expect(path.posix.dirname(cancelledPaths[0])).toBe("/target"); expect(cancelledPaths[0]).not.toBe("/target/cancel.bin");
    expect(server.files.has(cancelledPaths[0])).toBe(false); expect(server.files.has("/target/nested/模型 file %.bin")).toBe(true); expect(await client!.stat("/target")).toMatchObject({ directory: true }); expect(client!.isClosed()).toBe(false);
  }, 35_000);
  it("preserves a target created concurrently with final publication and removes only its own staging file", async () => {
    const source = path.join(localRoot, "publish-conflict.bin"), payload = randomBytes(200_003), existing = Buffer.from("concurrent user file");
    await writeFile(source, payload); const removalsBefore = server.removals.length;
    server.conflictNextRename(existing);
    const result = await client!.upload(source, "/target/publish-conflict.bin", { allowedRoot: localRoot }).then(() => null, error => error);
    expect(result).toBeInstanceOf(Error); expect(server.files.get("/target/publish-conflict.bin")?.equals(existing)).toBe(true);
    const removed = server.removals.slice(removalsBefore); expect(removed).toHaveLength(1); expect(removed[0]).not.toBe("/target/publish-conflict.bin"); expect(server.files.has(removed[0])).toBe(false);
    expect(await client!.stat("/target")).toMatchObject({ directory: true });
  }, 35_000);
  it("cleans its own zero-byte staging file when cancelled before the first upload progress event", async () => {
    const source = path.join(localRoot, "cancel-before-progress.bin"); await writeFile(source, Buffer.from("not sent yet"));
    const controller = new AbortController(), progress: number[] = [];
    server.holdNextOpen();
    const transfer = client!.upload(source, "/target/cancel-before-progress.bin", { allowedRoot: localRoot, signal: controller.signal, onProgress: value => progress.push(value) }).then(() => null, error => error);
    let staging: string | undefined;
    try {
      await expect.poll(() => server.stalledOpens.length, { timeout: 2_000 }).toBe(1);
      staging = server.stalledOpens[0].path; expect(server.files.get(staging)?.length).toBe(0); expect(progress.every(value => value === 0)).toBe(true);
      controller.abort(); server.releaseOpens();
      expect(await transfer).toMatchObject({ code: "CANCELLED" });
      expect(server.files.has("/target/cancel-before-progress.bin")).toBe(false); expect(server.files.has(staging)).toBe(false); expect(server.removals).toContain(staging);
      expect(await client!.stat("/target")).toMatchObject({ directory: true });
    } finally { controller.abort(); server.releaseOpens(); await transfer; if (staging) server.files.delete(staging); }
  }, 8_000);
  it("lists pages without probing stalled symlink targets, preserving on-demand navigation and structured operation errors", async () => {
    expect(client).toBeDefined(); server.directories.add("/fixture/permission-denied"); server.denied.add("/fixture/permission-denied");
    server.links.set("/fixture/model-directory", "/target/nested"); server.links.set("/fixture/broken-model-link", "/does-not-exist");
    for (let index = 0; index < 8; index++) server.files.set(`/fixture/page-${index}.txt`, Buffer.from("fixture"));
    server.holdLinks(true); const reading = client!.list("/fixture"); let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const entries = await Promise.race([reading, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Root listing probed a stalled symlink instead of returning metadata")), 1500); })]);
      expect(entries).toHaveLength(11); expect(entries.map(entry => entry.name)).not.toContain(".");
      expect(entries).toContainEqual(expect.objectContaining({ name: "model-directory", directory: false, symlink: true })); expect(entries).toContainEqual(expect.objectContaining({ name: "broken-model-link", directory: false, symlink: true }));
      expect(server.statRequests.filter(location => server.links.has(location))).toEqual([]);
    } finally { clearTimeout(deadline); server.holdLinks(false); await reading.catch(() => undefined); }
    expect(await client!.stat("/fixture/model-directory")).toMatchObject({ directory: true });
    expect(await client!.stat("/fixture/broken-model-link")).toMatchObject({ directory: false });
    // The official public engine exposes FZ_REPLY_ERROR for a failed listing,
    // not the private SSH_FX_PERMISSION_DENIED status. Preserve that honest
    // boundary instead of inferring a more specific code from server log text.
    await expect(client!.list("/fixture/permission-denied")).rejects.toMatchObject({ code: "REMOTE_OPERATION_FAILED" }); await expect(client!.stat("/does-not-exist")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await client!.stat("/target")).toMatchObject({ directory: true });
  }, 35_000);
  it("keeps a delayed reply pending without an application deadline", async () => {
    expect(client).toBeDefined(); server.links.set("/fixture/delayed-model-link", "/target/nested"); server.holdLinks(true);
    const priorHeld = server.heldRequests();
    let settled = false;
    const pending = client!.stat("/fixture/delayed-model-link").then(value => { settled = true; return value; }, error => { settled = true; return error; });
    try {
      // Establish that a real server reply is withheld before replacing the
      // JS application clock, so an adapter failure restores timers promptly.
      await expect.poll(() => server.heldRequests(), { timeout: 2_000 }).toBe(priorHeld + 1);
      expect(settled).toBe(false);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      // Socket I/O stays real; only artificial application timers advance.
      await vi.advanceTimersByTimeAsync(180_000);
      expect(settled).toBe(false); expect(client!.isClosed()).toBe(false);
      server.holdLinks(false);
      expect(await pending).toMatchObject({ directory: true });
    } finally { vi.useRealTimers(); server.holdLinks(false); }
    expect(await client!.stat("/target")).toMatchObject({ directory: true });
  }, 8_000);
  it("closes an active upload after acknowledged cleanup without a forced shutdown timer", async () => {
    const closingClient = await FileZillaNativeConnection.connect({ host: "127.0.0.1", port: server.port, username: server.username, password: server.password, hostKey: server.hostKey });
    const removalsBefore = server.removals.length;
    let closing: Promise<void> | undefined; server.slow(true);
    try {
      const upload = closingClient.upload(path.join(localRoot, "cancel.bin"), "/target/close-cancel.bin", { allowedRoot: localRoot, onProgress: () => { closing ??= closingClient.close(); } }).then(() => null, error => error);
      expect(await upload).toMatchObject({ code: "CANCELLED" });
      expect(closing).toBeDefined(); await closing; expect(closingClient.isClosed()).toBe(true);
      expect(server.files.has("/target/close-cancel.bin")).toBe(false);
      const cancelledPaths = server.removals.slice(removalsBefore);
      expect(cancelledPaths).toHaveLength(1); expect(path.posix.dirname(cancelledPaths[0])).toBe("/target"); expect(cancelledPaths[0]).not.toBe("/target/close-cancel.bin"); expect(server.files.has(cancelledPaths[0])).toBe(false);
    } finally { server.slow(false); await closingClient.close(); }
    expect(await client!.stat("/target")).toMatchObject({ directory: true });
  }, 8_000);
  it("awaits an in-flight final rename before closing, preserving the successfully published file", async () => {
    const closingClient = await FileZillaNativeConnection.connect({ host: "127.0.0.1", port: server.port, username: server.username, password: server.password, hostKey: server.hostKey });
    const source = path.join(localRoot, "close-during-publication.bin"), payload = randomBytes(100_003); await writeFile(source, payload);
    let closing: Promise<void> | undefined, closed = false;
    server.holdNextRename();
    const transfer = closingClient.upload(source, "/target/close-during-publication.bin", { allowedRoot: localRoot }).then(() => null, error => error);
    try {
      await expect.poll(() => server.stalledRenames.length, { timeout: 2_000 }).toBe(1);
      const staging = server.stalledRenames[0].from;
      closing = closingClient.close().then(() => { closed = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(closed).toBe(false); expect(server.files.has("/target/close-during-publication.bin")).toBe(false);
      server.releaseRenames(); expect(await transfer).toBeNull(); await closing;
      expect(closingClient.isClosed()).toBe(true); expect(server.files.get("/target/close-during-publication.bin")?.equals(payload)).toBe(true); expect(server.files.has(staging)).toBe(false);
    } finally { server.releaseRenames(); await transfer; await closingClient.close(); }
  }, 8_000);
  it.each([
    { name: "empty NAME batch", batches: [[], ["first.txt"], ["second.txt"]] },
    { name: "ignored final raw filename", batches: [["first.txt", "\u0001bad"], ["second.txt"]] },
  ])("returns every valid filename after $name and preserves the session", async ({ batches }) => {
    const isolated = await fixture(), directory = "/fixture/scripted"; isolated.directories.add(directory); isolated.nameBatches.set(directory, batches);
    isolated.files.set(directory + "/first.txt", Buffer.from("first")); isolated.files.set(directory + "/second.txt", Buffer.from("second"));
    const connection = await FileZillaNativeConnection.connect({ host: "127.0.0.1", port: isolated.port, username: isolated.username, password: isolated.password, hostKey: isolated.hostKey });
    const reading = connection.list(directory); let assertionDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const entries = await Promise.race([reading, new Promise<never>((_, reject) => { assertionDeadline = setTimeout(() => reject(new Error("READDIR batch completion stalled before returning all valid names")), 1500); })]);
      expect(entries.map(entry => entry.name).sort()).toEqual(["first.txt", "second.txt"]);
      // FileZilla's official directory implementation pipelines four READDIR
      // requests. The result and subsequent command, rather than an old custom
      // bridge's exact request count, establish pagination correctness.
      expect(isolated.readDirRequests.get(directory)).toBeGreaterThanOrEqual(batches.length + 1);
      expect(await connection.stat(directory)).toMatchObject({ directory: true });
      expect(connection.isClosed()).toBe(false);
    } finally { clearTimeout(assertionDeadline); isolated.dropClients(); await reading.catch(() => undefined); await connection.close(); await isolated.close(); }
  }, 8_000);
  it("marks a server-dropped connection closed and rejects pending and future calls promptly", async () => {
    expect(client).toBeDefined(); server.links.set("/fixture/drop-model-link", "/target/nested"); server.holdLinks(true);
    const priorHeld = server.heldRequests();
    const pending = client!.stat("/fixture/drop-model-link").then(() => null, error => error);
    await expect.poll(() => server.heldRequests(), { timeout: 2_000 }).toBe(priorHeld + 1);
    const started = Date.now(); server.dropClients();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const error = await Promise.race([pending, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Server disconnect waited for the operation timeout")), 2_000); })]);
      expect(error).toMatchObject({ code: "CONNECTION_FAILED" });
      await expect.poll(() => client!.isClosed(), { timeout: 1_000 }).toBe(true);
      await expect(client!.stat("/target")).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally { clearTimeout(deadline); }
  }, 8_000);
});
