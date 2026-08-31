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
| **IQ3_XXS GGUF** | **79.3 GiB** | **yes** — and by a wider margin than expected, see Measured |

The "NVFP4" repos are not 4-bit in any useful sense — they are the size of the
FP8 export. Checked against the Hugging Face blob listing, not assumed.

llama.cpp is also the stack already proven on this architecture: the CUDA path
was measured end to end on the workstation. vLLM's path here has never been
run.

### Which "RTX 6000 Pro" — the catalog lists three

They are not interchangeable, and the cheapest is the one you cannot get. From
RunPod's catalog API, all three 96 GB:

| `gpuTypeIds` value | secure | community | stock | host CUDA |
|---|---|---|---|---|
| `NVIDIA RTX PRO 6000 Blackwell Server Edition` | **$2.09** | $1.69 | **HIGH** | 13.2 |
| `NVIDIA RTX PRO 6000 Blackwell Workstation Edition` | $1.89 | $1.69 | LOW, `EU-CZ-1` only | 13.0 |
| `NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition` | $0.50 | $1.64 | **NONE** | — |

**Server Edition** is the one to ask for: it is the only one with real stock,
and its $2.09 is the number the cost table above is built on. The Workstation
Edition's $1.89 saves 10% but exists in one data centre at LOW availability —
a wake that cannot find a card is not a wake.

Ask for it by the exact id, not the display name (`RTX PRO 6000` and
`RTX PRO 6000 WK` both render as "RTX 6000 Pro" in conversation, and they are
different machines).

## Measured — 2026-08-30

Rented an RTX PRO 6000 Server Edition for 46 minutes (**$1.60**), ran
`validate_pod.sh` then `measure.py`, deleted the pod. No network volume was
created. Both questions came back yes, and one by much more than expected.

| | workstation | this pod | |
|---|---|---|---|
| context | 262144 | **262144** | full — the *first* rung of the ladder held |
| cold prefill | 137 tok/s | **2540 tok/s** | **18.5×** |
| generation | 18.8 tok/s | **110.5 tok/s** | **5.9×** |

VRAM at 262144 context: **59,727 MiB of 97,887**. Not a squeeze — 37 GiB spare.

On a prompt the shape the app actually sends (36,442 tokens of a book-sized
sticky prefix):

| | prefill | |
|---|---|---|
| cold, first send | **11.78 s** | 3,094 tok/s |
| same prefix, new question | **0.25 s** | 35,926 of 36,442 tokens served from cache |

That 47× gap is the single most important number here, and it is what the
serverless question below turns on.

Output was checked for coherence, not just speed — the model returns
well-formed Chinese prose, so the rates above are measuring real work.

### The verdict — quality loses to grok, and that ends it (2026-08-30)

A second pod ($3.4, deleted) served IQ3_XXS, IQ4_XS and Q4_K_M side by side
through the app's new RunPod provider tab, and the user wrote with them
against grok. **Even Q4_K_M — the largest quant a 96 GB card holds — is far
below grok's quality, and the economics don't survive that.** $79–174/month
buys prose worse than a per-token frontier model; the two things the pod
does win, uncensored output and first-token latency (0.69 s on a cache hit
against grok's measured 45–199 s), are covered well enough by the free local
27B for the one and not worth the delta for the other.

Speed and fit were measured before renting; quality could only be judged by
writing with it, and it failed there. The split in `local_model/README.md`
stands: local model for uncensored single-chapter work, grok for structure
and quality. Revisit only if a materially better uncensored model ships in
under ~90 GiB — the validation script and this README make the re-test a
~$2, one-hour question.

### Why it fits so easily: the PLE table never goes to the GPU

The 96 GB card is not holding 79 GiB of weights. It is holding 52.5.

This architecture (`qwen4exp`) carries a **per-layer embedding table indexed by
3-grams** — 16 heads, ~20 million entries each:

```
qwen4exp.ple.ngram_size        = 3
qwen4exp.ple.heads_per_ngram   = 8
qwen4exp.ple.head_vocab_sizes  = [20000003, 20000023, ... ]   # 16 heads
```

It is by far the largest tensor in the file, and llama.cpp leaves it on the
host, mmap'd, because a sparse lookup does not belong in VRAM:

| | GiB |
|---|---|
| `per_layer_token_embd.weight` — the n-gram table | **26.82** |
| expert FFN (`ffn_down/gate/up_exps`) | 49.81 |
| everything else | 2.71 |
| **total on disk** | **79.34** |
| **of which sent to VRAM** | **52.52** |

52.52 GiB of weights + 5.81 GiB of KV and compute buffers = 58.33 GiB, which is
the 59,727 MiB `nvidia-smi` reports. The accounting closes.

**This is why the full 262144 context fits**, and the earlier "~16 GiB left for
KV" guess was wrong: a quarter of the model was never going to compete with the
KV cache for VRAM in the first place.

**It also puts a condition on the network-volume plan.** Those 26.82 GiB are
read by random per-token lookups out of an mmap'd file. On this pod that file
sat on a local container disk behind 1.5 TB of page cache, which is the
best case. Put the GGUF on a network volume and the same lookups become network
storage reads until the page cache is warm. Before committing to the volume,
confirm the pod tier you rent has enough RAM to cache 27 GiB — and treat the
first request after a wake as slower than the 11.78 s measured here.

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

0. **Validate first, before creating anything that bills monthly.** ✅ **Done
   2026-08-30 — see "Measured" above. $1.60, pod deleted, no volume created.**
   Kept here because it is the step to repeat if the model or the card changes.
   Rent an
   RTX 6000 Pro pod with a **container** disk (not a network volume), run
   `validate_pod.sh` on it, then `measure.py` against it. About two dollars,
   and it answers the only two questions that matter: does 79 GiB of weights
   leave a usable context on a 96 GB card, and is prefill actually faster than
   the workstation's. See "Storage is the monthly floor" below for why this
   step comes first.

   The exact pod, pre-checked against the catalog:

   | field | value |
   |---|---|
   | `gpuTypeIds` | `["NVIDIA RTX PRO 6000 Blackwell Server Edition"]` |
   | `cloudType` | `SECURE` |
   | `imageName` | `runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404` |
   | `containerDiskInGb` | `200` (79 GiB of weights + the build, with room) |
   | `ports` | `["8000/http", "22/tcp"]` |
   | `sshPublicKey` | contents of `~/.ssh/id_rsa.pub` |

   Then, on the pod — the two slow steps run concurrently, so this is one
   wait of ~20 minutes rather than two of ~15:

   ```bash
   HF_TOKEN=$(cat ~/.cache/huggingface/token) bash validate_pod.sh
   ```

   **This needs a funded RunPod balance.** A zero-balance account fails the
   create with `402 Payment Required` after every catalog call has succeeded,
   so the key looking fine proves nothing about whether a pod can start.

   **SSH in on the *direct* endpoint, not the proxy.** A pod created with
   `sshPublicKey` gets that key in its `PUBLIC_KEY` env, which only the direct
   endpoint honours:

   | | authenticates against | works here |
   |---|---|---|
   | `ssh <id>-<hash>@ssh.runpod.io` | keys in RunPod **account settings** | no |
   | `ssh root@<ip> -p <port>` | the pod's **`PUBLIC_KEY`** | **yes** |

   `ssh.direct` is `null` in the create response and only appears once
   `runtime` does (~5 min), so re-read the pod rather than using the proxy
   command the create handed back. And never poll with stderr suppressed: the
   proxy's `Permission denied (publickey)` is instant and permanent, but with
   `2>/dev/null` it is indistinguishable from "still booting" and a retry loop
   will burn its whole budget on it.

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

## Serverless — considered, and it loses on the prefix cache

RunPod Serverless does the wake and the sleep itself. Checked against what
people actually run: a light Docker image containing `llama-server`, the GGUF
pulled onto a network volume on first boot, and an OpenAI-compatible endpoint
with streaming. Community harnesses exist for exactly this shape (abliterated
Qwen GGUFs among them) to copy from.

| | this proxy + a pod | serverless |
|---|---|---|
| lifecycle | our code, our bugs | the platform's |
| **rate** | **$2.09/h** | **$3.49/h — 67% more for the same card** |
| **what is billed** | wall-clock while running | **only while a request executes** |
| **storage floor** | network volume, ~$10/mo | **the same volume, same $10** |
| cold start | boot the machine, then load | **60–90s** — image cached, weights on the volume |
| work to build | a shell script on the pod | **a Docker image with a handler** |

Three things that surprised us.

The storage floor does not go away: the weights have to sit on a network
volume either way, or every cold start re-downloads 79 GiB. And serverless's
cold start is *faster* than this proxy's, because nothing has to boot — the
worker is placed onto an image that is already cached.

**Serverless is not the same price per second.** An earlier draft of this table
claimed both bill "per second running", which made serverless look like a free
win. It is $3.49/h against the pod's $2.09/h for an RTX PRO 6000 — confirmed
against both RunPod's catalog API (`price.serverless`) and the public pricing
page. What makes it cheaper anyway is the *other* half of that row: a pod bills
wall-clock from boot to stop, so it charges for the writer's thinking time,
while serverless charges only while a request is actually executing.

### Scaling to zero throws away the prefix cache

This is the part that decides it, and it is now measured. llama.cpp keeps the
KV of a shared prompt prefix **in the worker's memory**. The app's sticky
whole-book prefix is byte-identical turn over turn, so on a warm server the
second and every later turn skips the prefill entirely:

| | prefill | to first token |
|---|---|---|
| warm — prefix still cached | **0.25 s** | immediate |
| cold — cache gone | **11.78 s** | plus a 60–90 s worker cold start |

A network volume persists *files*, not process memory. When a serverless worker
scales to zero the process dies and that cache dies with it. **A 5-second idle
timeout therefore discards it on every pause longer than five seconds** — which
is every pause, since a writer reads the reply before answering. Each turn then
pays the cold column: a cold start, then 11.78 s of prefill that a warm server
would have skipped.

So the two configurations are not a cost trade-off, they are a different
product:

| 1 h session, 20 turns, ~2 min of thinking between them | billed | first token |
|---|---|---|
| **pod, warm throughout** ($2.09/h) | 1 h + 15 min tail = **$2.61** | **0.25 s** |
| serverless, 5 s idle ($3.49/h) | only executing time — **cheaper** | **60–90 s, every turn** |
| serverless, idle long enough to hold the cache | wall-clock at $3.49/h = **$3.78** | 0.25 s |

Serverless is cheaper **only** in the configuration that destroys the cache, and
the configuration that preserves it costs more than the pod for the same
wall-clock. The rate premium and the cache are the same problem seen twice.

**What is still a guess:** whether RunPod bills flex-worker cold-start time, and
the real duty cycle of a writing session (turns per hour, gap lengths). Both
shift the middle row. The prefill numbers above are measured; that row's
"cheaper" is not quantified.

So the earlier verdict is reversed. **A warm pod is the right default for
this workload** — it is the cheaper of the two ways to keep a prefix cache
alive, and this app's whole performance story is that cache. Serverless stays
the better answer for a stateless endpoint, where there is no prefix to lose.

That also means the wake proxy is doing real work rather than duplicating the
platform: holding one pod warm across a writing session, and stopping it when
the session ends, is exactly the lifecycle serverless will not give us at this
price.

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
