"""Ensure a single supervised canvas is healthy before starting ComfyUI."""
import fcntl
import importlib.util
import os
import pathlib
import subprocess
import sys
import time


def main():
    root = pathlib.Path(os.environ.get("CANVAS_ROOT", "/root/draw-studio")).resolve()
    supervisor = root / "deploy/autodl/canvas-supervisor.py"
    if not supervisor.is_file():
        raise RuntimeError(f"Missing canvas supervisor: {supervisor}")
    spec = importlib.util.spec_from_file_location("canvas_supervisor", supervisor)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    with (root / "canvas.supervisor.lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pass  # An existing supervisor owns the lock, possibly still starting.
        else:
            if module.listener_pids():
                raise RuntimeError("Canvas port 6008 is already occupied by an unsupervised service; stop that deployment first.")
            environment = os.environ.copy()
            environment["CANVAS_ROOT"] = str(root)
            with (root / "canvas.log").open("ab", buffering=0) as log:
                subprocess.Popen(
                    [sys.executable, str(supervisor), "--lock-fd", str(lock.fileno())],
                    cwd=root,
                    env=environment,
                    pass_fds=(lock.fileno(),),
                    stdin=subprocess.DEVNULL,
                    stdout=log,
                    stderr=log,
                    start_new_session=True,
                )
        # Do not explicitly unlock: the supervisor inherited this open file.

    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        pid = module.read_pid(root / "canvas.pid")
        guard_pid = module.read_pid(root / "canvas.supervisor.pid")
        if module.process_has_argument(guard_pid, supervisor) and module.healthy(root, pid):
            return
        listeners = module.listener_pids()
        if listeners and not all(module.process_has_argument(owner, root / "server.mjs") for owner in listeners):
            raise RuntimeError("Canvas port 6008 belongs to another service; it has been left untouched.")
        time.sleep(0.5)
    raise RuntimeError(f"Canvas did not become healthy within 20 seconds; see {root / 'canvas.log'}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError) as error:
        print(f"Canvas startup failed: {error}", file=sys.stderr)
        sys.exit(1)
