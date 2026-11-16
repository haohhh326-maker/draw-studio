import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { serviceDataRoot } from "./service-data-root";

export type PasswordIdentity = { host: string; port: number; username: string };
export interface CloudTransferPasswordStore {
  has(identity: PasswordIdentity): Promise<boolean>;
  read(identity: PasswordIdentity): Promise<string | undefined>;
  save(identity: PasswordIdentity, password: string): Promise<void>;
  forget(identity: PasswordIdentity): Promise<void>;
}
export type PasswordProtector = (operation: "protect" | "unprotect", value: string) => Promise<string>;
const script = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  $entropy = [System.Text.Encoding]::UTF8.GetBytes('DrawStudio.CloudTransfer.Password.v1')
  if ($request.operation -eq 'protect') {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($request.value)
    [Console]::Out.Write([Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)))
  } elseif ($request.operation -eq 'unprotect') {
    $bytes = [Convert]::FromBase64String($request.value)
    [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, $scope)))
  } else { exit 1 }
} catch { exit 1 }
`;
/** Password bytes travel over child stdin/stdout, never command arguments or logs. */
export const windowsPasswordProtector: PasswordProtector = async (operation, value) => {
  if (process.platform !== "win32") throw new Error("本机系统暂不支持加密保存 SFTP 密码。");
  return new Promise<string>((resolve, reject) => {
    const child = spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const failure = () => reject(new Error("无法读取或加密保存 SFTP 密码，请重新输入后重试。"));
    const chunks: Buffer[] = []; let size = 0;
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 65536) { child.kill(); failure(); } else chunks.push(chunk); });
    child.stderr.resume(); child.once("error", failure); child.stdin.once("error", failure);
    child.once("close", code => code === 0 ? resolve(Buffer.concat(chunks).toString("utf8")) : failure());
    child.stdin.end(JSON.stringify({ operation, value }));
  });
};
function profile(identity: PasswordIdentity) { return createHash("sha256").update(JSON.stringify([identity.host.toLowerCase(), identity.port, identity.username])).digest("hex"); }
export function createCloudTransferPasswordStore(options: { file?: string; protect?: PasswordProtector } = {}): CloudTransferPasswordStore {
  const file = options.file ?? path.join(serviceDataRoot(), "secrets", "sftp-passwords.v1.json");
  const protect = options.protect ?? windowsPasswordProtector;
  let queue = Promise.resolve();
  async function load(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      const values = parsed as Record<string, unknown>;
      if (Object.entries(values).some(([key, value]) => !/^[a-f0-9]{64}$/.test(key) || typeof value !== "string" || !value || value.length > 65536)) throw new Error();
      return values as Record<string, string>;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error("本机 SFTP 密码存储无法读取，请重新保存密码。"); }
  }
  async function update(change: (values: Record<string, string>) => Promise<void>) {
    const task = queue.then(async () => {
      const values = await load(); await change(values); await mkdir(path.dirname(file), { recursive: true });
      const temporary = file + "." + randomUUID() + ".tmp";
      try { await writeFile(temporary, JSON.stringify(values), { mode: 0o600, flag: "wx" }); await rename(temporary, file); }
      finally { await rm(temporary, { force: true }); }
    });
    queue = task.catch(() => undefined); await task;
  }
  return {
    async has(identity) { await queue; return !!(await load())[profile(identity)]; },
    async read(identity) { await queue; const value = (await load())[profile(identity)]; return value === undefined ? undefined : protect("unprotect", value); },
    async save(identity, password) { if (!password || password.length > 8192) throw new Error("SFTP 密码格式无效。"); await update(async values => { values[profile(identity)] = await protect("protect", password); }); },
    async forget(identity) { await update(async values => { delete values[profile(identity)]; }); },
  };
}
