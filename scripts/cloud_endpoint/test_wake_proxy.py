"""Tests for the wake-on-request lifecycle.

The machine is faked and the clock is driven by hand, so these run in
milliseconds and assert the things that actually cost money or lose work:
one wake per burst, never stopping mid-generation, and a hard cap that holds
even when the idle timer does not.

Async bodies are driven with `asyncio.run`, matching scripts/test_api_server.py
— no pytest-asyncio, because this repo's Python dependencies are hand-managed
and one plugin is not worth a new install step.
"""

import asyncio

import pytest

from wake_proxy import VMState, WakeManager


class FakeVM:
    """A machine that boots after `boot_ticks` health checks.

    Every method yields to the loop. Without that, concurrent callers never
    interleave and a test for "ten requests wake it once" passes even with the
    lock removed — it proves nothing. A real gcloud call or health probe is
    I/O, and I/O yields.
    """

    def __init__(self, boot_ticks: int = 2):
        self.boot_ticks = boot_ticks
        self._state = VMState.STOPPED
        self._ticks_since_start = 0
        self.starts = 0
        self.stops = 0

    async def state(self) -> str:
        await asyncio.sleep(0)
        return self._state

    async def start(self) -> None:
        await asyncio.sleep(0)
        self.starts += 1
        self._state = VMState.STARTING
        self._ticks_since_start = 0

    async def stop(self) -> None:
        await asyncio.sleep(0)
        self.stops += 1
        self._state = VMState.STOPPED

    async def healthy(self) -> bool:
        await asyncio.sleep(0)
        if self._state == VMState.STARTING:
            self._ticks_since_start += 1
            if self._ticks_since_start > self.boot_ticks:
                self._state = VMState.RUNNING
        return self._state == VMState.RUNNING


class Clock:
    """A hand-cranked clock; `sleep` advances it instead of waiting."""

    def __init__(self) -> None:
        self.t = 1000.0

    def now(self) -> float:
        return self.t

    async def sleep(self, seconds: float) -> None:
        self.t += seconds


def run(coro):
    """Drive one coroutine to completion, like scripts/test_api_server.py does."""
    return asyncio.run(coro)


def make(vm: FakeVM, **kwargs) -> tuple[WakeManager, Clock]:
    clock = Clock()
    mgr = WakeManager(controller=vm, now=clock.now, sleep=clock.sleep, **kwargs)
    return mgr, clock


def test_first_request_wakes_the_machine():
    vm = FakeVM(boot_ticks=2)
    mgr, clock = make(vm, health_poll_seconds=5)

    run(mgr.ensure_awake())

    assert vm.starts == 1
    assert run(vm.state()) == VMState.RUNNING
    # The caller waited for the boot, which is the accepted trade.
    assert mgr.stats.last_wake_seconds == pytest.approx(10.0)


def test_a_burst_of_requests_wakes_once():
    # Ten requests arriving together must not issue ten `instances start`.
    vm = FakeVM(boot_ticks=2)
    mgr, _ = make(vm, health_poll_seconds=5)

    async def burst():
        # gather() must be built INSIDE the loop it runs on.
        await asyncio.gather(*[mgr.ensure_awake() for _ in range(10)])

    run(burst())

    assert vm.starts == 1


def test_an_awake_machine_is_not_restarted():
    vm = FakeVM(boot_ticks=0)
    mgr, _ = make(vm)
    run(mgr.ensure_awake())
    starts_after_first = vm.starts

    run(mgr.ensure_awake())

    assert vm.starts == starts_after_first


def test_wake_gives_up_rather_than_hanging_forever():
    class NeverBoots(FakeVM):
        async def healthy(self) -> bool:
            return False

    vm = NeverBoots()
    mgr, _ = make(vm, wake_timeout_seconds=30, health_poll_seconds=5)

    with pytest.raises(TimeoutError):
        run(mgr.ensure_awake())


def test_idle_stops_the_machine():
    vm = FakeVM(boot_ticks=0)
    mgr, clock = make(vm, idle_seconds=900)
    run(mgr.ensure_awake())
    mgr.begin_request()
    mgr.end_request()

    clock.t += 899
    assert run(mgr.maybe_stop()) is None      # not yet
    clock.t += 2
    assert run(mgr.maybe_stop()) == "idle"
    assert vm.stops == 1


def test_never_stops_with_a_generation_in_flight():
    # A long generation sends nothing for minutes. A timer that only watched
    # the clock would kill it mid-sentence.
    vm = FakeVM(boot_ticks=0)
    mgr, clock = make(vm, idle_seconds=60)
    run(mgr.ensure_awake())
    mgr.begin_request()

    clock.t += 10_000
    assert run(mgr.maybe_stop()) is None
    assert vm.stops == 0

    mgr.end_request()
    clock.t += 61
    assert run(mgr.maybe_stop()) == "idle"


def test_activity_resets_the_idle_clock():
    vm = FakeVM(boot_ticks=0)
    mgr, clock = make(vm, idle_seconds=100)
    run(mgr.ensure_awake())

    for _ in range(5):
        clock.t += 90
        mgr.begin_request()
        mgr.end_request()
        assert run(mgr.maybe_stop()) is None

    clock.t += 101
    assert run(mgr.maybe_stop()) == "idle"


def test_hard_session_cap_stops_even_while_busy_hands_off():
    # The cap is the backstop for a wrong idle timer. It still respects work
    # in flight — it is a cost guard, not a killer.
    vm = FakeVM(boot_ticks=0)
    mgr, clock = make(vm, idle_seconds=100_000, max_session_seconds=3600)
    run(mgr.ensure_awake())

    clock.t += 3601
    assert run(mgr.maybe_stop()) == "max-session"
    assert vm.stops == 1


def test_a_stopped_machine_is_not_stopped_again():
    vm = FakeVM(boot_ticks=0)
    mgr, clock = make(vm, idle_seconds=10)
    run(mgr.ensure_awake())
    clock.t += 11
    run(mgr.maybe_stop())
    stops = vm.stops

    clock.t += 100
    run(mgr.maybe_stop())

    assert vm.stops == stops


def test_it_wakes_again_after_sleeping():
    vm = FakeVM(boot_ticks=1)
    mgr, clock = make(vm, idle_seconds=10, health_poll_seconds=5)
    run(mgr.ensure_awake())
    clock.t += 11
    run(mgr.maybe_stop())

    run(mgr.ensure_awake())

    assert vm.starts == 2
    assert mgr.stats.wakes == 2
    assert mgr.stats.sleeps == 1


def test_awake_time_is_accounted_for_the_bill():
    vm = FakeVM(boot_ticks=0)
    mgr, clock = make(vm, idle_seconds=10)
    run(mgr.ensure_awake())
    clock.t += 600
    run(mgr.maybe_stop())

    # 600s of GPU time is what this session cost, and it is recorded.
    assert mgr.stats.awake_seconds_total == pytest.approx(600, abs=1)
