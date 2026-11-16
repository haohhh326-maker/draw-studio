import { openDB, type IDBPDatabase } from "idb";

type Connection = { owner: object; promise: Promise<IDBPDatabase> };
let cached: Connection | undefined;

/** Share one IndexedDB connection across record and media operations. */
export function projectDatabase(): Promise<IDBPDatabase> {
  if (cached) return cached.promise;
  const owner = {};
  let connection: IDBPDatabase | undefined;
  let invalidated = false;
  const invalidate = () => {
    invalidated = true;
    connection?.close();
    // A late event from an older connection must not discard its replacement.
    if (cached?.owner === owner) cached = undefined;
  };
  const promise = openDB("clearframe-canvas", 1, {
    upgrade(database) {
      database.createObjectStore("records");
      database.createObjectStore("assets");
    },
    blocking: invalidate,
    terminated: invalidate,
  }).then(database => {
    connection = database;
    if (invalidated) database.close();
    return database;
  }).catch(reason => {
    if (cached?.owner === owner) cached = undefined;
    throw reason;
  });
  cached = { owner, promise };
  return promise;
}
