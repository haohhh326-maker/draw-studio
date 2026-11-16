import { useEffect, useRef, useState } from "react";
import { Eraser, LoaderCircle } from "lucide-react";
import { IconButton } from "../components/ui";
import { useStore } from "../stores/store";
import { MemoryCleanupAction } from "./memory-cleanup";
import "./memory-cleanup.css";

export function MemoryCleanupButton() {
  const baseUrl = useStore(state => state.connection.baseUrl);
  const runninghub = useStore(state => state.computeProvider !== "comfyui");
  const [busy, setBusy] = useState(false);
  const action = useRef<MemoryCleanupAction | undefined>(undefined);
  useEffect(() => {
    const cleanup = new MemoryCleanupAction({
      connection: () => useStore.getState().connection,
      subscribe: listener => useStore.subscribe(listener),
      notify: message => useStore.getState().notify(message),
      busy: setBusy,
    });
    action.current = cleanup;
    return () => { cleanup.dispose(); if (action.current === cleanup) action.current = undefined; };
  }, []);
  return <IconButton title="清理内存/显存" className="icon-button memory-cleanup-button" disabled={runninghub || busy || !baseUrl.trim()}
    aria-busy={busy} onClick={() => void action.current?.run()}>
    {busy ? <LoaderCircle size={18} className="memory-cleanup-spinner" /> : <Eraser size={18} />}
  </IconButton>;
}
