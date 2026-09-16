#!/usr/bin/env bash
# Grow existing ext4 filesystems after Terraform increases the persistent disks.
# Never format a disk or run this on the governed agent worker.
set -euo pipefail
metadata=http://metadata.google.internal/computeMetadata/v1
[[ $(curl -fsS -H Metadata-Flavor:Google "$metadata/project/project-id") == fleet-governance ]]
[[ $(curl -fsS -H Metadata-Flavor:Google "$metadata/instance/name") == fleet-readside ]]
mountpoint -q /srv/fleet
data_device=/dev/disk/by-id/google-fleet-data
[[ -b "$data_device" ]]
[[ $(readlink -f "$(findmnt -n -o SOURCE /srv/fleet)") == "$(readlink -f "$data_device")" ]]
[[ $(findmnt -n -o FSTYPE /srv/fleet) == ext4 ]]
[[ $(findmnt -n -o FSTYPE /) == ext4 ]]
# /dev/root can be a display alias; resolve the kernel device number instead.
root_device=$(readlink -f "/dev/block/$(findmnt -n -o MAJ:MIN /)")
root_name=$(basename "$root_device")
[[ -f "/sys/class/block/$root_name/partition" ]]
root_partition=$(cat "/sys/class/block/$root_name/partition")
root_parent=$(lsblk -n -o PKNAME "$root_device")
[[ "$root_partition" =~ ^[0-9]+$ && "$root_parent" =~ ^[a-zA-Z0-9]+$ ]]
# growpart returns 1 for an already expanded partition; other failures stop CI.
if output=$(growpart "/dev/$root_parent" "$root_partition" 2>&1); then
  printf '%s\n' "$output"
else
  code=$?
  printf '%s\n' "$output"
  [[ "$code" == 1 && "$output" == NOCHANGE:* ]]
fi
udevadm settle
resize2fs "$root_device"
resize2fs "$data_device"
# Confirm that the guest sees the capacity, not just the Compute Engine API.
for mount in / /srv/fleet; do
  bytes=$(df -B1 --output=size "$mount" | tail -n 1 | tr -d ' ')
  [[ "$bytes" -ge 96636764160 ]] # 90 GiB usable from each 100 GiB disk.
done
df -h / /srv/fleet
free -h
nproc
