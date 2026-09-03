# Encrypted cloud backup

Zyn's encrypted cloud backup is available to every signed-in user under **Settings → Backup &
Restore**. The desktop performs all serialization, compression, encryption, and decryption. The
Cloudflare service receives only an authenticated encrypted envelope and bounded metadata needed to
list and verify revisions.

## Compatibility and encryption

- Existing `RCART1.` recovery keys and `RCARTB1` backup objects from the original app remain valid.
- A random 256-bit recovery key is protected locally with Electron `safeStorage` and is never sent
  to Cloudflare.
- Each revision uses a new salt and nonce, derives an AES-256-GCM key with HKDF-SHA256, and binds the
  authenticated header as additional data.
- JSON is gzip-compressed before encryption. The desktop rejects oversized, malformed, unknown,
  future-version, or unauthenticated payloads before import.
- New cloud bundles keep the original inner compatibility marker so a rollback to the original app
  can still read them.

The recovery key is the only way to decrypt a backup. Zyn displays only its short fingerprint after
setup. The full key can be copied or saved only through a main-process action; it is not returned to
the renderer or uploaded. Copying also requires a separate native confirmation. Importing an older
recovery key adds it to the account's local keyring for restores without replacing the active upload
key.

## Data scope

Encrypted revisions include local profiles and payment details, account and mailbox passwords,
saved site login cookies, user-owned solver/API credentials, local proxy lists, settings,
last-order timestamps, tasks, watchlists, Round1/Pokémon Center data, and supported task groups.

They deliberately exclude the Zyn license/session, bearer/device/observer tokens, and
server-managed proxy credentials. Profile/account credentials are exported in portable
form only inside the encrypted envelope and are passed back through their owning storage adapters on
restore so the destination device re-encrypts them locally. Saved site login cookies restore as
plaintext on the account, matching local storage, so the next Start can reuse the session.

Only Target task groups can run in the current Zyn task-group engine. Restore preview reports exact
supported and skipped legacy groups before confirmation instead of silently claiming they were
restored.

## Account and restore safety

- Backup settings and recovery-key rings are bound to the server-issued user UUID, not email.
- Account changes pause scheduling and invalidate in-flight API operations.
- A legacy global backup state must be claimed explicitly. The rollback-compatible source remains
  bound to that account, while Zyn migrates a copy into its account-scoped keyring.
- Automatic schedules support 15 minutes, 30 minutes, 1 hour, 6 hours, or 24 hours. Unchanged data
  is deduplicated with a recovery-keyed local tag.
- Restore validates and plans every section before the first write. It journals every affected file,
  restores the exact prior bytes after any failure, and recovers an interrupted journal at startup.
- Replace mode also retains up to five encrypted pre-restore safety snapshots locally.

## Cloudflare storage contract

The Worker stores metadata in D1 and opaque envelopes in the private `rcart-encrypted-backups` R2
bucket. Ownership comes only from the authenticated license token. Objects are scoped by user UUID,
the newest ten revisions are retained, and uploads are limited to 30 per account per hour.

New objects are created conditionally and carry an R2 SHA-256 receipt. Downloads verify R2 size and
checksum, the full body SHA-256, D1 metadata, and authenticated envelope header before returning
bytes. Legacy objects without the newer R2 custom metadata remain readable after full-body and D1
verification. Reconciliation removes failed-write orphans without racing active uploads.

Relevant verification commands:

```bash
node scripts/cloud-backup-smoke-test.cjs
node scripts/cloud-backup-data-smoke-test.js
node scripts/license-authority-smoke-test.js
npm --prefix cloudflare/license test
```
