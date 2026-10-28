#!/usr/bin/env bash
# Starts one Partner's enclave on the parent instance. Never with
# --debug-mode: a debug enclave's console is open to the host, its PCRs read
# as zeros, and both the sealing key and -verify-enclave refuse it.
#
#   partner/pack/enclave/run-enclave.sh agent-enclave.eif 16
#
# The CID must match the host process's -cid (oolix-enclave-host@.service).
set -euo pipefail

EIF="${1:?the enclave image file}"
CID="${2:?the enclave CID, e.g. 16}"

nitro-cli run-enclave \
  --eif-path "${EIF}" \
  --enclave-cid "${CID}" \
  --cpu-count "${ENCLAVE_CPUS:-2}" \
  --memory "${ENCLAVE_MEMORY_MIB:-4096}"
nitro-cli describe-enclaves
