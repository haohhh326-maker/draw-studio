import { randomUUID } from "node:crypto";
import type { Disposable, Page, WebSocket } from "playwright";

export type MusePageSignals = {
  revision(): number;
  wait(afterRevision: number, signal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
};

type PageSignalOptions = { bindingName: string; stateName: string };

// Playwright serializes this function into the page, including new documents.
function installPageSignals({ bindingName, stateName }: PageSignalOptions) {
  if (window.top !== window) return;
  const state = window as unknown as Record<string, unknown>;
  (state[stateName] as { dispose(): void } | undefined)?.dispose();
  let stopped = false;
  let queued = false;
  const notify = () => {
    if (stopped || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (stopped) return;
      const binding = state[bindingName];
      if (typeof binding === "function") void Promise.resolve().then(() => binding()).catch(() => {});
    });
  };
  const inComposer = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement;
    return !!element?.closest('form, input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]');
  };
  const observer = new MutationObserver(records => {
    const relevant = records.some(record => {
      if (inComposer(record.target)) return false;
      if (record.type !== "childList") return true;
      return [...record.addedNodes, ...record.removedNodes].some(node => !inComposer(node));
    });
    if (relevant) notify();
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "aria-busy", "disabled", "aria-disabled", "data-delivery-status",
      "data-hatch-avatar-status-pill-visible", "data-hatch-shell-hydration-state"],
  });
  const mediaEvents = ["load", "loadedmetadata", "loadeddata", "canplay", "error", "emptied"];
  const mediaChanged = (event: Event) => {
    const media = event.target;
    if ((media instanceof HTMLImageElement || media instanceof HTMLVideoElement) && !inComposer(media)) notify();
  };
  for (const event of mediaEvents) document.addEventListener(event, mediaChanged, true);
  state[stateName] = {
    dispose() {
      stopped = true;
      observer.disconnect();
      for (const event of mediaEvents) document.removeEventListener(event, mediaChanged, true);
      delete state[stateName];
    },
  };
}

/** Signals request another observation. Their contents never determine job state. */
export async function attachMusePageSignals(page: Page): Promise<MusePageSignals> {
  let currentRevision = 0;
  let disposed = false;
  let disposing: Promise<void> | undefined;
  let binding: Disposable | undefined;
  let initScript: Disposable | undefined;
  let observingDom = false;
  const suffix = randomUUID().replaceAll("-", "");
  const options = { bindingName: "__drawstudioMuseSignal_" + suffix, stateName: "__drawstudioMuseSignalState_" + suffix };
  const waiters = new Set<() => void>();
  const sockets = new Map<WebSocket, () => void>();
  const wake = () => {
    if (disposed) return;
    currentRevision++;
    for (const finish of [...waiters]) finish();
  };
  const socketOpened = (socket: WebSocket) => {
    if (disposed || sockets.has(socket)) return;
    const remove = () => {
      socket.off("framereceived", wake);
      socket.off("socketerror", wake);
      socket.off("close", closed);
      sockets.delete(socket);
    };
    const closed = () => { wake(); remove(); };
    sockets.set(socket, remove);
    socket.on("framereceived", wake);
    socket.on("socketerror", wake);
    socket.on("close", closed);
    wake();
  };
  page.on("websocket", socketOpened);
  page.on("requestfinished", wake);
  page.on("framenavigated", wake);
  page.on("close", wake);

  // Older service test pages implement only the event surface. Keep polling
  // available there, and while a real page is replacing its execution context.
  if (typeof page.exposeBinding === "function" && typeof page.addInitScript === "function") {
    try {
      binding = await page.exposeBinding(options.bindingName, wake);
      initScript = await page.addInitScript(installPageSignals, options);
      observingDom = true;
      await page.evaluate(installPageSignals, options);
    } catch { /* Page events and the existing polling interval remain usable. */ }
  }

  return {
    revision: () => currentRevision,
    wait(afterRevision, signal) {
      if (disposed || signal?.aborted || page.isClosed() || currentRevision !== afterRevision) return Promise.resolve();
      return new Promise<void>(resolve => {
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", finish);
          waiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, 1500);
        timer.unref?.();
        waiters.add(finish);
        signal?.addEventListener("abort", finish, { once: true });
        if (disposed || signal?.aborted || currentRevision !== afterRevision) finish();
      });
    },
    dispose() {
      if (disposing) return disposing;
      disposed = true;
      for (const finish of [...waiters]) finish();
      page.off("websocket", socketOpened);
      page.off("requestfinished", wake);
      page.off("framenavigated", wake);
      page.off("close", wake);
      for (const remove of [...sockets.values()]) remove();
      disposing = (async () => {
        await initScript?.dispose().catch(() => {});
        if (observingDom) {
          await page.evaluate(({ stateName }) => {
            const state = window as unknown as Record<string, { dispose(): void } | undefined>;
            state[stateName]?.dispose();
          }, options).catch(() => {});
        }
        await binding?.dispose().catch(() => {});
      })();
      return disposing;
    },
  };
}
