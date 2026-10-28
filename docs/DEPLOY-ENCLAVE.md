# Hosting a Partner's Agent in an AWS Nitro Enclave

For Partners with no servers of their own (docs/DESIGN-PARTNER-DATA.md §4,
phase 6). Oolix runs the machine; the Partner's data stays out of Oolix's
reach because the Agent runs in a **Nitro Enclave** — a part of the machine
with no network interface, no disk and no way in for the operator — and AWS's
hardware signs a statement of exactly which image it runs.

## What it proves, and what it does not

| A Partner can check                                                                                                                                                                          | How                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The enclave on their hostname runs the published Agent image, built in public CI from this repository                                                                                         | `oolix-agent -verify-enclave https://<host> -measurements enclave-measurements.json`: an attestation document signed by AWS's Nitro root, its PCRs, a fresh nonce |
| TLS — the setup page, and their backend's calls — ends inside the enclave, not on Oolix's host                                                                                              | The attestation binds the hash of the TLS key the page is served with; `-verify-enclave` compares it with the key it spoke to                                      |
| Their database connection is encrypted and checked end to end                                                                                                                               | The hosted Agent refuses any database connection without TLS and a valid certificate (`verify`), and connection strings that could turn it off                     |
| The enclave is not in debug mode (whose console the host can read)                                                                                                                          | Debug enclaves report all-zero PCRs; verification and the sealing key both refuse them                                                                             |

**The limit, stated plainly:** the Agent's saved settings (including the
database password, itself encrypted) are sealed with a KMS key in Oolix's AWS
account, whose policy releases it only to the published images' PCR0. Oolix's
KMS administrators could edit that policy. Every edit is recorded in
CloudTrail, the policy is published with each release, and the key's
administrators cannot use it to decrypt — but a Partner relies on that
process, not on mathematics, for this one point. A Partner who will not is
better served by the self-hosted Agent, where nothing leaves their network.

## Architecture

```
 Partner's browser / backend ──TLS──►  :443 / :8443  ┐
                                                    │  enclave-host (parent instance)
 Partner's database  ◄──TLS── egress, by policy ────┤  forwards bytes; keeps sealed state;
 Oolix API, ACME, KMS ◄──TLS──                       │  relays role credentials
                                                    └──vsock── Nitro Enclave: the Agent +
                                                               PostgreSQL, all in memory
```

- **In** — `enclave-host` forwards TCP 443 (setup page, and ACME's TLS-ALPN
  challenge) and 8443 (the private API) to the enclave over vsock. TLS
  terminates inside, with a certificate issued by Let's Encrypt to a key made
  inside.
- **Out** — every connection the Agent opens goes through the host as
  `CONNECT host:port`. The host refuses private, link-local (the metadata
  service) and carrier-grade-NAT addresses, and ports the Agent does not use;
  a Partner's private database is allowed by name with `-allow`.
- **State** — settings, the local store's key, the Agent's private key and
  the certificate are sealed (AES-256-GCM under a data key KMS wraps) every
  30 seconds when they change, and kept by the host. On start, the enclave
  asks KMS to unwrap the data key for its attestation document; KMS answers
  encrypted to a key made inside the enclave. The customer copy is never
  sealed: it lives in the enclave's memory, and a restart refreshes it from
  the Partner's database.
- **What the host chooses** — only the hostname. Oolix's API address and the
  sealing key are build arguments, inside the measured image.

## One-time setup

1. **The sealing key.** Create a symmetric KMS key in `ap-south-1` with
   `partner/pack/enclave/kms-key-policy.json`, filling in the account, the
   two roles and the current release's PCR0 (from its
   `enclave-measurements.json`). Publish the policy with the release.
2. **The roles.** `oolix-enclave-host`: the instance role, with `kms:Encrypt`
   and `kms:Decrypt` on that key and nothing else. `oolix-kms-admin`: manages
   the key, cannot decrypt.
3. **The image.** In GitHub, set the repository variables `API_BASE_URL` and
   `ENCLAVE_KMS_KEY` (the key's ARN). The `enclave-image` CI job then builds
   `agent-enclave.eif` and `enclave-measurements.json` on every push to main
   and signs the measurements (`enclave-measurements.json.sigstore`). Attach
   all three to each release.
4. **The instance.** An enclave-capable instance (e.g. `m6i.xlarge`) with
   Nitro Enclaves enabled, Amazon Linux 2023, `dnf install
   aws-nitro-enclaves-cli`, and `/etc/nitro_enclaves/allocator.yaml` giving
   enclaves the memory and CPUs below. Security group: 443 and 8443 in; out,
   443 and the database ports.

## Per Partner

1. DNS: `<partner>.agents.oolix.in` → the instance's public address.
2. `/etc/oolix-enclave/<partner>.env`:

   ```
   CID=16
   HOSTNAME=acme.agents.oolix.in
   ALLOW=
   FORWARD=443:443,8443:8443
   ```

   One enclave per instance with these ports; for several, give each its own
   CID and ports.
3. `systemctl enable --now oolix-enclave-host@<partner>` (the unit is
   `partner/pack/enclave/oolix-enclave-host@.service`; the binary is
   `enclave-host-linux-amd64` from CI).
4. `partner/pack/enclave/run-enclave.sh agent-enclave.eif 16` — memory to suit
   the Partner's copy, `ENCLAVE_MEMORY_MIB=8192` for a few million
   customers. **Never `--debug-mode`.**
5. Send the Partner `https://<partner>.agents.oolix.in/` and the release's
   `enclave-measurements.json`. A self-hosted Agent writes its setup password
   to its log, but an enclave's log cannot be read outside debug mode — so a
   hosted Agent has none until it is **claimed**: the first visitor pastes a
   one-time code from their Oolix portal's Agents page, which registers the
   Agent to their organisation (the code works once), and chooses the
   password. Nobody at Oolix ever sees it. The rest of the setup is the same
   as self-hosted. Start the enclave when the Partner is ready to claim it.
6. The Partner allows the instance's public address on their database, which
   must accept TLS with a valid certificate. Their backend calls the private
   API on `https://<partner>.agents.oolix.in:8443/private/v1/ad-decision`,
   **with the token from the setup page** (`Authorization: Bearer …`): a
   hosted Agent asks for it on every route but health.

## Upgrading

1. Add the new release's PCR0 to the key policy, next to the current one.
2. Stop the enclave (`nitro-cli terminate-enclave`), start the new EIF. It
   unseals the old state — its PCR0 is now allowed — and seals it again.
3. Remove the old PCR0 from the policy. Publish the policy.

## Before the first Partner: check on a real instance

The pieces are tested in CI against stand-ins (a fake Nitro PKI and KMS, TCP
in place of vsock). These need one run on real hardware, in this order:

- [ ] `nitro-cli build-enclave` in the CI job produces measurements (the job
      runs only once the repository variables exist).
- [ ] The enclave starts: loopback up, PostgreSQL in memory, the Agent asks
      the host for its hostname (`enclave-host` logs the connection).
- [ ] The certificate is issued through the host (TLS-ALPN-01 on 443).
- [ ] `-verify-enclave` passes against the real attestation, with AWS's root.
- [ ] KMS returns `CiphertextForRecipient` as CMS EnvelopedData with
      RSAES-OAEP and AES-256-CBC, as `internal/enclave/cms.go` expects; the
      state survives `terminate-enclave` and a new `run-enclave`.
- [ ] A Partner database over the internet and one over a private link
      (`-allow`).
