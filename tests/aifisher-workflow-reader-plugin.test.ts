import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { aifisherWorkflowReaderHandler } from "../scripts/aifisher-workflow-reader-plugin";

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
async function fixture() {
  const handle = aifisherWorkflowReaderHandler(process.cwd());
  const server = createServer((req, res) => { void handle(req, res, () => { res.statusCode = 404; res.end(); }); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}
function send(port: number, body: string, extra: Record<string, string> = {}, method = "POST") {
  return new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, method, path: "/__canvas/workflow-reader", headers: { "Content-Type": "application/json", ...extra } }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.once("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.once("error", reject); req.end(body);
  });
}
describe("same-origin upstream workflow reader endpoint", () => {
  it("reads a same-origin artifact without a network fetch", async () => {
    const port = await fixture();
    const result = await send(port, JSON.stringify({ environment: "comfyui", source: { "1": { class_type: "SaveImage", inputs: { filename_prefix: "test" } } } }), { Origin: `http://127.0.0.1:${port}` });
    expect(result.status).toBe(200);
    expect(result.body.upstream.revision).toBe("bdcf3bec054594fcab591952a8c5acef858d6de4");
    expect(result.body.outputEvidence.outputs).toEqual([]);
    expect(result.body.parameterBindings).toBeUndefined();
    expect(result.body.parameterBindingDto).toBeUndefined();
  });
  it("returns upstream RunningHub raw bindings and public control IDs through the same-origin endpoint", async () => {
    const port = await fixture();
    const result = await send(port, JSON.stringify({ environment: "runninghub-webapp", remoteId: "123", source: { nodeInfoList: [
      { nodeId: "1", fieldName: "choice", fieldType: "LIST", fieldValue: 1, options: [1, "1"] },
      { nodeId: "2", fieldName: "seed", fieldType: "INT", fieldValue: 8 },
    ] } }), { Origin: `http://127.0.0.1:${port}` });
    expect(result.status).toBe(200);
    expect(result.body.parameterBindings).toHaveLength(2);
    const rawChoice = result.body.parameterBindings.find((binding: Record<string, any>) => binding.target.fieldName === "choice");
    const publicChoice = result.body.parameterBindingDto.bindings.find((binding: Record<string, any>) => binding.key === rawChoice.key);
    expect(rawChoice.control.options).toEqual([1, "1"]);
    expect(publicChoice.control.options[0].id).not.toBe(publicChoice.control.options[1].id);
    expect(publicChoice.control.defaultValue).toBe(publicChoice.control.options[0].id);
    expect(result.body.parameterBindings.find((binding: Record<string, any>) => binding.target.fieldName === "seed").control.defaultValue).toEqual({ mode: "fixed", value: 8 });
  });
  it("rejects foreign origins before parsing a workflow", async () => {
    const result = await send(await fixture(), "{}", { Origin: "https://untrusted.example" });
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("AIFISHER_READER_ORIGIN");
  });
  it("returns domain errors for malformed JSON and unsupported environments", async () => {
    const port = await fixture();
    expect((await send(port, "{")).body.code).toBe("AIFISHER_READER_JSON");
    expect((await send(port, JSON.stringify({ environment: "shell", source: {} }))).status).toBe(400);
    expect((await send(port, "", {}, "GET")).status).toBe(405);
  });
});
