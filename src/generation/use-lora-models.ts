import { useEffect, useState } from "react";
import type { Connection } from "../types";
import { loadImportSchema } from "../workflow/import-schema";

type ModelSchema = {
  identity: string;
  revision: number;
  loading: boolean;
  info?: Record<string, unknown>;
  message: string;
};

/** Only the active workstation may supply model choices; a late response cannot cross engines. */
export function useLoraModels(enabled: boolean, connection: Connection) {
  const identity = JSON.stringify([connection.baseUrl, connection.authHeader, connection.authPrefix, connection.token]);
  const [revision, setRevision] = useState(0);
  const [schema, setSchema] = useState<ModelSchema>();
  useEffect(() => {
    if (!enabled || !connection.baseUrl.trim()) return;
    const abort = new AbortController();
    setSchema(previous => ({ identity, revision, loading: true,
      info: previous?.identity === identity ? previous.info : undefined, message: "正在读取 LoRA 模型列表…" }));
    void loadImportSchema(connection, abort.signal).then(result => {
      if (abort.signal.aborted) return;
      setSchema({ identity, revision, loading: false, info: result.info,
        message: result.warnings.length ? result.info ? "暂时无法刷新，使用此工作站此前读取的模型列表。" : "未能读取 LoRA 模型列表，请检查工作站连接后刷新。" : "" });
    }).catch(() => {
      if (!abort.signal.aborted) setSchema({ identity, revision, loading: false,
        message: "未能读取 LoRA 模型列表，请检查工作站连接后刷新。" });
    });
    return () => abort.abort();
  }, [enabled, identity, revision]);
  const current = schema?.identity === identity ? schema : undefined;
  const loading = enabled && !!connection.baseUrl.trim() && (!current || current.revision !== revision || current.loading);
  return {
    info: current?.info,
    loading,
    message: !connection.baseUrl.trim() ? "连接工作站后可选择其 LoRA 模型。" : loading ? "正在读取 LoRA 模型列表…" : current?.message ?? "",
    refresh: () => setRevision(value => value + 1),
  };
}
