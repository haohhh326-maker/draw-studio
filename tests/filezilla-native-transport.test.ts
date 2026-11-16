import { afterEach, describe, expect, it } from "vitest";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { openNativeTransport, type NativeTransport } from "../scripts/filezilla-native-transport";

describe.skipIf(process.platform !== "win32")("one-use Windows transport for the native SSH client", () => {
  let relay: NativeTransport | undefined, upstream: Server | undefined;
  const sockets = new Set<Socket>();
  afterEach(async () => {
    relay?.close(); relay = undefined;
    for (const socket of sockets) socket.destroy(); sockets.clear();
    if (upstream?.listening) await new Promise<void>(resolve => upstream!.close(() => resolve()));
    upstream = undefined;
  });
  const connect = async (port: number) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    sockets.add(socket); socket.on("error", () => undefined);
    await once(socket, "connect"); return socket;
  };

  it("binds only loopback, preserves the byte stream, and accepts only one connection", async () => {
    let connections = 0;
    upstream = createServer(socket => { connections++; sockets.add(socket); socket.on("error", () => undefined); socket.pipe(socket); });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const target = upstream.address(); if (!target || typeof target === "string") throw new Error("Missing fixture listener");
    relay = await openNativeTransport("127.0.0.1", target.port); expect(relay.host).toBe("127.0.0.1");
    const client = await connect(relay.port), payload = randomBytes(256 * 1024 + 19);
    const echoed = new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []; let size = 0;
      client.on("data", chunk => { chunks.push(chunk); size += chunk.length; if (size === payload.length) resolve(Buffer.concat(chunks)); });
      client.once("error", reject);
    });
    client.write(payload); expect((await echoed).equals(payload)).toBe(true); expect(connections).toBe(1);
    const second = createConnection({ host: relay.host, port: relay.port }); sockets.add(second);
    const [error] = await once(second, "error"); expect(error).toMatchObject({ code: "ECONNREFUSED" });
    const ended = once(client, "close"); relay.close(); await ended;
    expect(client.destroyed).toBe(true); relay.close();
  }, 8_000);

  it("can close an unused endpoint without opening an upstream connection", async () => {
    let connections = 0;
    upstream = createServer(socket => { connections++; sockets.add(socket); });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const target = upstream.address(); if (!target || typeof target === "string") throw new Error("Missing fixture listener");
    relay = await openNativeTransport("127.0.0.1", target.port); relay.close(); relay.close();
    const client = createConnection({ host: relay.host, port: relay.port }); sockets.add(client);
    const [error] = await once(client, "error"); expect(error).toMatchObject({ code: "ECONNREFUSED" });
    expect(connections).toBe(0);
  }, 8_000);
});
