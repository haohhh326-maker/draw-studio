import type { Page, Locator } from "playwright";
import { museComposerSelector } from "./muse-session-state";

export class MuseUploadError extends Error {}
export type MuseUploadFile = { name: string; mime: string; path?: string; dataBase64?: string };
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 250));

export function museFileAccepts(accept: string, file: Pick<MuseUploadFile, "name" | "mime">): boolean {
  if (!accept.trim()) return true;
  const mime = file.mime.split(";")[0].toLowerCase(), name = file.name.toLowerCase();
  return accept.split(",").some(part => {
    const rule = part.trim().toLowerCase();
    return rule === "*/*" || rule === mime || rule.endsWith("/*") && mime.startsWith(rule.slice(0, -1)) || rule.startsWith(".") && name.endsWith(rule);
  });
}
export async function museUploadError(page: Page): Promise<string | undefined> {
  const alerts = await page.locator('[role="alert"]').allTextContents();
  return alerts.find(text => /upload failed|failed to upload|unsupported file|file.*too large|attachment.*limit|上传失败|不支持.*(文件|格式)|文件.*过大|附件.*上限/i.test(text))?.trim();
}
export async function museUploadPending(page: Page): Promise<boolean> {
  return await (await composerScope(page)).locator('[role="progressbar"], [aria-busy="true"], [data-uploading="true"]').count() > 0;
}
async function composerScope(page: Page): Promise<Locator> {
  const form = page.locator("form").filter({ has: page.locator(museComposerSelector) }).filter({ visible: true }).first();
  return await form.count() ? form : page.locator("body");
}
async function attachmentCount(page: Page): Promise<number> {
  return (await composerScope(page)).locator('button[aria-label*="移除附件"], button[aria-label*="删除附件"], button[aria-label*="删除文件"], button[aria-label*="Remove attachment" i], button[aria-label*="Remove file" i]')
    .filter({ visible: true }).count();
}
async function candidates(page: Page) {
  const all = await (await composerScope(page)).locator('input[type="file"]').all(), result: Locator[] = [];
  for (const input of all) if (!await input.evaluate(el => !!el.closest('[class*="chat-user-bubble"], [class*="hatch-agent-bubble-bg"]'))) result.push(input);
  return result;
}
/** Preserve file order and the website's own accept/multiple contract. */
export async function uploadMuseReferences(page: Page, files: MuseUploadFile[], closing: () => boolean, options: { append?: boolean } = {}) {
  const valid = () => { if (closing() || page.isClosed()) throw new MuseUploadError("Muse 连接已关闭，尚未发送生成请求。"); };
  valid();
  const before = await attachmentCount(page);
  if (before && !options.append) throw new MuseUploadError("Muse 输入框中已有未发送附件，请在画布中的 Muse 聊天窗口确认或清除后再生成。");
  if (!files.length) return;
  let inputs = await candidates(page);
  if (!inputs.length) {
    await (await composerScope(page)).getByRole("button", { name: /附加文件|添加附件|attach file|attach files/i }).first().click();
    inputs = await candidates(page);
  }
  const payload = (file: MuseUploadFile) => file.path || { name: file.name, mimeType: file.mime, buffer: Buffer.from(file.dataBase64!, "base64") };
  const choose = async (batch: MuseUploadFile[]) => {
    for (const input of inputs) {
      if (batch.length > 1 && await input.getAttribute("multiple") === null) continue;
      const accept = await input.getAttribute("accept") ?? "";
      if (batch.every(file => museFileAccepts(accept, file))) return input;
    }
  };
  const ready = async (count: number) => {
    while (true) {
      valid();
      const error = await museUploadError(page); if (error) throw new MuseUploadError(error);
      if (await attachmentCount(page) >= count && !await museUploadPending(page)) return;
      await pause();
    }
  };
  const combined = await choose(files);
  if (combined) {
    valid();
    // Playwright accepts either all paths or all buffers, not mixed arrays.
    if (files.every(file => file.path)) await combined.setInputFiles(files.map(file => file.path!));
    else if (files.every(file => !file.path)) await combined.setInputFiles(files.map(file => payload(file) as {name:string;mimeType:string;buffer:Buffer}));
    else { inputs = await candidates(page); }
    if (files.every(file => file.path) || files.every(file => !file.path)) { await ready(before + files.length); return; }
  }
  for (let index = 0; index < files.length; index++) {
    valid(); inputs = await candidates(page);
    const input = await choose([files[index]]);
    if (!input) throw new MuseUploadError("当前 Muse 上传入口未接受此素材格式：" + files[index].mime + "。请在画布中的 Muse 聊天窗口查看平台支持的格式。");
    await input.setInputFiles(payload(files[index]));
    await ready(before + index + 1);
  }
}
