# Wake-on-request cloud endpoint

A GPU VM that starts when you send a message and stops when you stop writing.
Only the first request after a nap waits.

```
web_canvas  ──▶  wake_proxy (this workstation, 127.0.0.1:8091)
                     │  first request → start the machine → poll health
                     │  every request → streamed straight through
                     │  idle 15 min   → stop the machine
                     ▼
                 a GPU, from one of two backends
                     └── vLLM + Qwen3.8-Flash-Next-Uncensored-NVFP4
                     └── idle backstop timer (halts if the proxy dies)
```

## Backends

| | `runpod` (default) | `gce` |
|---|---|---|
| card | RTX 6000 Pro, 96 GB | g4-standard-48, RTX PRO 6000 96 GB |
| rate | **$2.09/h**, per second, no minimum | $4.5/h on-demand |
| control | REST API (`rest.runpod.io/v1`) | `gcloud compute instances` |
| address | **discovered per wake** (see below) | fixed internal IP |

RunPod is the default because it is less than half the price for the same
class of card, bills per second, and has no monthly minimum — a month with no
writing costs nothing. GCE is kept because the mahjong project already lives
there and shares the credentials.

**RunPod reassigns the public port on every run.** `portMappings` is per-run
state, so a pod that sleeps and wakes can come back on a different port. An
upstream URL read once at startup is therefore wrong from the first wake — the
exact moment this proxy exists for. `RunPodController.upstream_url()` re-reads
it after every start, and drops what it cached when the pod stops.

`desiredStatus` is likewise a *desire*, not an observation: it flips to RUNNING
the moment a start is accepted, while the pod is still being placed and the
model is still loading. Readiness is decided by the health probe alone.

## Why this shape

**The proxy runs on the always-on workstation, on loopback.** Two reasons. It
has to outlive the VM to be able to start it. And the app's own `/api/models`
proxy refuses non-loopback hosts (an SSRF guard in `server_generation.py`), so
a cloud endpoint addressed directly would populate no model list — fronting it
here keeps the app's view local while the GPU is 1,500 km away.

**On GCE the VM is on-demand, not DWS flex-start.** Flex is 45% cheaper and is the
right default for the mahjong project's long training runs. It is wrong here:
its termination action is DELETE, so there is nothing to wake; and per
`LLM_Mahjong/docs/gcp_compute_cost_and_quota.md`, a stopped flex VM that is
restarted "配额不足会立即失败（不像创建会排队）". A wake/sleep loop needs
stop/start to be boring. That is ~$4.5/h against flex's $2.25/h.

**Two idle timers, not one.** The proxy's timer is the fast path. The timer on
the VM is the one that has to be true, because the proxy runs on a machine that
can crash and an abandoned GPU bills by the hour.

**The weights live on the VM's boot disk.** A wake is then a boot plus a local
load, not a 90 GB download.

## Machine and model

Both backends land on the same card: an RTX PRO 6000 (Blackwell, 96 GB), which fits
`orcarouter/Qwen3.8-Flash-Next-Uncensored-NVFP4` — the 4-bit format Blackwell
runs natively. vLLM and SGLang both support this architecture (`qwen4exp`);
SGLang shipped day-0 support with the Qwen team.

Do not use the GGUF build here. GGUF is llama.cpp's format; vLLM's support for
it is partial and slower, and there is no reason to pay for a GPU to run a
worse path.

## Cost, honestly

With a 15-minute idle stop, at RunPod's $2.09/h (GCE's $4.5/h in brackets):

| writing per day | GPU hours/month | cost/month |
|---|---|---|
| 1 h in one sitting | ~38 | **~$79** ($170) |
| 2 h in one sitting | ~68 | **~$142** ($305) |
| 2 h split into 4 sittings | ~83 | **~$174** ($375) |

A month with no writing costs $0 on either.

Fragmented sessions cost more: each gap under 15 minutes is paid for, each gap
over it costs a fresh wake. A Mac Studio with 128 GB is $4,499 — break-even
somewhere between 12 and 26 months depending on how you write.

The proxy tracks this: `GET /wake/status` reports wakes, sleeps, and total
awake seconds.

## Setup — RunPod

1. **Create the pod** in the RunPod console (once): an RTX 6000 Pro, a network
   volume big enough for the NVFP4 weights (~90 GB) plus the venv, a vLLM
   image, and HTTP port 8000 exposed. Keeping the weights on the volume is
   what makes a wake a boot plus a local load rather than a re-download.

2. **Note the pod id** and create an API key.

3. **Run the proxy** on this workstation:

   ```bash
   export WAKE_BACKEND=runpod
   export RUNPOD_API_KEY=...
   export RUNPOD_POD_ID=...
   export RUNPOD_INTERNAL_PORT=8000    # what vLLM listens on inside the pod
   python3 wake_proxy.py
   ```

   No upstream URL: the controller discovers it.

4. **Install the on-pod backstop** — `vm_idle_backstop.sh`, same as for GCE.
   RunPod pods bill while running whether or not anyone is talking to them,
   and the proxy runs on a machine that can crash.

## Setup — GCE

1. **Create the VM** (once):

   ```bash
   ./create_vm.sh
   ```

2. **Provision it** (once, over SSH): install vLLM, download the NVFP4 weights
   to the boot disk, and add a systemd unit that starts vLLM at boot writing to
   `/var/log/vllm.log`. Then install the backstop — the header of
   `vm_idle_backstop.sh` has the exact unit files.

3. **Point the proxy at it** and run it on this workstation:

   ```bash
   export WAKE_BACKEND=gce
   export WAKE_GCP_PROJECT=workstation-185016
   export WAKE_GCP_ZONE=us-central1-b
   export WAKE_GCP_INSTANCE=canvas-llm
   export WAKE_UPSTREAM_URL=http://<vm-internal-ip>:8000/v1
   python3 wake_proxy.py
   ```

   A systemd user unit alongside `web-canvas-api.service` is the natural home
   for it; that is how the rest of this machine's services are supervised.

4. **Point the app at the proxy**: Settings → Ollama → Base URL
   `http://127.0.0.1:8091/v1`. Nothing else changes — the model name follows
   the endpoint's own listing.

## Knobs

| env | default | |
|---|---|---|
| `WAKE_IDLE_SECONDS` | 900 | stop after this much quiet |
| `WAKE_MAX_SESSION_SECONDS` | 21600 | hard cap; a wrong idle timer must not cost a day of GPU |
| `WAKE_TIMEOUT_SECONDS` | 600 | give up waking and return 504 |
| `WAKE_PORT` | 8091 | |

## What is not handled

- **The first request is slow.** Boot plus a ~90 GB load is minutes. The app
  shows "waiting for the first reply" throughout, with no indication that a
  machine is booting. Surfacing `/wake/status` in the UI would fix that.
- **No cold-start prefetch.** Opening the app does not pre-warm; only a real
  request does.
- **One VM.** Two browsers hitting it at once is fine; two VMs is not modelled.

## If you would rather not run this at all

RunPod Serverless does the wake and the sleep itself, with per-second billing
and no proxy to maintain. It is the better choice unless you want control over
when the machine sleeps, or you dislike paying a cold start inside a session.
This proxy keeps one pod warm for the whole session and naps between sessions,
which suits a writing afternoon better than per-request scaling does.

## Tests

```bash
python3 -m pytest -q
```

Twenty tests. Eleven over the lifecycle: one wake per burst, no stop with a generation
in flight, idle stop, activity resetting the clock, the hard cap, re-waking
after a sleep, and awake-time accounting. Mutation-checked — removing the lock
turns the burst test red (10 starts instead of 1), and removing the in-flight
guard kills a generation mid-sentence.

The fake VM yields to the event loop in every method on purpose: without that,
the concurrency test passes even with the lock removed and proves nothing.

Nine more cover `RunPodController` against a faked REST API: status mapping,
the documented routes and bearer token, address discovery, a booting pod that
has no address yet, an API error raised rather than mistaken for "stopped",
and the port-remap hazard. That last test stops the pod *externally* on
purpose — written the other way round (calling `stop()` first) it passes even
when `start()` forgets to drop the cached address, because `stop()` clears it
too. Both were checked by mutation.
