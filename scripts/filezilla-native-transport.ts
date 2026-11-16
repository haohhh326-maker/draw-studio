import { createConnection, createServer, type Socket } from "node:net";

export type NativeTransport = { host: string; port: number; close(): void };

/**
 * Keep Windows networking on Windows while the official FileZilla Client engine
 * runs in WSL. This one-use endpoint forwards the unchanged SSH stream;
 * authentication and server host-key verification remain in the official engine.
 */
export async function openNativeTransport(host: string, port: number): Promise<NativeTransport> {
  if (process.platform !== "win32") return { host, port, close() {} };

  let closed = false, accepted = false;
  let nativeSocket: Socket | undefined, remoteSocket: Socket | undefined;
  const server = createServer();
  const close = () => {
    if (closed) return;
    closed = true;
    nativeSocket?.destroy(); remoteSocket?.destroy();
    if (server.listening) server.close();
  };

  server.on("connection", socket => {
    const loopback = socket.remoteAddress === "127.0.0.1" || socket.remoteAddress === "::ffff:127.0.0.1" || socket.remoteAddress === "::1";
    if (closed || accepted || !loopback) { socket.destroy(); return; }
    accepted = true; nativeSocket = socket;
    // The endpoint is private to one helper connection, never a reusable proxy.
    server.close();
    remoteSocket = createConnection({ host, port });
    nativeSocket.setNoDelay(true); remoteSocket.setNoDelay(true);
    nativeSocket.on("error", close); nativeSocket.on("close", close);
    remoteSocket.on("error", close); remoteSocket.on("close", close);
    nativeSocket.pipe(remoteSocket); remoteSocket.pipe(nativeSocket);
  });
  server.on("error", close);

  try {
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(new Error("无法建立本机原生传输通道。"));
      server.once("error", failed);
      server.listen(0, "127.0.0.1", () => { server.off("error", failed); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("本机原生传输通道不可用。");
    return { host: "127.0.0.1", port: address.port, close };
  } catch (error) { close(); throw error; }
}
