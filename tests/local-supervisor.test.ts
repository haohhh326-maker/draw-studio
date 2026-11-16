import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
type Controller = {
  start: () => Promise<boolean>;
  stop: () => Promise<void>;
  getStatus: () => {
    phase: string;
    serverPid: number | null;
    ownsServer: boolean;
  };
};
const { probe, supervisorEndpoint, createSupervisor } =
  require("../scripts/local-supervisor.cjs") as {
    probe: (
      url: string,
      timeoutMs?: number,
    ) => Promise<"ready" | "offline" | "occupied" | "unhealthy">;
    supervisorEndpoint: (root: string) => string;
    createSupervisor: (options: {
      root: string;
      url: string;
      intervalMs?: number;
      timeoutMs?: number;
      startupGraceMs?: number;
      serverArgs?: string[];
    }) => Controller;
  };

const servers: http.Server[] = [];
const timers: NodeJS.Timeout[] = [];
const roots: string[] = [];
const controllers: Controller[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.stop();
  for (const timer of timers.splice(0)) clearInterval(timer);
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (
      !resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(resolved).startsWith("draw-supervisor-test-")
    ) {
      throw new Error("Refusing cleanup outside the supervisor fixture");
    }
    await rm(resolved, { recursive: true, force: true });
  }
});

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
  };
}

function document(title = "Draw studio", src = "/assets/app.js") {
  return `<!doctype html><html><head><title>${title}</title><script type="module" src="${src}"></script></head><body><div id="root"></div></body></html>`;
}

function html(res: http.ServerResponse, body: string) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function javascript(res: http.ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
  res.end("console.log('supervisor fixture');");
}

async function fixture(entrySize = 0) {
  const root = await mkdtemp(path.join(os.tmpdir(), "draw-supervisor-test-"));
  roots.push(root);
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "index.html"), document());
  const script = path.join(root, "fixture-preview.cjs");
  await writeFile(
    script,
    `const http = require('node:http');
const entry = "console.log('fixture');" + ' '.repeat(${entrySize});
http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/assets/app.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/assets/app.js' ? entry : ${JSON.stringify(document())});
}).listen(Number(process.argv[2]), '127.0.0.1');
`,
  );
  const { server, url } = await listen((_req, res) =>
    res.end("port reservation"),
  );
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const options = {
    root,
    url,
    intervalMs: 100,
    timeoutMs: 200,
    startupGraceMs: 500,
    serverArgs: [script, String(port)],
  };
  return { root, url, options };
}

async function until(predicate: () => boolean, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for fixture supervisor state");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

describe("local canvas readiness probe", () => {
  it("reports offline when the listening process is gone", async () => {
    const { server, url } = await listen((_req, res) => res.end("unused"));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probe(url)).toBe("offline");
  });

  it("does not treat a foreign website on the same port as our canvas", async () => {
    const { url } = await listen((_req, res) =>
      html(res, document("Unrelated dashboard")),
    );
    expect(await probe(url)).toBe("occupied");
  });

  it("requires a JavaScript entry to be fetchable before reporting ready", async () => {
    const paths: string[] = [];
    const { url } = await listen((req, res) => {
      paths.push(req.url!);
      if (req.url === "/assets/app.js") javascript(res);
      else html(res, document());
    });
    expect(await probe(url)).toBe("ready");
    expect(paths).toEqual(["/", "/assets/app.js"]);
  });

  it("accepts a valid 1,099,900-byte JavaScript entry without applying the HTML size limit", async () => {
    const prefix = "console.log('large bundle');";
    const entry = prefix + " ".repeat(1_099_900 - prefix.length);
    const { url } = await listen((req, res) => {
      if (req.url === "/assets/app.js") {
        res.writeHead(200, { "Content-Type": "text/javascript", "Content-Length": Buffer.byteLength(entry) });
        res.end(entry);
      } else html(res, document());
    });
    expect(await probe(url)).toBe("ready");
  });

  it("closes a large script probe after its bounded prefix without waiting for the remaining body", async () => {
    let finishScript: (() => void) | undefined;
    const closed = new Promise<void>(resolve => { finishScript = resolve; });
    const { url } = await listen((req, res) => {
      if (req.url === "/assets/app.js") {
        res.writeHead(200, { "Content-Type": "application/javascript", "Content-Length": 2 * 1024 * 1024 });
        res.on("close", finishScript!);
        res.write("console.log('prefix');" + " ".repeat(64 * 1024));
        // Deliberately leave the rest unsent. The existing request deadline is unchanged.
      } else html(res, document());
    });
    expect(await probe(url, 500)).toBe("ready");
    await closed;
  });

  it("rejects an HTML fallback disguised as a large JavaScript entry", async () => {
    const { url } = await listen((req, res) => {
      if (req.url === "/assets/app.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" });
        res.end(" \n" + document() + " ".repeat(1024 * 1024));
      } else html(res, document());
    });
    expect(await probe(url)).toBe("unhealthy");
  });

  it("does not accept an all-whitespace prefix that cannot rule out a later HTML fallback", async () => {
    const { url } = await listen((req, res) => {
      if (req.url === "/assets/app.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" });
        res.end(" ".repeat(64 * 1024) + document());
      } else html(res, document());
    });
    expect(await probe(url)).toBe("unhealthy");
  });

  it("accepts the existing legacy canvas title for migration", async () => {
    const { url } = await listen((req, res) => {
      if (req.url === "/assets/app.js") javascript(res);
      else html(res, document("AI Infinite Canvas"));
    });
    expect(await probe(url)).toBe("ready");
  });

  it("recognizes an absolute same-origin entry URL", async () => {
    const { url } = await listen((req, res) => {
      if (req.url === "/assets/app.js") javascript(res);
      else
        html(res, document("Draw studio", new URL("/assets/app.js", url).href));
    });
    expect(await probe(url)).toBe("ready");
  });

  it("rejects an application page with no entry module", async () => {
    const { url } = await listen((_req, res) =>
      html(res, "<html><title>Draw studio</title><div id='root'></div></html>"),
    );
    expect(await probe(url)).toBe("unhealthy");
  });

  it("reports malformed entry URLs as unhealthy without stopping supervision", async () => {
    const { url } = await listen((_req, res) =>
      html(res, document("Draw studio", "http://[")),
    );
    expect(await probe(url)).toBe("unhealthy");
  });

  it("rejects missing entry assets even when SPA fallback returns the index page", async () => {
    const { url } = await listen((_req, res) => html(res, document()));
    expect(await probe(url)).toBe("unhealthy");
  });

  it("rejects an entry returned with a failing HTTP status", async () => {
    const { url } = await listen((req, res) => {
      if (req.url === "/assets/app.js") {
        res.writeHead(404, { "Content-Type": "text/javascript" });
        res.end("not found");
      } else html(res, document());
    });
    expect(await probe(url)).toBe("unhealthy");
  });

  it("does not fetch a cross-origin script while probing a local website", async () => {
    let foreignRequests = 0;
    const foreign = await listen((_req, res) => {
      foreignRequests++;
      javascript(res);
    });
    const { url } = await listen((_req, res) =>
      html(res, document("Draw studio", new URL("/app.js", foreign.url).href)),
    );
    expect(await probe(url)).toBe("unhealthy");
    expect(foreignRequests).toBe(0);
  });

  it("does not follow an HTTP redirect to another origin", async () => {
    let foreignRequests = 0;
    const foreign = await listen((_req, res) => {
      foreignRequests++;
      html(res, document());
    });
    const { url } = await listen((_req, res) => {
      res.writeHead(302, { Location: foreign.url });
      res.end();
    });
    expect(await probe(url)).not.toBe("ready");
    expect(foreignRequests).toBe(0);
  });

  it("bounds a response that never sends headers", async () => {
    const { url } = await listen(() => {});
    const started = Date.now();
    expect(await probe(url, 120)).not.toBe("ready");
    expect(Date.now() - started).toBeLessThan(800);
  }, 2500);

  it("bounds a body that keeps arriving without ever ending", async () => {
    const { url } = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write("<html><title>Draw studio</title>");
      timers.push(setInterval(() => res.write(" "), 20));
    });
    const started = Date.now();
    expect(await probe(url, 120)).not.toBe("ready");
    expect(Date.now() - started).toBeLessThan(800);
  }, 2500);

  it("bounds a stalled JavaScript body after receiving valid HTML", async () => {
    const { url } = await listen((req, res) => {
      if (req.url === "/assets/app.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" });
        res.write("console.log(");
        timers.push(setInterval(() => res.write(" "), 20));
      } else html(res, document());
    });
    const started = Date.now();
    expect(await probe(url, 120)).toBe("unhealthy");
    expect(Date.now() - started).toBeLessThan(800);
  }, 2500);

  it("rejects oversized HTML instead of accumulating it indefinitely", async () => {
    const { url } = await listen((_req, res) =>
      html(res, document() + " ".repeat(1024 * 1024 + 1)),
    );
    expect(await probe(url)).not.toBe("ready");
  });
});

describe("local supervisor identity", () => {
  it("uses one endpoint for equivalent paths and isolates different projects", async () => {
    const first = await mkdtemp(
      path.join(os.tmpdir(), "draw-supervisor-test-"),
    );
    const second = await mkdtemp(
      path.join(os.tmpdir(), "draw-supervisor-test-"),
    );
    roots.push(first, second);
    expect(supervisorEndpoint(first)).toBe(
      supervisorEndpoint(path.join(first, ".")),
    );
    expect(supervisorEndpoint(first)).not.toBe(supervisorEndpoint(second));
  });
});

describe("independent local service supervision", () => {
  it("keeps its owned preview alive across checks when the real entry bundle exceeds 1 MiB", async () => {
    const { options } = await fixture(1_099_900);
    const controller = createSupervisor(options);
    controllers.push(controller);
    expect(await controller.start()).toBe(true);
    await until(() => controller.getStatus().phase === "ready");
    const originalPid = controller.getStatus().serverPid;
    await new Promise(resolve => setTimeout(resolve, options.startupGraceMs + options.intervalMs * 4));
    expect(controller.getStatus()).toMatchObject({ phase: "ready", ownsServer: true, serverPid: originalPid });
  }, 10000);

  it("restarts its owned preview after that process exits", async () => {
    const { options, url } = await fixture();
    const controller = createSupervisor(options);
    controllers.push(controller);
    expect(await controller.start()).toBe(true);
    await until(() => controller.getStatus().phase === "ready");
    const originalPid = controller.getStatus().serverPid!;
    expect(controller.getStatus().ownsServer).toBe(true);
    expect(originalPid).not.toBe(process.pid);
    process.kill(originalPid);
    await until(
      () =>
        controller.getStatus().phase === "ready" &&
        controller.getStatus().serverPid !== originalPid,
    );
    expect(await probe(url)).toBe("ready");
    expect(controller.getStatus().serverPid).not.toBeNull();
  }, 10000);

  it("prevents a second supervisor from spawning another process for the same project", async () => {
    const { options } = await fixture();
    const first = createSupervisor(options);
    controllers.push(first);
    expect(await first.start()).toBe(true);
    await until(() => first.getStatus().phase === "ready");
    const second = createSupervisor(options);
    expect(await second.start()).toBe(false);
    expect(second.getStatus().ownsServer).toBe(false);
    expect(second.getStatus().serverPid).toBeNull();
    expect(first.getStatus().phase).toBe("ready");
  }, 10000);

  it("leaves a foreign process listening on the configured port untouched", async () => {
    const { options } = await fixture();
    const foreign = await listen((_req, res) =>
      html(res, document("Other local service")),
    );
    const controller = createSupervisor({ ...options, url: foreign.url });
    controllers.push(controller);
    expect(await controller.start()).toBe(true);
    expect(controller.getStatus()).toMatchObject({
      phase: "occupied",
      serverPid: null,
      ownsServer: false,
    });
    await controller.stop();
    expect(foreign.server.listening).toBe(true);
    expect(await probe(foreign.url)).toBe("occupied");
  }, 10000);

  it("monitors a ready existing preview without adopting or terminating it", async () => {
    const { options } = await fixture();
    const existing = await listen((req, res) => {
      if (req.url === "/assets/app.js") javascript(res);
      else html(res, document());
    });
    const controller = createSupervisor({ ...options, url: existing.url });
    controllers.push(controller);
    expect(await controller.start()).toBe(true);
    expect(controller.getStatus()).toMatchObject({
      phase: "monitoring",
      serverPid: null,
      ownsServer: false,
    });
    await controller.stop();
    expect(existing.server.listening).toBe(true);
    expect(await probe(existing.url)).toBe("ready");
  }, 10000);

  it("honors the disabled marker and shuts down only its own preview", async () => {
    const { root, options, url } = await fixture();
    const controller = createSupervisor(options);
    controllers.push(controller);
    expect(await controller.start()).toBe(true);
    await until(() => controller.getStatus().phase === "ready");
    await writeFile(
      path.join(root, ".cache", "local-service.disabled"),
      "disabled for fixture",
    );
    await until(() => controller.getStatus().phase === "stopped");
    expect(controller.getStatus()).toMatchObject({
      serverPid: null,
      ownsServer: false,
    });
    expect(await probe(url)).toBe("offline");
    expect(await createSupervisor(options).start()).toBe(false);
  }, 10000);
});
