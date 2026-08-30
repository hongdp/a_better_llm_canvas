"""Machines the wake proxy can drive.

Each controller answers four questions — is it up, start it, stop it, is the
model server answering — and optionally resolves where to forward to.

Two are implemented:

  GceController      a Compute Engine instance, driven through the gcloud CLI
  RunPodController   a RunPod pod, driven through its REST API

RunPod is roughly half the price for the same class of card ($2.09/h for a
96 GB RTX 6000 Pro against $4.5/h for GCP's on-demand g4), bills per second,
and has no monthly minimum — which is why it exists here.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

import httpx

logger = logging.getLogger("wake_proxy.controllers")


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
        """True once the model server behind the machine answers."""
        raise NotImplementedError

    async def upstream_url(self) -> Optional[str]:
        """Where to forward, if the machine decides that itself.

        None means "use the statically configured URL".
        """
        return None


class GceController(VMController):
    """One Compute Engine instance, through the gcloud CLI.

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


class RunPodController(VMController):
    """One RunPod pod, through https://rest.runpod.io/v1.

    Two things about this API shape the code:

    `desiredStatus` is a DESIRE, not an observation. It flips to RUNNING the
    moment `start` is accepted, while the pod is still being placed and the
    model is still loading. Trusting it would forward requests into a void, so
    readiness is decided by `healthy()` alone and this value is used only to
    decide whether a start is needed.

    `portMappings` is assigned per run. A pod that stops and starts again can
    come back on a DIFFERENT public port, so a statically configured upstream
    URL breaks on the first wake — exactly the moment this proxy exists for.
    `upstream_url()` therefore re-reads the mapping after every wake.
    """

    BASE_URL = "https://rest.runpod.io/v1"

    def __init__(
        self,
        api_key: str,
        pod_id: str,
        internal_port: int = 8000,
        health_path: str = "/v1/models",
        base_url: str = BASE_URL,
        client: Optional[httpx.AsyncClient] = None,
    ):
        self.api_key = api_key
        self.pod_id = pod_id
        self.internal_port = internal_port
        self.health_path = health_path
        self.base_url = base_url.rstrip("/")
        self._client = client
        self._cached_upstream: Optional[str] = None

    def _http(self) -> httpx.AsyncClient:
        return self._client or httpx.AsyncClient(timeout=30.0)

    async def _request(self, method: str, path: str) -> dict:
        client = self._http()
        owned = self._client is None
        try:
            res = await client.request(
                method, f"{self.base_url}{path}",
                headers={"Authorization": f"Bearer {self.api_key}"},
            )
            if res.status_code >= 400:
                raise RuntimeError(
                    f"runpod {method} {path} -> {res.status_code}: {res.text[:300]}"
                )
            return res.json() if res.content else {}
        finally:
            if owned:
                await client.aclose()

    async def _pod(self) -> dict:
        return await self._request("GET", f"/pods/{self.pod_id}")

    async def state(self) -> str:
        pod = await self._pod()
        return {
            "RUNNING": VMState.RUNNING,
            "EXITED": VMState.STOPPED,
            "TERMINATED": VMState.STOPPED,
        }.get(str(pod.get("desiredStatus", "")).upper(), VMState.STOPPED)

    async def start(self) -> None:
        # The public port can change across runs, so anything cached about
        # where to forward is stale from here on.
        self._cached_upstream = None
        await self._request("POST", f"/pods/{self.pod_id}/start")

    async def stop(self) -> None:
        self._cached_upstream = None
        await self._request("POST", f"/pods/{self.pod_id}/stop")

    async def upstream_url(self) -> Optional[str]:
        """`http://<publicIp>:<public port for internal_port>` — re-read per wake."""
        if self._cached_upstream:
            return self._cached_upstream
        try:
            pod = await self._pod()
        except Exception:  # noqa: BLE001
            return None
        ip = pod.get("publicIp")
        mappings = pod.get("portMappings") or {}
        public_port = mappings.get(str(self.internal_port)) or mappings.get(self.internal_port)
        if not ip or not public_port:
            return None
        self._cached_upstream = f"http://{ip}:{public_port}"
        return self._cached_upstream

    async def healthy(self) -> bool:
        base = await self.upstream_url()
        if not base:
            return False
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(f"{base}{self.health_path}")
                return res.status_code == 200
        except Exception:  # noqa: BLE001
            # A pod that is booting refuses connections; that is "not yet",
            # not an error worth surfacing.
            return False
