import json
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Optional

try:
    import psutil
except Exception:
    psutil = None


DEFAULT_LOG_PATH = os.path.join(
    os.path.dirname(__file__),
    "logs",
    "metrics.agent.jsonl",
)


def _enabled() -> bool:
    # Logovanie vieme vypnúť cez premennú prostredia, ak potrebujeme čo najjednoduchší beh.
    v = os.environ.get("METRICS_ENABLED", "1")
    return not (v == "0" or v.lower() == "false")


def _log_path() -> str:
    return os.environ.get("METRICS_PATH", DEFAULT_LOG_PATH)


def _ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)


def _append_jsonl(row: Dict[str, Any]):
    # Agent zapisuje metriky po riadkoch vo formáte JSON Lines.
    if not _enabled():
        return

    out = _log_path()
    dirpath = os.path.dirname(out)
    _ensure_dir(dirpath)

    line = json.dumps(row, ensure_ascii=False) + "\n"
    with open(out, "a", encoding="utf-8") as f:
        f.write(line)


def get_trace_id_from_request(req) -> str:
    # Ak prišlo trasovacie ID zo servera, prenesieme ho ďalej; inak založíme nové.
    h = req.headers.get("X-Trace-Id")
    if h and str(h).strip():
        return str(h).strip()
    return f"trace_{uuid.uuid4().hex}"


def _iso_now_utc() -> str:
    t = time.time()
    base = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t))
    ms = int((t % 1) * 1000)
    return f"{base}.{ms:03d}Z"


@dataclass
class _ProcSnap:
    # Snapshot predstavuje stav procesu v jednom konkrétnom okamihu.
    ts_iso: str
    t_ns: int
    cpu_user_s: float
    cpu_system_s: float
    rss_bytes: int
    io_read_bytes: int
    io_write_bytes: int


def _take_snapshot() -> _ProcSnap:
    ts_iso = _iso_now_utc()
    t_ns = time.perf_counter_ns()

    cpu_user_s = 0.0
    cpu_system_s = 0.0
    rss_bytes = 0
    io_read_bytes = 0
    io_write_bytes = 0

    if psutil is not None:
        p = psutil.Process(os.getpid())

        try:
            ct = p.cpu_times()
            cpu_user_s = float(getattr(ct, "user", 0.0))
            cpu_system_s = float(getattr(ct, "system", 0.0))
        except Exception:
            cpu_user_s = 0.0
            cpu_system_s = 0.0

        try:
            mi = p.memory_info()
            rss_bytes = int(getattr(mi, "rss", 0))
        except Exception:
            rss_bytes = 0

        try:
            io = p.io_counters()
            io_read_bytes = int(getattr(io, "read_bytes", 0))
            io_write_bytes = int(getattr(io, "write_bytes", 0))
        except Exception:
            io_read_bytes = 0
            io_write_bytes = 0

    return _ProcSnap(
        ts_iso=ts_iso,
        t_ns=t_ns,
        cpu_user_s=cpu_user_s,
        cpu_system_s=cpu_system_s,
        rss_bytes=rss_bytes,
        io_read_bytes=io_read_bytes,
        io_write_bytes=io_write_bytes,
    )


class span:
    # Context manager zmeria čas aj spotrebu zdrojov pre vybranú operáciu agenta.
    def __init__(
        self,
        phase: str,
        operation: str,
        trace_id: str,
        parent_span_id: Optional[str] = None,
        extra: Optional[Dict[str, Any]] = None,
        component: str = "agent",
    ):
        self.phase = phase
        self.operation = operation
        self.trace_id = trace_id
        self.parent_span_id = parent_span_id
        self.extra = extra or {}
        self.component = component
        self.span_id = f"span_{uuid.uuid4().hex}"
        self._s0: Optional[_ProcSnap] = None

    def __enter__(self):
        self._s0 = _take_snapshot()
        return self

    def __exit__(self, exc_type, exc, tb):
        s0 = self._s0 or _take_snapshot()
        s1 = _take_snapshot()

        duration_ms = (s1.t_ns - s0.t_ns) / 1_000_000.0
        cpu_user_ms = (s1.cpu_user_s - s0.cpu_user_s) * 1000.0
        cpu_system_ms = (s1.cpu_system_s - s0.cpu_system_s) * 1000.0

        row = {
            "ts_start": s0.ts_iso,
            "ts_end": s1.ts_iso,
            "duration_ms": round(duration_ms, 3),
            "component": self.component,
            "phase": self.phase,
            "operation": self.operation,
            "trace_id": self.trace_id,
            "span_id": self.span_id,
            "parent_span_id": self.parent_span_id,
            "status": "error" if exc is not None else "ok",
            "cpu_user_ms": round(cpu_user_ms, 3),
            "cpu_system_ms": round(cpu_system_ms, 3),
            "rss_start_bytes": int(s0.rss_bytes),
            "rss_end_bytes": int(s1.rss_bytes),
            "io_read_bytes": int(s1.io_read_bytes - s0.io_read_bytes),
            "io_write_bytes": int(s1.io_write_bytes - s0.io_write_bytes),
            "extra": dict(self.extra),
        }

        if exc is not None:
            row["extra"]["error"] = str(exc)

        _append_jsonl(row)
        return False


def install_flask_request_metrics(app):
    from flask import request

    @app.before_request
    def _metrics_before_request():
        if not _enabled():
            return

        # Pred spracovaním requestu si uložíme štart merania do objektu request.
        trace_id = get_trace_id_from_request(request)
        request._metrics_trace_id = trace_id
        request._metrics_span = span(
            phase="http",
            operation="request",
            trace_id=trace_id,
            extra={
                "method": request.method,
                "path": request.path,
                "remote_addr": request.remote_addr,
            },
        )
        request._metrics_span.__enter__()

    @app.after_request
    def _metrics_after_request(response):
        if not _enabled():
            return response

        sp = getattr(request, "_metrics_span", None)
        if sp is not None:
            sp.extra["http_status"] = getattr(response, "status_code", None)
            sp.__exit__(None, None, None)

        return response
