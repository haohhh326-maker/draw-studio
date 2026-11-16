"""Keep this deployment's local canvas alive without touching other services."""
import argparse
import fcntl
import os
import pathlib
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

PORT = 6008
PROC = pathlib.Path("/proc")


def read_pid(path):
    try:
        pid = int(path.read_text().strip())
        return pid if pid > 0 else None
    except (OSError, ValueError):
        return None


def process_has_argument(pid, argument):
    if not pid:
        return False
    try:
        args = (PROC / str(pid) / "cmdline").read_bytes().split(b"\0")
        return os.fsencode(argument) in args
    except OSError:
        return False


def listener_pids():
    """Find the actual owners of TCP listeners, including IPv6 wildcard binds."""
    inodes = set()
    for table in ("tcp", "tcp6"):
        try:
            rows = (PROC / "net" / table).read_text().splitlines()[1:]
        except OSError:
            continue
        for row in rows:
            fields = row.split()
            if len(fields) > 9 and fields[3] == "0A" and int(fields[1].rsplit(":", 1)[1], 16) == PORT:
                inodes.add(fields[9])
    if not inodes:
        return set()
    owners = set()
    for process in PROC.iterdir():
        if not process.name.isdecimal():
            continue
        try:
            for fd in (process / "fd").iterdir():
                try:
                    target = os.readlink(fd)
                except OSError:
                    continue
                if target.startswith("socket:[") and target[8:-1] in inodes:
                    owners.add(int(process.name))
        except OSError:
            continue
    # An inaccessible owner must not look like an available port.
    return owners or {-1}


def healthy(root, pid):
    if not process_has_argument(pid, root / "server.mjs") or listener_pids() != {pid}:
        return False
    try:
        with urllib.request.urlopen("http://127.0.0.1:6008/canvas/", timeout=2) as response:
            return response.status == 200 and bool(response.read(1))
    except (OSError, urllib.error.URLError):
        return False


def remove_own_pid(path, pid):
    if read_pid(path) == pid:
        path.unlink(missing_ok=True)


def stop_child(child, root):
    if child is None or child.poll() is not None:
        return True
    # Popen owns this PID, and its current command must still be our launcher/server.
    def owned():
        return process_has_argument(child.pid, root / "server.mjs") or process_has_argument(child.pid, root / "deploy/autodl/start-canvas.sh")
    if not owned():
        print(f"Canvas child {child.pid} changed its command; leaving it untouched.", flush=True)
        return False
    child.terminate()
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        if not owned():
            return False
        child.kill()
        child.wait(timeout=5)
    return True


def supervise(root, lock):
    # This fd is either acquired here or inherited from ensure-canvas.py.
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    stopping = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: stopping.set())
    supervisor_pid = root / "canvas.supervisor.pid"
    child_pid = root / "canvas.pid"
    supervisor_pid.write_text(f"{os.getpid()}\n")
    child = None
    retry_delay = 1
    try:
        while not stopping.is_set():
            if listener_pids():
                raise RuntimeError("Port 6008 is occupied; no existing process will be stopped.")
            environment = os.environ.copy()
            environment["CANVAS_ROOT"] = str(root)
            child = subprocess.Popen(
                ["/bin/bash", str(root / "deploy/autodl/start-canvas.sh")],
                cwd=root,
                env=environment,
                stdin=subprocess.DEVNULL,
                close_fds=True,
                start_new_session=True,
            )
            child_pid.write_text(f"{child.pid}\n")
            print(f"Starting canvas PID {child.pid}.", flush=True)
            deadline = time.monotonic() + 20
            ready_since = None
            failures = 0
            while not stopping.is_set() and child.poll() is None:
                owners = listener_pids()
                if owners and owners != {child.pid}:
                    if child.poll() is not None:
                        break  # Its socket may disappear during the /proc scan.
                    raise RuntimeError("Another service owns port 6008; it has been left untouched.")
                if healthy(root, child.pid):
                    if ready_since is None:
                        ready_since = time.monotonic()
                        print("Canvas is healthy.", flush=True)
                    failures = 0
                    if time.monotonic() - ready_since >= 30:
                        retry_delay = 1
                elif ready_since is None:
                    if time.monotonic() >= deadline:
                        print("Canvas startup health check timed out.", flush=True)
                        break
                else:
                    failures += 1
                    if failures >= 3:
                        print("Canvas failed three health checks; restarting its child.", flush=True)
                        break
                stopping.wait(2)
            if not stop_child(child, root):
                raise RuntimeError("Cannot safely restart the canvas child.")
            remove_own_pid(child_pid, child.pid)
            child = None
            if stopping.is_set():
                break
            print(f"Canvas stopped; retrying in {retry_delay} seconds.", flush=True)
            stopping.wait(retry_delay)
            retry_delay = min(retry_delay * 2, 15)
    finally:
        if child is not None:
            stop_child(child, root)
            remove_own_pid(child_pid, child.pid)
        remove_own_pid(supervisor_pid, os.getpid())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock-fd", type=int)
    args = parser.parse_args()
    root = pathlib.Path(os.environ.get("CANVAS_ROOT", "/root/draw-studio")).resolve()
    if args.lock_fd is None:
        with (root / "canvas.supervisor.lock").open("a+") as lock:
            supervise(root, lock)
    else:
        with os.fdopen(args.lock_fd, "a+") as lock:
            supervise(root, lock)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError) as error:
        print(f"Canvas supervisor failed: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
