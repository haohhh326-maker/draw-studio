const rootQueues = new Map<string, Promise<unknown>>();

/** The caller resolves the library root before scheduling reads and mutations. */
export async function serializedWorkflowLibraryRoot<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  const previous = rootQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  rootQueues.set(key, current);
  try { return await current; }
  finally { if (rootQueues.get(key) === current) rootQueues.delete(key); }
}
