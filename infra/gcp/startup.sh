#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose-v2 curl jq python3 ca-certificates
systemctl enable --now docker
device=/dev/disk/by-id/google-fleet-data
for _ in $(seq 1 60); do
  [[ -b "$device" ]] && break
  sleep 2
done
[[ -b "$device" ]]
if ! blkid "$device" >/dev/null; then
  mkfs.ext4 -L fleet-data "$device"
fi
mkdir -p /srv/fleet
if ! mountpoint -q /srv/fleet; then mount "$device" /srv/fleet; fi
disk_uuid=$(blkid -s UUID -o value "$device")
if ! grep -q "UUID=$disk_uuid " /etc/fstab; then
  printf 'UUID=%s /srv/fleet ext4 defaults,nofail 0 2\n' "$disk_uuid" >> /etc/fstab
fi
mkdir -p /srv/fleet/releases /srv/fleet/state/reports
touch /var/lib/fleet-bootstrap-ready
