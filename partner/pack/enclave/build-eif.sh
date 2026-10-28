#!/usr/bin/env bash
# Builds the enclave image file and prints its PCRs -- the measurements a
# release publishes, and that `oolix-agent -verify-enclave` checks.
#
#   API_BASE_URL=https://api.oolix.in KMS_KEY=arn:aws:kms:... VERSION=v1.4.0 \
#     partner/pack/enclave/build-eif.sh
#
# Writes agent-enclave.eif and enclave-measurements.json in the current
# folder. Needs Docker and nitro-cli (Amazon Linux: dnf install
# aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel); building needs no
# enclave hardware, only running does.
set -euo pipefail

: "${API_BASE_URL:?set API_BASE_URL to Oolix's API}"
: "${KMS_KEY:?set KMS_KEY to the sealing key's ARN}"
VERSION="${VERSION:-$(git describe --tags --always)}"
ROOT="$(git rev-parse --show-toplevel)"
TAG="oolix/agent-enclave:${VERSION}"

docker build -f "${ROOT}/partner/pack/enclave/Dockerfile.enclave" \
  --build-arg VERSION="${VERSION}" \
  --build-arg API_BASE_URL="${API_BASE_URL}" \
  --build-arg KMS_KEY="${KMS_KEY}" \
  --build-arg KMS_REGION="${KMS_REGION:-ap-south-1}" \
  -t "${TAG}" "${ROOT}"

nitro-cli build-enclave --docker-uri "${TAG}" --output-file agent-enclave.eif > enclave-measurements.json
cat enclave-measurements.json
