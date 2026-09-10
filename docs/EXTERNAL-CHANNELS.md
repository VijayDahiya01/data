# Meta and Google activation

Spec §15, §16, §47, §48. Read this before switching either channel on.

## The shape, in one paragraph

A Partner approves a campaign for Meta or Google. Oolix does **not** sign a
manifest yet. The Channel Eligibility Service checks the account relationship,
the granted scopes, the capabilities the platform actually confirmed, consent,
and the Partner's own policy. Only if every check passes does Oolix sign the
manifest — and the manifest is the Partner Agent's authority to read the
segment. The Agent then reads the audience **from the Partner's own database**,
hashes the identifiers locally, and uploads them straight to the platform.
Oolix stores the resulting audience id and a status. It never sees a customer
identifier and never holds a platform credential.

```
Partner approves
      |
      v
Channel Eligibility Service  ── not eligible ──> activation FAILED, no upload,
      |                                          Buyer offered owned media
   eligible
      |
      v
Oolix signs the manifest ──> Partner Agent
                                  |
                             reads the materialized segment (Partner's own DB)
                             normalizes + SHA-256 hashes locally
                                  |
                                  v
                          Meta / Google  (direct, using the Partner's credential)
                                  |
                             resource id + counts
                                  v
                               Oolix
```

## Why the credential lives with the Partner

§17: "raw audience data and ingestion credentials execute inside Partner Agent;
Oolix stores account IDs, authorization state, resource IDs and non-sensitive
configuration."

This is what lets the product keep its central claim while Meta and Google are
in use. Oolix knows the ad account *number*; only the Agent holds the token
that acts on it. The connection API **rejects** any field that looks like a
credential — `token`, `secret`, `refresh`, `client_secret` and similar — so it
cannot be stored centrally even by accident.

---

## Setting it up

### 1. Register the connection with Oolix

Both sides register: the Partner holds the audience, the advertiser holds the
page and pays.

```http
PUT /v1/channel-connections/META
{
  "account_ids":      { "business_id": "...", "ad_account_id": "..." },
  "scopes":           ["ads_management"],
  "capability_flags": { "customer_list_audiences": true }
}
```

**Capability flags are discovered, not asserted.** A flag that is absent is
treated exactly like one that is `false`. §15 warns against assuming universal
eligibility, and "we never checked" is not evidence of permission. Set them
from what the platform actually reported.

Status is derived, never accepted: a connection whose `expires_at` has passed
is `EXPIRED` regardless of what was posted.

### 2. Tell the Agent where matching identifiers live

In the Agent's own config — never in Oolix:

```yaml
channels:
  meta:
    enabled: true
    access_token_secret_ref: 'secret://meta-access-token'
    ad_account_id: '1234567890'

  export:
    identity_table: 'oolix_match_identities'
    fields:
      email: email_address
      phone: phone_e164
```

**A field you leave out is one the Agent cannot read**, not one it chooses not
to send (§47.9). Leaving the whole `export` block out means no external upload
is possible, which is the correct default.

This table is deliberately *not* the attribute table. That one holds targeting
attributes — age band, city code, loyalty tier — and holds no contact details
at all, because the ad-decision path never needs them and a table without an
email address cannot leak one.

### 3. Run the eligibility check

Automatic on approval. To re-run after fixing a connection:

```http
POST /v1/activations/{id}/eligibility-check
```

The response lists **every** check with its result, not just the first failure.
Connecting an ad account is slow enough that one round trip per missing scope
is a bad experience.

---

## What blocks an upload

Every one of these is a hard stop, and each names itself in the response:

| Check | Blocks when |
| --- | --- |
| `channel_enabled` | the deployment has the channel flag off |
| `partner_connection_present` / `_healthy` / `_unexpired` | no connection, or it is expired, revoked or errored |
| `partner_account_ids_present` | a required account id is missing |
| `partner_scopes_granted` | a required scope was not granted |
| `partner_capabilities_confirmed` | the platform did not confirm a needed capability |
| `advertiser_identity_present` | (Meta) the advertiser has not connected its assets |
| `consent_basis` | segment consent is not `ELIGIBLE` |
| `segment_permits_channel` | the Partner did not publish the segment for this channel |
| `partner_policy_permits` | policy prohibits external use, or blocks this advertiser |

`MIXED` consent fails as firmly as `UNAVAILABLE`. Oolix cannot see which
members carry a lawful basis — only the Agent can — so it cannot upload "the
eligible part". Splitting such a segment is the Partner's decision to make
deliberately.

---

## Stopping

A kill switch, a revocation or an end date does not merely stop the Agent
answering. The audience is already inside Meta or Google, and a campaign
running there is not stopped by anything the Agent declines to do. All three
trigger a **removal** from the platform.

For Meta the membership is cleared rather than the audience deleted: a Custom
Audience referenced by a live ad set cannot be deleted, and attempting it fails
in a way that leaves the members in place — the opposite of what revocation
needs.

---

## Operating notes

**Watch the skip count.** Every sync reports `accepted` and `skipped`. A high
skip rate means members had no usable identifier, which almost always means the
`export.fields` mapping is wrong. The visible symptom otherwise is only that
the campaign under-delivers. The API logs a warning above 50%.

**Refresh is slow on purpose** — six hours. Membership changes on the order of
a day and platform ingestion is rate-limited; re-uploading a large audience
every thirty seconds would exhaust a Partner's quota to no purpose.

**Audience names never describe the segment.** They name the activation. An
audience called "high-value lapsed customers" tells everyone with access to the
ad account something the Partner never agreed to publish.

---

## Before the first real upload

These cannot be completed by writing code, and none of them is optional.

- [ ] **Meta App Review** for `ads_management`, a Business Manager, an ad
      account, and a system-user token
- [ ] **Google Data Manager API** access, a developer token, and an Ads account
      whose policy and payment history clears Customer Match (§16.2)
- [ ] **Verify the API contracts against current documentation.** §48.2 says
      so explicitly. The batch limits, the normalization rules and the Data
      Manager request shape in this implementation follow the documented
      behaviour at the time of writing, and a normalization change is invisible
      until match rates drop.
- [ ] **Confirm the account topology** — who owns the ad account, who owns the
      page and identity assets, who pays, and who may read reporting (§47's
      "Meta account-model decision for pilot"). Do this for one Partner and one
      Buyer before scaling the connector.
- [ ] **Privacy and legal review.** This is the path on which customer data
      leaves the Partner's boundary, hashed but real. It is a different
      conversation from the owned-media pilot and needs its own sign-off.

Until the first two exist, "it works" means "it matches the documented
contract and the tests pass against a faithful fake" — not "it uploaded to a
real ad account".
