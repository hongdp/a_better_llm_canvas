"""Wake-on-request proxy for a cloud model endpoint.

The app points its OpenAI-compatible base URL at this proxy on loopback. The
proxy owns the machine behind it:

    first request  → start the VM, wait for the model server, then forward
    subsequent     → forward immediately
    idle for N min → stop the VM

Only the first request after a nap waits. That is the whole trade: a few
minutes once, against paying for a GPU that sits idle between writing
sessions.

Why loopback matters: the app's own `/api/models` proxy refuses non-loopback
hosts (SSRF guard, server_generation.py), so a cloud endpoint reached directly
would populate no model list. Fronting it here keeps the app's view of the
world local.

Design constraints learned from LLM_Mahjong/docs/gcp_compute_cost_and_quota.md:

  * The VM must use ON-DEMAND provisioning. DWS flex-start is cheaper but its
    termination action is DELETE, and a flex VM that is stopped "若被停机后重启,
    配额不足会立即失败" — restart does not queue the way creation does. A
    wake/sleep loop on flex would fail unpredictably, at the worst moment.
  * The weights live on the VM's persistent disk, so a wake is a boot plus a
    local load rather than a re-download.

Two independent shutdowns, deliberately:
  1. this proxy's idle timer, and
  2. a timer ON the VM (see README) that halts it if no request arrives.
The second exists because the first runs on a machine that can crash, and an
abandoned GPU VM bills by the hour.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

logger = logging.getLogger("wake_proxy")

# ── Configuration ───────────────────────────────────────────────────────────

IDLE_STOP_SECONDS = int(os.environ.get("WAKE_IDLE_SECONDS", "900"))          # 15 min
MAX_SESSION_SECONDS = int(os.environ.get("WAKE_MAX_SESSION_SECONDS", "21600"))  # 6 h
WAKE_TIMEOUT_SECONDS = int(os.environ.get("WAKE_TIMEOUT_SECONDS", "600"))   # 10 min
HEALTH_POLL_SECONDS = float(os.environ.get("WAKE_HEALTH_POLL_SECONDS", "5"))
UPSTREAM_BASE_URL = os.environ.get("WAKE_UPSTREAM_URL", "")                 # e.g. http://10.0.0.5:8000/v1


class VMState:
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"


class VMController:
    """What the proxy needs from a machine. Substituted in tests."""

    async def state(self) -> str:
        raise NotImplementedError

    async def start(self) -> None:
        raise NotImplementedError

    async def stop(self) -> None:
        raise NotImplementedError

    async def healthy(self) -> bool:
        """True once the model server behind the VM answers."""
        raise NotImplementedError


@dataclass
class ProxyStats:
    wakes: int = 0
    sleeps: int = 0
    requests: int = 0
    last_wake_seconds: Optional[float] = None
    awake_seconds_total: float = 0.0


@dataclass
class WakeManager:
    """Owns the machine's lifecycle. Pure asyncio, no HTTP, so it is testable.

    The invariants that matter, and why:
      * ONE wake at a time. Ten requests arriving at once must produce one
        `instances start`, not ten.
      * Never stop with work in flight. A generation can run for minutes with
        no bytes crossing the wire; an idle timer that only watched the clock
        would kill it.
      * A hard session cap. If the idle timer is ever wrong, the bill is not.
    """

    controller: VMController
    idle_seconds: int = IDLE_STOP_SECONDS
    max_session_seconds: int = MAX_SESSION_SECONDS
    wake_timeout_seconds: int = WAKE_TIMEOUT_SECONDS
    health_poll_seconds: float = HEALTH_POLL_SECONDS
    now: Callable[[], float] = time.monotonic
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep

    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _in_flight: int = 0
    _last_activity: float = 0.0
    _awake_since: Optional[float] = None
    stats: ProxyStats = field(default_factory=ProxyStats)

    async def ensure_awake(self) -> None:
        """Return once the endpoint is serving. Concurrent callers wake once."""
        async with self._lock:
            if await self.controller.healthy():
                self._mark_active()
                return

            started_at = self.now()
            state = await self.controller.state()
            if state in (VMState.STOPPED, VMState.STOPPING):
                logger.info("waking the endpoint (state=%s)", state)
                await self.controller.start()

            deadline = started_at + self.wake_timeout_seconds
            while self.now() < deadline:
                if await self.controller.healthy():
                    elapsed = self.now() - started_at
                    self.stats.wakes += 1
                    self.stats.last_wake_seconds = elapsed
                    self._awake_since = self.now()
                    logger.info("endpoint ready after %.1fs", elapsed)
                    self._mark_active()
                    return
                await self.sleep(self.health_poll_seconds)

            raise TimeoutError(
                f"endpoint did not become healthy within {self.wake_timeout_seconds}s"
            )

    def _mark_active(self) -> None:
        self._last_activity = self.now()
        if self._awake_since is None:
            self._awake_since = self.now()

    def begin_request(self) -> None:
        self._in_flight += 1
        self.stats.requests += 1
        self._mark_active()

    def end_request(self) -> None:
        self._in_flight = max(0, self._in_flight - 1)
        self._last_activity = self.now()

    @property
    def in_flight(self) -> int:
        return self._in_flight

    def should_stop(self) -> Optional[str]:
        """Reason to stop now, or None. Never stops with work in flight."""
        if self._awake_since is None:
            return None
        if self._in_flight > 0:
            return None
        if self.now() - self._last_activity >= self.idle_seconds:
            return "idle"
        if self.now() - self._awake_since >= self.max_session_seconds:
            return "max-session"
        return None

    async def maybe_stop(self) -> Optional[str]:
        reason = self.should_stop()
        if reason is None:
            return None
        async with self._lock:
            # Re-check under the lock: a request may have arrived while waiting.
            reason = self.should_stop()
            if reason is None:
                return None
            if not await self.controller.healthy() and \
                    await self.controller.state() == VMState.STOPPED:
                self._awake_since = None
                return None
            awake_for = self.now() - (self._awake_since or self.now())
            logger.info("stopping the endpoint after %.0fs awake (%s)", awake_for, reason)
            await self.controller.stop()
            self.stats.sleeps += 1
            self.stats.awake_seconds_total += awake_for
            self._awake_since = None
            return reason

    async def run_idle_watcher(self, tick_seconds: float = 30.0) -> None:
        while True:
            await self.sleep(tick_seconds)
            try:
                await self.maybe_stop()
            except Exception:  # noqa: BLE001 — a watcher must not die quietly
                logger.exception("idle watcher failed; will retry next tick")


# ── GCE implementation ──────────────────────────────────────────────────────

class GceController(VMController):
    """Drives one Compute Engine instance through the gcloud CLI.

    The CLI rather than the API client: it is already installed and
    authenticated on this machine (the mahjong project uses it), which is one
    fewer credential path to get wrong.
    """

    def __init__(self, project: str, zone: str, instance: str, health_url: str):
        self.project = project
        self.zone = zone
        self.instance = instance
        self.health_url = health_url

    async def _gcloud(self, *args: str, timeout: float = 180.0) -> str:
        proc = await asyncio.create_subprocess_exec(
            "gcloud", "compute", "instances", *args,
            f"--project={self.project}", f"--zone={self.zone}",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise
        if proc.returncode != 0:
            raise RuntimeError(f"gcloud {' '.join(args)} failed: {err.decode()[:400]}")
        return out.decode().strip()

    async def state(self) -> str:
        raw = await self._gcloud(
            "describe", self.instance, "--format=value(status)", timeout=60
        )
        return {
            "RUNNING": VMState.RUNNING,
            "TERMINATED": VMState.STOPPED,
            "STOPPED": VMState.STOPPED,
            "SUSPENDED": VMState.STOPPED,
            "STAGING": VMState.STARTING,
            "PROVISIONING": VMState.STARTING,
            "STOPPING": VMState.STOPPING,
        }.get(raw.strip(), VMState.STOPPED)

    async def start(self) -> None:
        await self._gcloud("start", self.instance)

    async def stop(self) -> None:
        await self._gcloud("stop", self.instance)

    async def healthy(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(self.health_url)
                return res.status_code == 200
        except Exception:  # noqa: BLE001 — unreachable is simply "not healthy"
            return False


# ── HTTP surface ────────────────────────────────────────────────────────────

def create_app(manager: WakeManager, upstream_base_url: str) -> FastAPI:
    app = FastAPI(title="wake proxy")
    upstream = upstream_base_url.rstrip("/")

    @app.on_event("startup")
    async def _start_watcher() -> None:
        app.state.watcher = asyncio.create_task(manager.run_idle_watcher())

    @app.get("/wake/status")
    async def status() -> JSONResponse:
        return JSONResponse({
            "state": await manager.controller.state(),
            "healthy": await manager.controller.healthy(),
            "inFlight": manager.in_flight,
            "idleStopSeconds": manager.idle_seconds,
            "stats": {
                "wakes": manager.stats.wakes,
                "sleeps": manager.stats.sleeps,
                "requests": manager.stats.requests,
                "lastWakeSeconds": manager.stats.last_wake_seconds,
                "awakeSecondsTotal": round(manager.stats.awake_seconds_total),
            },
        })

    @app.post("/wake/stop")
    async def force_stop() -> JSONResponse:
        """Stop now, unless something is mid-generation."""
        if manager.in_flight:
            raise HTTPException(status_code=409, detail="requests in flight")
        await manager.controller.stop()
        return JSONResponse({"stopped": True})

    @app.api_route("/{path:path}", methods=["GET", "POST"])
    async def forward(path: str, request: Request):
        try:
            await manager.ensure_awake()
        except TimeoutError as exc:
            raise HTTPException(status_code=504, detail=str(exc)) from exc

        body = await request.body()
        headers = {
            k: v for k, v in request.headers.items()
            if k.lower() not in {"host", "content-length", "connection"}
        }
        url = f"{upstream}/{path}"

        manager.begin_request()
        client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=30.0))
        try:
            req = client.build_request(request.method, url, content=body,
                                       headers=headers, params=request.query_params)
            res = await client.send(req, stream=True)
        except Exception as exc:  # noqa: BLE001
            manager.end_request()
            await client.aclose()
            raise HTTPException(status_code=502, detail=f"upstream unreachable: {exc}") from exc

        async def relay():
            # Streamed straight through: a generation is watched token by
            # token, and buffering it here would undo the whole UX.
            try:
                async for chunk in res.aiter_raw():
                    yield chunk
            finally:
                await res.aclose()
                await client.aclose()
                manager.end_request()

        return StreamingResponse(
            relay(),
            status_code=res.status_code,
            headers={k: v for k, v in res.headers.items()
                     if k.lower() not in {"content-length", "transfer-encoding", "connection"}},
        )

    return app


def build_default_app() -> FastAPI:
    project = os.environ["WAKE_GCP_PROJECT"]
    zone = os.environ["WAKE_GCP_ZONE"]
    instance = os.environ["WAKE_GCP_INSTANCE"]
    upstream = UPSTREAM_BASE_URL or os.environ["WAKE_UPSTREAM_URL"]
    health = os.environ.get("WAKE_HEALTH_URL", f"{upstream.rstrip('/')}/models")
    controller = GceController(project, zone, instance, health)
    return create_app(WakeManager(controller=controller), upstream)


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [wake_proxy] %(message)s",
    )
    uvicorn.run(
        build_default_app(),
        host=os.environ.get("WAKE_HOST", "127.0.0.1"),
        port=int(os.environ.get("WAKE_PORT", "8091")),
    )
