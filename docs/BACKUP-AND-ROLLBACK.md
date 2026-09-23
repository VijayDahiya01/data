# Backups, restore, and rolling back

Three separate things that people reach for in the same moment:

| Situation | What you actually want |
| --- | --- |
| The new release is bad | **Release rollback** — redeploy the previous image tag |
| The new release migrated the schema and is bad | **Restore** — the migration cannot be undone |
| Data was lost or corrupted | **Restore** |

The middle row is the one that catches people out, and it is why a backup is
taken *before* every migration rather than nightly only.

---

## What a backup contains

`oolix/infra/backup/backup.sh` captures three things:

1. The Oolix database — campaigns, approvals, activations, manifests
2. The Keycloak database — who can sign in, and as what
3. **The signing keys**

The third is the one that gets forgotten, and it is the one that cannot be
regenerated. Every manifest a Partner Agent has cached was signed by the
manifest key. Lose it and every Agent rejects every manifest it already holds —
a database restore does not fix that, and no error anywhere says "the key
changed".

```sh
./oolix/infra/backup/backup.sh /var/backups/oolix
```

Each run writes a timestamped directory with the two dumps, the key archive, a
`manifest.txt` naming the image tag and the last applied migration, and
`SHA256SUMS`. Empty dumps are treated as failures: a zero-byte file from a
full disk is otherwise indistinguishable from a successful backup of an empty
database.

**Schedule it, and put the output somewhere the deployment host cannot reach.**
A backup on the same disk as the database survives exactly the failures that
do not matter.

---

## Restoring

```sh
./oolix/infra/backup/restore.sh /var/backups/oolix/20260903T032609Z
```

It verifies the checksums first and refuses a damaged backup rather than
replaying half of it. Then it stops the applications, drops and recreates both
databases, restores the keys into the volume the API mounts, and starts
everything again.

### This has been drilled, not just written

On 2026-09-03, against the full stack: a backup was taken, then **both
databases were dropped and every signing key deleted**, then restored. Result:

| Check | Outcome |
| --- | --- |
| API health | healthy |
| Marker row written before the backup | present |
| Manifest signing key | same `kid` as before |
| Manifest JWKS over HTTPS | 200 |
| Keycloak realm | 200 |

One defect surfaced only by doing it: the key archive is `0600` and owned by
whoever took the backup, so the unprivileged service account could not read it.
The restore failed **after** the databases were already back — the worst
possible moment. Fixed by extracting as root and handing ownership back.

---

## Rolling back a release

Images are addressed by tag, so a rollback is a redeploy of the previous one.

```sh
# In .env.prod
IMAGE_TAG=<the previous tag>
```

```sh
docker compose -f oolix/infra/docker/compose.prod.yml --env-file .env.prod up -d
```

**Only safe if the release did not migrate the schema.** The old code will run
against the new schema, and Prisma has no down migrations: `migrate deploy` is
forward-only by design. If the bad release migrated, the route back is the
restore above, not a tag change.

This is why the deploy order matters:

1. **Back up.** Note the migration named in `manifest.txt`.
2. Deploy the new tag. The `migrate` service runs to completion first, and a
   failed migration stops the deployment rather than leaving one replica
   serving against a half-migrated schema.
3. If it goes wrong:
   - schema unchanged → change `IMAGE_TAG` back and `up -d`
   - schema changed → restore from the backup taken in step 1

### Use immutable tags

`IMAGE_TAG=dev` is fine for a drill and useless for a rollback: the tag moves,
so "the previous image" stops existing the moment it is rebuilt. Tag releases
with something that never moves — a commit SHA, or a date and build number —
so that rolling back names a specific artefact rather than a hope.

---

## Scheduling

The stack runs backups itself — the `backup` service in
`oolix/infra/docker/compose.prod.yml`, every 24 hours by default. It is on by
default rather than opt-in, because a backup that depends on somebody
remembering is not a backup.

It talks to Postgres over the network rather than shelling into the container,
so it needs no Docker socket. Mounting that socket into a long-lived service is
handing it root on the host, and a backup job is an odd thing to give root to.

**`BACKUP_DEST` must leave this host.** An NFS mount, an object-storage
gateway — anything but this disk. A backup beside the database survives only
the failures that do not matter. `pnpm preflight` refuses a local path.

It refuses to write a backup it knows is useless: an empty dump is an error,
and a missing signing-key archive is an error, because a backup without the
keys restores a system that cannot serve. Failures are announced on stdout as
`BACKUP FAILED -- this is an alertable condition`; point your log collector at
that string.

## What is still manual

**Off-host replication.** The scheduler writes to whatever `BACKUP_DEST`
points at. Getting that somewhere durable — and the retention policy beyond
the local `BACKUP_KEEP` — belongs to whatever owns the destination.

**Rehearsing the restore.** It has been drilled once here, destructively. Do
it again on the real deployment before a Partner's data is in it. A backup
nobody has restored is a hypothesis.
