"""Live RAM sampler for quill_engine runs.

Samples every second: per-process RSS for the quill_engine app(s) and
ollama, plus system memory totals and a peak tracker. Ctrl+C to stop.

Usage:
    .venv/bin/python scripts/monitor_ram.py
"""

import sys
import time

import psutil

PIDS = {p.pid for p in psutil.process_iter(["name"]) if "python" in (p.info["name"] or "")}


def _matches(proc: psutil.Process) -> bool:
    try:
        cmdline = " ".join(proc.cmdline())
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False
    return "main.py" in cmdline or "ollama" in cmdline or "quill" in cmdline


def _mb(bytes_: int) -> float:
    return bytes_ / (1024 * 1024)


def sample() -> dict[str, float]:
    rows: dict[str, float] = {}
    for proc in psutil.process_iter():
        try:
            if _matches(proc):
                name = proc.name()
                key = f"{name} {proc.pid}"
                if name == "ollama":
                    key = "ollama runner"
                rows[key] = _mb(proc.memory_info().rss)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return rows


def main() -> None:
    vm = psutil.virtual_memory()
    print(f"total: {_mb(vm.total):.0f} MB  swap: {_mb(psutil.swap_memory().total):.0f} MB\n")
    print(f"{'process':<24}{'rss (MB)':>10}")
    print("-" * 34)
    peaks: dict[str, float] = {}
    try:
        while True:
            rows = sample()
            for key, mb in rows.items():
                peaks[key] = max(peaks.get(key, 0.0), mb)
            sys.stdout.write("\x1b[2J\x1b[H")  # clear screen
            print(f"{'process':<24}{'rss (MB)':>10}{'peak (MB)':>12}")
            print("-" * 46)
            for key, mb in sorted(rows.items()):
                print(f"{key:<24}{mb:>10.0f}{peaks[key]:>12.0f}")
            vm = psutil.virtual_memory()
            sw = psutil.swap_memory()
            print("-" * 46)
            print(f"{'system used':<24}{_mb(vm.used):>10.0f}{_mb(vm.used):>12.0f}")
            print(f"{'system avail':<24}{_mb(vm.available):>10.0f}")
            print(f"{'swap used':<24}{_mb(sw.used):>10.0f}")
            time.sleep(1.0)
    except KeyboardInterrupt:
        print("\npeak RSS per process (MB):")
        for key, mb in sorted(peaks.items(), key=lambda kv: -kv[1]):
            print(f"  {key:<24}{mb:>8.0f}")


if __name__ == "__main__":
    main()
