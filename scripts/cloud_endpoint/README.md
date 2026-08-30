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
                     └── llama.cpp + Qwen3.8-Flash-Next-Uncensored IQ3_XXS
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

## Machine and model — llama.cpp, not vLLM

Both backends land on the same card: an RTX PRO 6000 (Blackwell, 96 GB). The
model that fits it is the **IQ3_XXS GGUF, 79.3 GiB**, served by llama.cpp.

That is not the obvious choice, so here is why the obvious one is wrong. vLLM
and SGLang do support this architecture (`qwen4exp`, SGLang day-0), which
argues for a safetensors build — but every published uncensored build is too
big for 96 GB:

| build | size | fits 96 GB |
|---|---|---|
| orcarouter NVFP4 | 170.9 GiB | no |
| mazinb NVFP4 | 173.6 GiB | no |
| dealignai NVFP4 | 125.9 GiB | no |
| FP8 | 172.8 GiB | no |
| **IQ3_XXS GGUF** | **79.3 GiB** | **yes**, ~16 GiB left for KV |

The "NVFP4" repos are not 4-bit in any useful sense — they are the size of the
FP8 export. Checked against the Hugging Face blob listing, not assumed.

llama.cpp is also the stack already proven on this architecture: the CUDA path
was measured end to end on the workstation. vLLM's path here has never been
run.

## Cost, honestly

With a 15-minute idle stop, at RunPod's $2.09/h (GCE's $4.5/h in brackets):

| writing per day | GPU hours/month | cost/month |
|---|---|---|
| 1 h in one sitting | ~38 | **~$79** ($170) |
| 2 h in one sitting | ~68 | **~$142** ($305) |
| 2 h split into 4 sittings | ~83 | **~$174** ($375) |

### Storage is the monthly floor

Compute stops when the pod stops; storage does not.

| | running | **stopped** |
|---|---|---|
| network volume | $0.07/GB/mo | **$0.07/GB/mo — still billed** |
| pod volume disk | $0.10/GB/mo | **$0.20/GB/mo — the rate doubles** |

A 150 GB network volume is therefore **~$10.50/month whether or not you write
a word**. That is the price of a wake being a boot rather than a 79 GiB
download; terminating the pod between sessions removes it and turns every
first request into twenty minutes.

So "no monthly fee" is not strictly true here. It is about ten dollars.

Fragmented sessions cost more: each gap under 15 minutes is paid for, each gap
over it costs a fresh wake. A Mac Studio with 128 GB is $4,499 — break-even
somewhere between 12 and 26 months depending on how you write.

The proxy tracks this: `GET /wake/status` reports wakes, sleeps, and total
awake seconds.

## Setup — RunPod

0. **Validate first, before creating anything that bills monthly.** Rent an
   RTX 6000 Pro pod with a container disk, run `validate_pod.sh` on it, then
   `measure.py` against it. About two dollars, and it answers the only two
   questions that matter: does 79 GiB of weights leave a usable context on a
   96 GB card, and is prefill actually faster than the workstation's. See
   "Storage is the monthly floor" below for why this step comes first.

1. **Create the pod** in the RunPod console (once): an RTX 6000 Pro, a network
   volume big enough for the weights (~80 GB) plus llama.cpp, and HTTP port
   8000 exposed. Keeping the weights on the volume is what makes a wake a boot
   plus a local load rather than a re-download.

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

## Consider Serverless first — it probably beats this

RunPod Serverless does the wake and the sleep itself. Checked against what
people actually run: a light Docker image containing `llama-server`, the GGUF
pulled onto a network volume on first boot, and an OpenAI-compatible endpoint
with streaming. Community harnesses exist for exactly this shape (abliterated
Qwen GGUFs among them) to copy from.

| | this proxy + a pod | serverless |
|---|---|---|
| lifecycle | our code, our bugs | the platform's |
| billing | per second running | per second running |
| **storage floor** | network volume, ~$10/mo | **the same volume, same $10** |
| cold start | boot the machine, then load | **60–90s** — image cached, weights on the volume |
| work to build | a shell script on the pod | **a Docker image with a handler** |

Two things that surprised us. The storage floor does not go away: the weights
have to sit on a network volume either way, or every cold start re-downloads
79 GiB. And serverless's cold start is *faster* than this proxy's, because
nothing has to boot — the worker is placed onto an image that is already
cached.

So serverless is the better default for this workload. This proxy earns its
place for the other one: a whole GPU machine you occasionally need for
something that is not an inference endpoint — which is what the mahjong
project wants — or when you would rather keep one pod warm across a writing
afternoon than pay a cold start whenever you pause to think.

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
