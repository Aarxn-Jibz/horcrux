#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
binary="$root/apps/node/horcrux-node"
state="$root/.demo-production"
mkdir -p "$state"
(cd "$root/apps/node" && go build -o horcrux-node ./cmd/horcrux-node)

pids=()
cleanup() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup INT TERM EXIT

for number in 1 2 3 4 5; do
  config="$HOME/.config/Horcrux-demo/node-$number"
  if [[ ! -f "$config/node.json" ]]; then
    echo "Node $number is not enrolled. Create its command in https://horcruxfs.pages.dev → Devices → Add device."
    exit 1
  fi
  "$binary" start --config-dir "$config" >"$state/node-$number.log" 2>&1 &
  pids+=("$!")
  echo "node $number pid=${pids[-1]} config=$config log=$state/node-$number.log"
done
printf '%s\n' "${pids[@]}" >"$state/pids"
echo "Stop node N: kill -TERM \$(sed -n 'Np' $state/pids)"
echo "Ctrl+C stops all five nodes."
wait
