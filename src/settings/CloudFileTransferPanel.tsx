import { useEffect, useRef, useState, type DragEvent } from "react";
import { createLocalTransferDrag, isLocalTransferDrag, localTransferDragType, type LocalTransferDrag } from "./cloud-transfer-drag";
import { ArrowUp, File, FolderOpen, Link2, LoaderCircle, LogOut, RefreshCw, ShieldCheck, Upload, X } from "lucide-react";
import "./cloud-file-transfer.css";

type Bucket = { id: string; label: string; path: string };
type Entry = { name: string; path: string; directory: boolean; size: number; symlink?: boolean };
type Listing = { path: string; parent: string | null; entries: Entry[] };
type Session = { sessionId: string; hostKey: string; fingerprint: string; host: string; port: number; username: string; path: string };
type Job = { id: string; status: string; bytes: number; totalBytes: number; files: number; totalFiles: number; bytesPerSecond?: number; error?: string };
type Connection = { host: string; port: string; username: string; comfyRoot: string };
type Trust = { hostKey: string; fingerprint: string };
type Challenge = Trust & { code: string; expected?: string };
const settingsKey = "canvas.cloud-file-transfer.connection.v2";
const trustKey = "canvas.cloud-file-transfer.trusted-hosts.v1";
const apiRoot = "/__canvas/cloud-files";
const defaults: Connection = { host: "", port: "22", username: "root", comfyRoot: "/root/ComfyUI" };
let retainedSession: Session | null = null;
let retainedJobs: Job[] = [];
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function count(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0; }
function loadSettings(): Connection {
  try {
    // Only non-secret fields migrate from the earlier connection form.
    for (const key of [settingsKey, "canvas.external-filezilla.connection.v1", "canvas.cloud-file-transfer.connection.v1"]) {
      const value: unknown = JSON.parse(localStorage.getItem(key) || "null");
      if (object(value)) return { host: text(value.host), port: text(value.port) || "22", username: text(value.username) || "root", comfyRoot: text(value.comfyRoot) || defaults.comfyRoot };
    }
  } catch { /* A storage restriction should not prevent a session connection. */ }
  return defaults;
}
function readTrust(): Record<string, Trust> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(trustKey) || "{}");
    if (object(value)) return Object.fromEntries(Object.entries(value).filter(([, item]) => object(item) && text(item.hostKey) && text(item.fingerprint))) as Record<string, Trust>;
  } catch { /* Trust can be confirmed again when storage is unavailable. */ }
  return {};
}
class TransferError extends Error {
  code: string;
  hostKey: string;
  fingerprint: string;
  constructor(message: string, body?: Record<string, unknown>) { super(message); this.code = text(body?.code); this.hostKey = text(body?.hostKey); this.fingerprint = text(body?.fingerprint); }
}
async function api(path: string, body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let response: Response;
  try { response = await fetch(`${apiRoot}/${path}`, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal }); }
  catch (error) { if (error instanceof DOMException && error.name === "AbortError") throw error; throw new Error("无法连接本地文件传输服务，请确认画布服务正在运行。"); }
  let value: unknown;
  try { value = JSON.parse(await response.text()); } catch { throw new Error("本地文件传输服务尚未启动，请更新并启动画布服务后重试。"); }
  if (!object(value)) throw new Error("文件传输服务返回了无效数据，请重试。");
  if (!response.ok) throw new TransferError(text(value.error) || (response.status === 404 ? "本地文件传输服务尚未启动，请更新并启动画布服务后重试。" : `文件传输请求失败（${response.status}）。`), value);
  return value;
}
function listing(value: Record<string, unknown>): Listing {
  if (typeof value.path !== "string" || !Array.isArray(value.entries)) throw new Error("目录数据不完整，请刷新目录。");
  const entries = value.entries.map((item: unknown): Entry => {
    if (!object(item) || typeof item.name !== "string" || typeof item.path !== "string" || typeof item.directory !== "boolean" || item.symlink !== undefined && typeof item.symlink !== "boolean") throw new Error("目录条目无效，请刷新目录。");
    return { name: item.name, path: item.path, directory: item.directory, size: count(item.size), ...(item.symlink === true ? { symlink: true } : {}) };
  });
  return { path: value.path, parent: typeof value.parent === "string" ? value.parent : null, entries };
}
function jobs(value: Record<string, unknown>): Job[] {
  if (!Array.isArray(value.jobs)) throw new Error("上传队列数据无效，请刷新队列确认。");
  return value.jobs.map((item: unknown) => {
    if (!object(item) || typeof item.id !== "string" || typeof item.status !== "string") throw new Error("上传任务数据无效。");
    return { id: item.id, status: item.status, bytes: count(item.bytes), totalBytes: count(item.totalBytes), files: count(item.files), totalFiles: count(item.totalFiles), ...(typeof item.bytesPerSecond === "number" && Number.isFinite(item.bytesPerSecond) && item.bytesPerSecond >= 0 ? { bytesPerSecond: item.bytesPerSecond } : {}), error: text(item.error) };
  });
}
function active(job: Job) { return job.status === "receiving" || job.status === "queued" || job.status === "uploading" || job.status === "cancelling"; }
function bytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${(value / 1024 ** 3).toFixed(2)} GB`; }
function join(root: string, suffix: string) { return `${root.replace(/\/+$/, "")}/${suffix}`; }

export default function CloudFileTransferPanel({ onBack }: { onBack?: () => void }) {
  const [connection, setConnection] = useState(loadSettings);
  const [password, setPassword] = useState("");
  const [rememberPassword, setRememberPassword] = useState(true);
  const [savedPasswordAddress, setSavedPasswordAddress] = useState<string | null>(null);
  const [forgettingPassword, setForgettingPassword] = useState(false);
  const [privateKey, setPrivateKey] = useState("");
  const [privateKeyName, setPrivateKeyName] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [session, setSession] = useState<Session | null>(retainedSession);
  const [queue, setQueue] = useState<Job[]>(retainedJobs);
  const [localRoot, setLocalRoot] = useState("");
  const [engine, setEngine] = useState<{ available: boolean; name: string; version: string } | null>(null);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [bucket, setBucket] = useState("");
  const [local, setLocal] = useState<Listing | null>(null);
  const [remote, setRemote] = useState<Listing | null>(null);
  const [remotePath, setRemotePath] = useState(retainedSession?.path || "/");
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const localDrag = useRef<{ payload: LocalTransferDrag; sessionId: string | null } | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const mounted = useRef(true);
  const localRequest = useRef(0), remoteRequest = useRef(0), jobsRequest = useRef(0), privateKeyRequest = useRef(0);
  const connectLock = useRef(false), uploadLock = useRef(false);
  const connectRequest = useRef(0);
  const passwordLookup = useRef(0);
  const connectController = useRef<AbortController | null>(null);
  const sessionRef = useRef(session);
  const controllers = useRef(new Set<AbortController>());
  const keyInput = useRef<HTMLInputElement>(null);
  sessionRef.current = session;
  const hasActiveJobs = queue.some(active);
  const confirmedRemotePath = !!remote && remotePath.trim() === remote.path;
  const passwordAddress = JSON.stringify([connection.host.trim().toLowerCase(), Number(connection.port), connection.username.trim()]);
  const hasSavedPassword = savedPasswordAddress === passwordAddress;

  useEffect(() => {
    const generation = ++passwordLookup.current;
    const host = connection.host.trim(), port = Number(connection.port), username = connection.username.trim();
    if (!host || /[\s/\\]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !username) return;
    const controller = new AbortController(); let current = true;
    void api("password-status", { host, port, username }, controller.signal).then(result => {
      if (current && generation === passwordLookup.current) setSavedPasswordAddress(result.saved === true ? passwordAddress : null);
    }).catch(reason => { if (current && generation === passwordLookup.current && !(reason instanceof DOMException && reason.name === "AbortError")) setError(reason instanceof Error ? reason.message : "无法读取已保存密码。"); });
    return () => { current = false; controller.abort(); };
  }, [connection.host, connection.port, connection.username, passwordAddress]);

  async function request(path: string, body?: unknown) {
    const controller = new AbortController(); controllers.current.add(controller);
    try { return await api(path, body, controller.signal); } finally { controllers.current.delete(controller); }
  }
  function fail(reason: unknown) {
    if (!mounted.current || reason instanceof DOMException && reason.name === "AbortError") return;
    if (reason instanceof TransferError && reason.code === "SESSION_EXPIRED") {
      retainedSession = null; retainedJobs = []; sessionRef.current = null; ++remoteRequest.current; ++jobsRequest.current;
      setSession(null); setRemote(null); setRemoteBusy(false); setQueue([]); setCancelling(new Set()); clearSecrets();
    }
    setError(reason instanceof Error ? reason.message : "操作失败，请重试。");
  }
  function clearSecrets() { ++privateKeyRequest.current; setPassword(""); setPrivateKey(""); setPrivateKeyName(""); setPassphrase(""); if (keyInput.current) keyInput.current.value = ""; }
  function saveConnection() { try { localStorage.setItem(settingsKey, JSON.stringify(connection)); } catch { /* The connection remains usable in this session. */ } }
  function changeConnection(key: keyof Connection, value: string) { setConnection(previous => ({ ...previous, [key]: value })); setChallenge(null); setError(""); }
  async function refreshLocal(nextBucket = bucket, path = local?.path || "") {
    if (!nextBucket) return;
    const generation = ++localRequest.current; setLocalBusy(true); setError("");
    try { const result = listing(await request("local", { bucket: nextBucket, path })); if (mounted.current && generation === localRequest.current) { setLocal(result); setSelection(new Set()); } }
    catch (reason) { if (generation === localRequest.current) fail(reason); }
    finally { if (mounted.current && generation === localRequest.current) setLocalBusy(false); }
  }
  async function refreshRemote(path = remotePath, current = sessionRef.current) {
    if (!current) return;
    if (!path.startsWith("/")) { setError("云端目录必须以 / 开头，例如 /root/ComfyUI。"); return; }
    const generation = ++remoteRequest.current; setRemoteBusy(true); setError("");
    try {
      const result = listing(await request("remote", { sessionId: current.sessionId, path }));
      if (!mounted.current || generation !== remoteRequest.current || sessionRef.current?.sessionId !== current.sessionId) return;
      setRemote(result); setRemotePath(result.path); retainedSession = { ...current, path: result.path };
    } catch (reason) { if (generation === remoteRequest.current) fail(reason); }
    finally { if (mounted.current && generation === remoteRequest.current) setRemoteBusy(false); }
  }
  async function refreshJobs(current = sessionRef.current) {
    if (!current) return;
    const generation = ++jobsRequest.current;
    try { const result = jobs(await request("jobs", { sessionId: current.sessionId })); if (mounted.current && generation === jobsRequest.current && sessionRef.current?.sessionId === current.sessionId) { retainedJobs = result; setQueue(result); } }
    catch (reason) { if (generation === jobsRequest.current && sessionRef.current?.sessionId === current.sessionId) fail(reason); }
  }
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        const result = await request("status");
        if (!mounted.current) return;
        if (typeof result.localRoot !== "string" || !Array.isArray(result.buckets)) throw new Error("本地文件目录配置无效。");
        const available = result.buckets.map((item: unknown): Bucket => {
          if (!object(item) || typeof item.id !== "string" || typeof item.label !== "string" || typeof item.path !== "string") throw new Error("本地文件分类配置无效。");
          return { id: item.id, label: item.label, path: item.path };
        });
        setLocalRoot(result.localRoot); setBuckets(available);
        if (typeof result.available === "boolean") setEngine({ available: result.available, name: text(result.engine), version: text(result.version) });
        if (available[0]) { setBucket(available[0].id); void refreshLocal(available[0].id, ""); }
      } catch (reason) { fail(reason); }
    })();
    const current = sessionRef.current;
    if (current) { void refreshRemote(current.path, current); void refreshJobs(current); }
    return () => {
      mounted.current = false; ++localRequest.current; ++remoteRequest.current; ++jobsRequest.current; ++privateKeyRequest.current;
      ++connectRequest.current; connectController.current?.abort(); connectController.current = null; connectLock.current = false;
      for (const controller of controllers.current) controller.abort(); controllers.current.clear();
      // Uploads continue on the service when this panel closes. Authentication
      // Passwords are kept by the local encrypted store, never browser storage.
    };
    // Initial state is restored once per mount; navigation refreshes explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!session) return;
    let running = false;
    const timer = window.setInterval(() => { if (running) return; running = true; void refreshJobs(session).finally(() => { running = false; }); }, hasActiveJobs ? 2000 : 10_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.sessionId, hasActiveJobs]);

  async function connect(trustedHostKey?: string) {
    if (connectLock.current || sessionRef.current || engine?.available === false) return;
    const host = connection.host.trim(), port = Number(connection.port), username = connection.username.trim();
    if (!host || /[\s/\\]/.test(host) || host.includes("://")) { setError("请填写 SFTP 主机名或 IP，不要填写 ComfyUI 的 http 地址。"); return; }
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !username) { setError("请填写有效的 SSH 端口（1–65535）和用户名。"); return; }
    if (!password && !privateKey && !hasSavedPassword) { setError("请填写 SSH 密码或选择 SSH 私钥。"); return; }
    const generation = ++connectRequest.current, controller = new AbortController(); connectController.current = controller;
    connectLock.current = true; setConnecting(true); setError(""); setNotice("");
    const address = `${host}:${port}`, savedTrust = readTrust()[address];
    try {
      const result = await api("connect", { host, port, username, rememberPassword, useSavedPassword: !password && !privateKey && hasSavedPassword, ...(password ? { password } : {}), ...(privateKey ? { privateKey } : {}), ...(passphrase ? { passphrase } : {}), ...(trustedHostKey || savedTrust?.hostKey ? { hostKey: trustedHostKey || savedTrust?.hostKey } : {}) }, controller.signal);
      if (!text(result.sessionId) || !text(result.hostKey) || !text(result.fingerprint)) {
        if (typeof result.sessionId === "string") void api("disconnect", { sessionId: result.sessionId }).catch(() => undefined);
        throw new Error("SFTP 连接信息不完整，请重新连接。");
      }
      const next: Session = { sessionId: text(result.sessionId), hostKey: text(result.hostKey), fingerprint: text(result.fingerprint), host, port, username, path: text(result.path) || "/" };
      if ((trustedHostKey || savedTrust?.hostKey) && next.hostKey !== (trustedHostKey || savedTrust?.hostKey)) {
        void api("disconnect", { sessionId: next.sessionId }).catch(() => undefined);
        throw new TransferError("主机指纹发生变化，请重新核对。", { code: "HOST_KEY_MISMATCH", hostKey: next.hostKey, fingerprint: next.fingerprint });
      }
      if (!mounted.current || generation !== connectRequest.current) { void api("disconnect", { sessionId: next.sessionId }).catch(() => undefined); return; }
      if (trustedHostKey) { try { localStorage.setItem(trustKey, JSON.stringify({ ...readTrust(), [address]: { hostKey: next.hostKey, fingerprint: next.fingerprint } })); } catch { /* Trust remains valid for the current session. */ } }
      retainedSession = next; retainedJobs = []; sessionRef.current = next; setSession(next); setQueue([]); setCancelling(new Set());
      if (result.passwordSaved === true) { ++passwordLookup.current; setSavedPasswordAddress(passwordAddress); }
      saveConnection(); clearSecrets(); setChallenge(null); setRemotePath(next.path); setNotice(text(result.passwordWarning) || `SFTP 已连接。${result.passwordSaved === true ? "密码已加密保存在本机，下次无需重新输入。" : ""}将左侧文件拖到右侧云端目录，或勾选后点击上传。`);
      void refreshRemote(next.path, next); void refreshJobs(next);
    } catch (reason) {
      if (!mounted.current || generation !== connectRequest.current) return;
      if (reason instanceof TransferError && (reason.code === "HOST_KEY_REQUIRED" || reason.code === "HOST_KEY_MISMATCH") && reason.hostKey && reason.fingerprint) setChallenge({ code: reason.code, hostKey: reason.hostKey, fingerprint: reason.fingerprint, expected: savedTrust?.fingerprint });
      else fail(reason);
    } finally { if (generation === connectRequest.current) { connectLock.current = false; connectController.current = null; if (mounted.current) setConnecting(false); } }
  }
  function cancelConnect() {
    ++connectRequest.current; connectController.current?.abort(); connectController.current = null; connectLock.current = false;
    setConnecting(false); setChallenge(null); clearSecrets(); setError(""); setNotice("已取消连接。");
  }
  async function forgetPassword() {
    if (forgettingPassword || connecting) return;
    ++passwordLookup.current; setForgettingPassword(true); setError("");
    try {
      await request("forget-password", { host: connection.host.trim(), port: Number(connection.port), username: connection.username.trim() });
      if (mounted.current) { setSavedPasswordAddress(null); setPassword(""); setNotice("已清除这组云端连接保存在本机的密码。"); }
    } catch (reason) { fail(reason); } finally { if (mounted.current) setForgettingPassword(false); }
  }
  async function disconnect() {
    if (!session || hasActiveJobs || uploadLock.current) return;
    setDisconnecting(true); setError("");
    try {
      await api("disconnect", { sessionId: session.sessionId }); retainedSession = null; retainedJobs = []; sessionRef.current = null;
      if (!mounted.current) return;
      ++remoteRequest.current; ++jobsRequest.current; setRemoteBusy(false); setSession(null); setRemote(null); setQueue([]); setCancelling(new Set()); clearSecrets(); setNotice("SFTP 已断开。");
    } catch (reason) { fail(reason); } finally { if (mounted.current) setDisconnecting(false); }
  }
  async function upload(paths = [...selection], destination = remote?.path, sourceBucket = bucket) {
    const current = sessionRef.current;
    if (!current || !remote || !confirmedRemotePath || !paths.length || !sourceBucket || !destination || localBusy || remoteBusy || disconnecting || uploadLock.current) return;
    // The destination must come from the currently confirmed directory listing,
    // never from arbitrary drag text or an unconfirmed path input.
    if (destination !== remote.path && !remote.entries.some(entry => entry.directory && !entry.symlink && entry.path === destination)) return;
    uploadLock.current = true; setUploading(true); setError(""); setNotice("");
    try {
      const result = await request("upload", { sessionId: current.sessionId, bucket: sourceBucket, paths, remotePath: destination });
      if (typeof result.jobId !== "string") throw new Error("上传任务信息不完整，请刷新上传队列确认。");
      if (!mounted.current || sessionRef.current?.sessionId !== current.sessionId) return;
      const queued: Job = { id: result.jobId, status: "queued", bytes: 0, totalBytes: 0, files: 0, totalFiles: 0 };
      retainedJobs = [...retainedJobs.filter(job => job.id !== queued.id), queued]; setQueue(retainedJobs);
      setNotice(`已加入上传队列，目标：${destination}`); await refreshJobs(current);
    } catch (reason) { fail(reason); } finally { uploadLock.current = false; if (mounted.current) setUploading(false); }
  }
  function startLocalDrag(event: DragEvent<HTMLDivElement>, entry: Entry) {
    event.stopPropagation();
    if (localBusy || uploading || disconnecting) { event.preventDefault(); return; }
    const payload = createLocalTransferDrag(bucket, entry.path, selection);
    localDrag.current = { payload, sessionId: sessionRef.current?.sessionId || null };
    setSelection(new Set(payload.paths));
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(localTransferDragType, JSON.stringify(payload));
  }
  function endLocalDrag() { localDrag.current = null; setDropTarget(null); }
  function acceptsLocalDrag(event: DragEvent) {
    return !!localDrag.current && event.dataTransfer.types.includes(localTransferDragType);
  }
  function readyForDrop() {
    return !!sessionRef.current && confirmedRemotePath && !localBusy && !remoteBusy && !uploading && !disconnecting && !uploadLock.current && localDrag.current?.sessionId === sessionRef.current.sessionId;
  }
  function overRemote(event: DragEvent, destination: string | undefined) {
    if (!acceptsLocalDrag(event)) return;
    event.preventDefault(); event.stopPropagation();
    const ready = readyForDrop() && !!destination;
    event.dataTransfer.dropEffect = ready ? "copy" : "none";
    setDropTarget(ready ? destination : null);
  }
  function dropRemote(event: DragEvent, destination: string | undefined) {
    if (!acceptsLocalDrag(event)) return;
    event.preventDefault(); event.stopPropagation();
    const source = localDrag.current;
    const accepted = readyForDrop() && !!destination && !!source && isLocalTransferDrag(event.dataTransfer.getData(localTransferDragType), source.payload);
    endLocalDrag();
    if (accepted && source) void upload(source.payload.paths, destination, source.payload.bucket);
    else setError("请先连接 SFTP 并打开云端目标目录，再拖动左侧文件上传。");
  }
  function blockOutsideDrop(event: DragEvent) {
    if (!event.dataTransfer.types.includes(localTransferDragType) && !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "none";
  }
  async function cancel(job: Job) {
    const current = sessionRef.current;
    if (!current || !active(job) || cancelling.has(job.id)) return;
    setCancelling(previous => new Set(previous).add(job.id)); setError("");
    try {
      await request("cancel", { sessionId: current.sessionId, jobId: job.id });
      if (!mounted.current || sessionRef.current?.sessionId !== current.sessionId) return;
      setNotice("已请求取消上传，已经传输的文件可能仍保留在云端。"); await refreshJobs(current);
    } catch (reason) { fail(reason); }
    finally { if (mounted.current) setCancelling(previous => { const next = new Set(previous); next.delete(job.id); return next; }); }
  }
  async function readPrivateKey(file?: globalThis.File) {
    const generation = ++privateKeyRequest.current; setPrivateKey(""); setPrivateKeyName(""); setChallenge(null);
    if (!file) return;
    if (file.size > 1024 * 1024) { setError("私钥文件不能大于 1 MB，请确认所选文件。"); if (keyInput.current) keyInput.current.value = ""; return; }
    try { const value = await file.text(); if (mounted.current && generation === privateKeyRequest.current) { setPrivateKey(value); setPrivateKeyName(file.name); setError(""); } }
    catch { if (mounted.current && generation === privateKeyRequest.current) setError("无法读取私钥文件，请重新选择。"); }
  }
  const currentBucket = buckets.find(item => item.id === bucket);
  const statusNames: Record<string, string> = { receiving: "接收本地文件", queued: "排队中", uploading: "上传中", cancelling: "取消中", completed: "已完成", failed: "失败", cancelled: "已取消" };

  return <section className="cloud-file-transfer" aria-label="云端文件传输"
    onDragOver={blockOutsideDrop}
    onDrop={event => { blockOutsideDrop(event); if (event.dataTransfer.types.includes(localTransferDragType)) { endLocalDrag(); setError("请将左侧文件拖到右侧云端目录上传。"); } }}>
    <header className="cft-heading"><div><h3>云端文件传输</h3><p>将左侧已有文件或文件夹拖到右侧云端目录上传，也可勾选多项后一起拖动。</p></div>{onBack && <button type="button" onClick={onBack}>返回连接设置</button>}</header>
    {engine && <p className={`cft-engine-state${engine.available ? "" : " cft-engine-unavailable"}`} role="status">{engine.available ? `传输引擎：${engine.name || "已就绪"}${engine.version ? " · " + engine.version : ""}` : "本地传输引擎尚未就绪，请检查本地服务。"}</p>}
    <details className="cft-connection" open={!session}>
      <summary><span>{session ? `已连接 ${session.username}@${session.host}:${session.port}` : "SFTP 连接设置"}</span>{session && <small>SSH 指纹已核对</small>}</summary>
      <p className="cft-help">填写云端控制台提供的 SSH / SFTP 地址与端口；ComfyUI 网页连接与文件传输分别配置。</p>
      <form onSubmit={event => { event.preventDefault(); void connect(); }}>
        <fieldset disabled={!!session || connecting || forgettingPassword} className="cft-connection-fields">
          <label className="cft-host">主机 / IP<input aria-label="SFTP 主机" value={connection.host} onChange={event => changeConnection("host", event.target.value)} placeholder="云端 SSH 主机，不是网页地址" autoComplete="off" spellCheck={false} /></label>
          <label>SSH 端口<input aria-label="SFTP 端口" inputMode="numeric" value={connection.port} onChange={event => changeConnection("port", event.target.value)} autoComplete="off" /></label>
          <label>用户名<input aria-label="SFTP 用户名" value={connection.username} onChange={event => changeConnection("username", event.target.value)} autoComplete="off" spellCheck={false} /></label>
          <label className="cft-password">密码<input aria-label="SFTP 密码" type="password" value={password} onChange={event => { setPassword(event.target.value); setChallenge(null); }} autoComplete="new-password" placeholder={hasSavedPassword ? "已保存；留空使用，输入可更新" : "输入 SSH 密码"} /></label>
        </fieldset>
        <div className="cft-password-storage"><label><input type="checkbox" checked={rememberPassword} disabled={!!session || connecting || forgettingPassword} onChange={event => setRememberPassword(event.target.checked)} />保存密码到本机</label><small>{hasSavedPassword ? "此主机、端口和用户名的密码已保存，刷新或重启后仍可使用。" : "连接成功后加密保存，下次连接无需再次输入。"}</small>{hasSavedPassword && <button type="button" disabled={connecting || forgettingPassword} onClick={() => void forgetPassword()}>{forgettingPassword ? "正在清除…" : "清除已保存密码"}</button>}</div>
        {!session && <details className="cft-private-key"><summary>使用 SSH 私钥</summary><div><label>私钥文件<input ref={keyInput} aria-label="SSH 私钥文件" type="file" disabled={connecting} onChange={event => void readPrivateKey(event.target.files?.[0])} /></label><label>私钥口令（如有）<input aria-label="SSH 私钥口令" type="password" value={passphrase} disabled={connecting} onChange={event => setPassphrase(event.target.value)} autoComplete="new-password" /></label></div>{privateKeyName && <small>已选择 {privateKeyName}；连接后清除私钥内容。</small>}</details>}
        {!session && <div className="cft-connect-actions"><small>连接配置保存在本机；密码使用当前 Windows 用户加密保存。</small>{connecting && <button type="button" onClick={cancelConnect}><X size={15} />取消连接</button>}<button type="submit" className="cft-primary" disabled={connecting || forgettingPassword || engine?.available === false}>{connecting ? <LoaderCircle className="cft-spin" size={15} /> : <ShieldCheck size={15} />}连接 SFTP</button></div>}
      </form>
      {session && <p className="cft-fingerprint">主机指纹：<code>{session.fingerprint}</code></p>}
    </details>
    {challenge && <div className="cft-host-challenge" role="alert"><strong>{challenge.code === "HOST_KEY_MISMATCH" ? "主机指纹发生变化" : "首次连接：请核对主机指纹"}</strong><p>请与云端控制台或服务器管理员提供的 SSH 指纹核对，确认一致后再连接。</p>{challenge.expected && <p>原指纹：<code>{challenge.expected}</code></p>}<p>当前指纹：<code>{challenge.fingerprint}</code></p><div><button type="button" disabled={connecting} onClick={() => { setChallenge(null); clearSecrets(); }}>取消</button><button type="button" className="cft-primary" disabled={connecting} onClick={() => void connect(challenge.hostKey)}>{connecting && <LoaderCircle className="cft-spin" size={15} />}已核对，信任此指纹并连接</button></div></div>}
    <div className="cft-root-setting"><label>云端 ComfyUI 根目录<input aria-label="云端 ComfyUI 根目录" value={connection.comfyRoot} onChange={event => changeConnection("comfyRoot", event.target.value)} onBlur={saveConnection} spellCheck={false} /></label><small>用于快捷打开节点和 LoRA 目录，也可直接填写其他目标目录。</small>{session && <button type="button" disabled={hasActiveJobs || disconnecting || uploading} onClick={() => void disconnect()} title={hasActiveJobs ? "请先取消或等待上传结束" : "断开 SFTP"}><LogOut size={15} />断开</button>}</div>
    {error && <p className="cft-feedback cft-error" role="alert">{error}</p>}{notice && <p className="cft-feedback" role="status">{notice}</p>}
    <div className="cft-panes">
      <section className="cft-pane" aria-label="本地文件"><header><h4>本地文件</h4><button type="button" aria-label="刷新本地目录" disabled={!bucket || localBusy} onClick={() => void refreshLocal()}><RefreshCw size={15} className={localBusy ? "cft-spin" : ""} /></button></header>
        <label className="cft-bucket-label">文件分类<select aria-label="本地文件分类" value={bucket} onChange={event => { const value = event.target.value; setBucket(value); setLocal(null); setSelection(new Set()); void refreshLocal(value, ""); }}>{buckets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <p className="cft-local-location" title={currentBucket?.path || localRoot}>{currentBucket?.path || localRoot || "正在读取本地目录…"}</p>
        <div className="cft-pathbar"><button type="button" aria-label="本地上一级目录" disabled={!local || local.parent === null || localBusy} onClick={() => void refreshLocal(bucket, local?.parent || "")}><ArrowUp size={15} /></button><span title={local?.path || "根目录"}>{local?.path || "根目录"}</span></div>
        <div className="cft-file-list" aria-busy={localBusy}>{local?.entries.map(entry => <div className={`cft-file-row cft-local-row${selection.has(entry.path) ? " cft-selected-row" : ""}`} key={entry.path} draggable={!localBusy && !uploading && !disconnecting} onDragStart={event => startLocalDrag(event, entry)} onDragEnd={endLocalDrag}><input type="checkbox" aria-label={`选择${entry.directory ? "文件夹" : "文件"} ${entry.name}`} checked={selection.has(entry.path)} onChange={event => setSelection(previous => { const next = new Set(previous); if (event.target.checked) next.add(entry.path); else next.delete(entry.path); return next; })} />{entry.directory ? <FolderOpen size={16} /> : <File size={16} />}{entry.directory ? <button type="button" className="cft-file-name" title={entry.name} disabled={localBusy} onClick={() => void refreshLocal(bucket, entry.path)}>{entry.name}</button> : <span className="cft-file-name" title={entry.name}>{entry.name}</span>}<small>{entry.directory ? "文件夹" : bytes(entry.size)}</small></div>)}{local && !local.entries.length && <p className="cft-empty">此目录为空，请先把需要上传的文件放入这个本地文件夹。</p>}{!local && <p className="cft-empty">{localBusy ? "正在读取…" : "本地目录尚未就绪"}</p>}</div>
        <footer><span>已选 {selection.size} 项</span><button type="button" disabled={!selection.size} onClick={() => setSelection(new Set())}>清空选择</button></footer>
      </section>
      <section className={`cft-pane${dropTarget && dropTarget === remote?.path ? " cft-drop-target" : ""}`} aria-label="云端文件"
        onDragEnter={event => overRemote(event, remote?.path)} onDragOver={event => overRemote(event, remote?.path)}
        onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(null); }}
        onDrop={event => dropRemote(event, remote?.path)}><header><h4>云端目录</h4><button type="button" aria-label="刷新云端目录" disabled={!session || remoteBusy} onClick={() => void refreshRemote(remote?.path || remotePath)}><RefreshCw size={15} className={remoteBusy ? "cft-spin" : ""} /></button></header>
        <form className="cft-remote-path" onSubmit={event => { event.preventDefault(); void refreshRemote(); }}><input aria-label="云端目标目录" value={remotePath} onChange={event => setRemotePath(event.target.value)} disabled={!session} placeholder="/root/ComfyUI" spellCheck={false} /><button type="submit" disabled={!session || remoteBusy}>打开</button></form>
        <div className="cft-presets"><button type="button" disabled={!session || remoteBusy} onClick={() => void refreshRemote(connection.comfyRoot)}>ComfyUI</button><button type="button" disabled={!session || remoteBusy} onClick={() => void refreshRemote(join(connection.comfyRoot, "custom_nodes"))}>节点</button><button type="button" disabled={!session || remoteBusy} onClick={() => void refreshRemote(join(connection.comfyRoot, "models/loras"))}>LoRA</button></div>
        <div className="cft-pathbar"><button type="button" aria-label="云端上一级目录" disabled={!session || !remote?.parent || remoteBusy} onClick={() => void refreshRemote(remote?.parent || "/")}><ArrowUp size={15} /></button><span title={remote?.path}>{remote?.path || (session ? "尚未打开目录" : "尚未连接")}</span></div>
        <div className="cft-file-list" aria-busy={remoteBusy}>{remote?.entries.map(entry => <div className={`cft-file-row cft-remote-row${dropTarget === entry.path ? " cft-drop-target" : ""}`} key={entry.path}
          onDragEnter={entry.directory && !entry.symlink ? event => overRemote(event, entry.path) : undefined}
          onDragOver={entry.directory && !entry.symlink ? event => overRemote(event, entry.path) : undefined}
          onDrop={entry.directory && !entry.symlink ? event => dropRemote(event, entry.path) : undefined}>{entry.symlink ? <Link2 size={16} /> : entry.directory ? <FolderOpen size={16} /> : <File size={16} />}{entry.directory || entry.symlink ? <button type="button" className="cft-file-name" title={entry.symlink ? "打开链接：" + entry.name : entry.name} disabled={remoteBusy} onClick={() => void refreshRemote(entry.path)}>{entry.name}</button> : <span className="cft-file-name" title={entry.name}>{entry.name}</span>}<small>{entry.symlink ? "链接" : entry.directory ? "文件夹" : bytes(entry.size)}</small></div>)}{remote && !remote.entries.length && <p className="cft-empty">此云端目录为空。</p>}{!remote && <p className="cft-empty">{remoteBusy ? "正在读取…" : session ? "输入云端路径后点击打开。" : "连接 SFTP 后浏览云端目录。"}</p>}</div>
        <footer><span>{dropTarget ? `松开后上传到：${dropTarget}` : `上传目标：${remote?.path || "请先打开目录"}`}</span></footer>
      </section>
    </div>
    <div className="cft-upload-actions"><p>{remote && !confirmedRemotePath ? "目标路径已修改，请先点击“打开”确认目录，再上传。" : "左侧文件可拖到右侧空白处或文件夹上传，文件夹会递归传输。同名文件不会覆盖；节点依赖仍需在云端安装。"}</p><button type="button" className="cft-primary" disabled={!session || !confirmedRemotePath || !selection.size || localBusy || remoteBusy || uploading || disconnecting} onClick={() => void upload()}>{uploading ? <LoaderCircle className="cft-spin" size={16} /> : <Upload size={16} />}上传所选 {selection.size || ""} 项</button></div>
    <section className="cft-queue" aria-label="上传队列"><header><h4>上传队列</h4><button type="button" disabled={!session} onClick={() => void refreshJobs()}><RefreshCw size={14} />刷新</button></header>{queue.length ? queue.map(job => <div className={`cft-job cft-job-${job.status}`} key={job.id}><div><strong>{statusNames[job.status] || job.status}</strong><span>{job.files}/{job.totalFiles} 个文件 · {bytes(job.bytes)} / {bytes(job.totalBytes)}{job.bytesPerSecond !== undefined && job.status !== "queued" && job.status !== "receiving" ? ` · 平均 ${bytes(job.bytesPerSecond)}/s` : ""}</span>{active(job) && <button type="button" disabled={cancelling.has(job.id) || job.status === "cancelling"} onClick={() => void cancel(job)} aria-label={`取消上传任务 ${job.id}`}>{cancelling.has(job.id) ? <LoaderCircle className="cft-spin" size={13} /> : <X size={13} />}取消</button>}</div><progress max={Math.max(job.totalBytes, 1)} value={job.status === "completed" ? Math.max(job.totalBytes, 1) : Math.min(job.bytes, Math.max(job.totalBytes, 1))} aria-label={`上传任务${statusNames[job.status] || job.status}`} />{job.error && <p role="alert">{job.error}</p>}</div>) : <p className="cft-empty">暂无上传任务</p>}{hasActiveJobs && <small>关闭设置后上传会继续，重新打开可查看进度。</small>}</section>
    <details className="cft-open-source"><summary>开源组件与许可</summary><p>文件传输直接使用 FileZilla Client 官方引擎源码构建。FileZilla、fzSSH、libfilezilla 与 Nettle 的源码、许可和构建说明保留在 native/cloud-transfer。</p><p>This software incorporates components from fzssh, copyright (c) 2025-2026 Tim Kosse and Business Follows Srl.</p><p><a href="https://filezilla-project.org/" target="_blank" rel="noreferrer">FileZilla Client</a> · GPL-3.0-or-later；<a href="https://fzssh.filezilla-project.org/" target="_blank" rel="noreferrer">fzSSH</a> · AGPL-3.0-or-later（含上游附加条款）。</p></details>
  </section>;
}
