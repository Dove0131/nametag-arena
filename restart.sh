#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"
bash stop.sh
sleep 2
bash start.sh
