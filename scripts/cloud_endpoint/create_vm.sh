#!/usr/bin/env bash
#
# Create (first run) or start the on-demand model VM that wake_proxy.py drives.
#
# PROVISIONING IS DELIBERATELY ON-DEMAND, NOT FLEX-START.
# The mahjong project defaults to DWS flex-start because it is 45% cheaper for
# long training runs. It is the wrong model here, for two reasons recorded in
# LLM_Mahjong/docs/gcp_compute_cost_and_quota.md:
#   * flex-start's termination action is DELETE — the VM disappears when the
#     run ends, so there is nothing to wake up;
#   * "flex-start VM 若被停机后重启，配额不足会立即失败（不像创建会排队）" —
#     a restart does not queue for capacity the way a creation does.
# A wake/sleep loop needs stop/start to be boring and reliable. That costs
# roughly $4.5/h against flex's $2.25/h, and it is the price of the pattern.
#
# The weights live on the boot disk on purpose: a wake is then a boot plus a
# local load, not a re-download of ~90 GB.
set -euo pipefail

PROJECT_ID="${WAKE_GCP_PROJECT:-workstation-185016}"
ZONE="${WAKE_GCP_ZONE:-us-central1-b}"
VM_NAME="${WAKE_GCP_INSTANCE:-canvas-llm}"
MACHINE_TYPE="${MACHINE_TYPE:-g4-standard-48}"   # 1x RTX PRO 6000 (Blackwell, 96GB)
IMAGE_FAMILY="${IMAGE_FAMILY:-common-cu129-ubuntu-2204-nvidia-580}"
IMAGE_PROJECT="deeplearning-platform-release"
BOOT_DISK_GB="${BOOT_DISK_GB:-300}"              # ~90GB weights + venv + room

if gcloud compute instances describe "$VM_NAME" --project="$PROJECT_ID" --zone="$ZONE" &>/dev/null; then
  echo "VM $VM_NAME exists — starting it."
  gcloud compute instances start "$VM_NAME" --project="$PROJECT_ID" --zone="$ZONE"
else
  echo "Creating $VM_NAME ($MACHINE_TYPE) in $ZONE…"
  gcloud compute instances create "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family="$IMAGE_FAMILY" \
    --image-project="$IMAGE_PROJECT" \
    --boot-disk-size="${BOOT_DISK_GB}GB" \
    --boot-disk-type=pd-balanced \
    --maintenance-policy=TERMINATE \
    --scopes=storage-rw,logging-write,monitoring-write \
    --metadata="install-nvidia-driver=True"
  echo
  echo "Now provision it once (see README.md §Setup):"
  echo "  gcloud compute ssh $VM_NAME --project=$PROJECT_ID --zone=$ZONE"
fi

gcloud compute config-ssh --project="$PROJECT_ID" > /dev/null
echo "Internal IP: $(gcloud compute instances describe "$VM_NAME" --project="$PROJECT_ID" \
  --zone="$ZONE" --format='value(networkInterfaces[0].networkIP)')"
