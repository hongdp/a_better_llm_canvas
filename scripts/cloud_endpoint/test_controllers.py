"""Tests for RunPodController against a faked REST API.

The lifecycle logic is tested in test_wake_proxy.py with a fake machine; this
file checks the part that talks to a real API shape, where the mistakes are
different: reading a desire as an observation, and caching an address that the
provider reassigns on every run.
"""

import asyncio

import httpx
import pytest

from controllers import RunPodController, VMState


def run(coro):
    return asyncio.run(coro)


class FakeRunPod:
    """Just enough of https://rest.runpod.io/v1 to be wrong in the same ways."""

    def __init__(self, status="EXITED", public_ip="1.2.3.4", mappings=None):
        self.status = status
        self.public_ip = public_ip
        self.mappings = mappings if mappings is not None else {}
        self.calls: list[tuple[str, str]] = []
        self.auth_seen: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append((request.method, request.url.path))
        self.auth_seen.append(request.headers.get("authorization", ""))
        path = request.url.path

        if request.method == "GET" and path.endswith("/pods/pod-1"):
            return httpx.Response(200, json={
                "id": "pod-1",
                "desiredStatus": self.status,
                "publicIp": self.public_ip,
                "portMappings": self.mappings,
            })
        if request.method == "POST" and path.endswith("/start"):
            self.status = "RUNNING"
            return httpx.Response(200, json={"id": "pod-1"})
        if request.method == "POST" and path.endswith("/stop"):
            self.status = "EXITED"
            self.mappings = {}
            return httpx.Response(200, json={"id": "pod-1"})
        return httpx.Response(404, json={"error": "no such route"})

    def controller(self) -> RunPodController:
        client = httpx.AsyncClient(transport=httpx.MockTransport(self.handler))
        return RunPodController(api_key="key-abc", pod_id="pod-1", client=client)


def test_status_maps_to_our_vocabulary():
    for api_status, expected in [
        ("RUNNING", VMState.RUNNING),
        ("EXITED", VMState.STOPPED),
        ("TERMINATED", VMState.STOPPED),
        ("something-new", VMState.STOPPED),   # unknown is treated as down
    ]:
        api = FakeRunPod(status=api_status)
        assert run(api.controller().state()) == expected


def test_start_and_stop_hit_the_documented_routes_with_the_token():
    api = FakeRunPod()
    ctrl = api.controller()

    run(ctrl.start())
    run(ctrl.stop())

    assert ("POST", "/v1/pods/pod-1/start") in api.calls
    assert ("POST", "/v1/pods/pod-1/stop") in api.calls
    assert all(a == "Bearer key-abc" for a in api.auth_seen)


def test_upstream_is_built_from_the_public_ip_and_port_mapping():
    api = FakeRunPod(status="RUNNING", public_ip="203.0.113.9", mappings={"8000": 41234})

    assert run(api.controller().upstream_url()) == "http://203.0.113.9:41234"


def test_a_pod_still_booting_has_no_address_and_is_not_healthy():
    # No mapping yet: the pod exists but has not been placed. Forwarding into
    # that would fail in a confusing way; "not healthy" is the honest answer.
    api = FakeRunPod(status="RUNNING", mappings={})
    ctrl = api.controller()

    assert run(ctrl.upstream_url()) is None
    assert run(ctrl.healthy()) is False


def test_the_public_port_is_re_read_after_a_restart():
    # THE hazard this controller exists for: RunPod assigns port mappings per
    # run, so a pod that stops and starts again can return on a different
    # public port. An address cached from before the nap points at nothing —
    # and the first request after a wake is exactly when it would be used.
    #
    # The pod is stopped EXTERNALLY here (by the on-pod idle backstop, or by
    # RunPod itself), so this process never called stop(). Clearing the cache
    # in stop() alone would not save us; start() has to do it too. Written the
    # other way round, this test passes with that bug present.
    api = FakeRunPod(status="RUNNING", public_ip="203.0.113.9", mappings={"8000": 41234})
    ctrl = api.controller()
    assert run(ctrl.upstream_url()) == "http://203.0.113.9:41234"

    api.status = "EXITED"                   # stopped behind our back
    api.mappings = {"8000": 55555}          # and it comes back elsewhere
    run(ctrl.start())

    assert run(ctrl.upstream_url()) == "http://203.0.113.9:55555"


def test_stopping_also_forgets_the_address():
    api = FakeRunPod(status="RUNNING", public_ip="203.0.113.9", mappings={"8000": 41234})
    ctrl = api.controller()
    run(ctrl.upstream_url())

    run(ctrl.stop())

    # Nothing is listening there any more; reporting an address would invite a
    # request into a hole.
    assert run(ctrl.upstream_url()) is None


def test_an_api_error_is_raised_rather_than_read_as_stopped():
    # A 401 must not look like "the pod is off" — that would make the proxy
    # cheerfully try to start it, forever.
    def unauthorized(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "unauthorized"})

    ctrl = RunPodController(
        api_key="wrong", pod_id="pod-1",
        client=httpx.AsyncClient(transport=httpx.MockTransport(unauthorized)),
    )

    with pytest.raises(RuntimeError, match="401"):
        run(ctrl.state())


def test_an_unreachable_api_leaves_healthy_false_instead_of_raising():
    # `healthy` is polled in a loop; it must degrade quietly.
    def refused(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    ctrl = RunPodController(
        api_key="key", pod_id="pod-1",
        client=httpx.AsyncClient(transport=httpx.MockTransport(refused)),
    )

    assert run(ctrl.healthy()) is False


def test_a_custom_internal_port_is_looked_up():
    api = FakeRunPod(status="RUNNING", public_ip="10.0.0.1", mappings={"8080": 30001})
    client = httpx.AsyncClient(transport=httpx.MockTransport(api.handler))
    ctrl = RunPodController(api_key="k", pod_id="pod-1", internal_port=8080, client=client)

    assert run(ctrl.upstream_url()) == "http://10.0.0.1:30001"
