/** A changed context permanently invalidates this operation, even if it changes back. */
export function createOptimizationGuard(
  readIdentity: () => string,
  subscribe: (listener: () => void) => () => void,
  onInvalidate: () => void = () => {},
) {
  const identity = readIdentity();
  const controller = new AbortController();
  let invalid = false, disposed = false;
  const check = () => {
    if (!invalid && !disposed && readIdentity() !== identity) {
      invalid = true;
      controller.abort();
      onInvalidate();
    }
  };
  const unsubscribe = subscribe(check);
  return {
    identity,
    signal: controller.signal,
    valid() { check(); return !invalid && !disposed && !controller.signal.aborted; },
    cancel() { invalid = true; controller.abort(); },
    dispose() { if (!disposed) { disposed = true; unsubscribe(); } },
  };
}
