# Zyn license service

The production service is deployed on both domain families during the Zyn migration:

- Admin: <https://license.rcart.app/admin/> and <https://license.zynbot.app/admin/>
- API/health: <https://license.rcart.app/health> and <https://license.zynbot.app/health>
- Website: <https://rcart.app> and <https://zynbot.app>
- Updates: <https://updates.rcart.app> and <https://updates.zynbot.app>
- D1 database: `hope-license` (`a6aa8a05-ca0c-4d7d-beca-ba1ba0f906f8`)

## Admin access

The admin password is generated locally, stored in macOS Keychain under the service
`com.thwebco.hope.license-api`, and uploaded as a Worker secret. Retrieve it without putting it in
the repository:

```sh
security find-generic-password -a admin-password -s com.thwebco.hope.license-api -w
```

The admin page can:

- review waiting-list signups and invite them with a complete ready-to-copy message;
- create a user and generate a one-time temporary password;
- generate a seven-day, single-use link to the private Zyn download page;
- create and edit encrypted managed proxy lists;
- grant or remove a user's access to all managed proxy lists;
- enable optional task types globally or override Pokémon Center/Round1 access per user;
- revoke all active licenses for a user;
- generate a new temporary password (also revokes active licenses);
- disable or re-enable an account; and
- permanently delete a user and their licenses.

Send temporary passwords through a private channel. The password is only returned by the create or
reset response and is not recoverable from D1 afterward.

Download links contain a 256-bit random key. D1 stores only its SHA-256 hash, and generating a new
unused link invalidates the older unused link for that account. The download page uses an explicit
unlock step so email and chat link-preview scanners cannot consume the key with a GET request. A
successful unlock replaces it with an HttpOnly, 24-hour browser session; disabling or deleting the
account invalidates that session.

The public website accepts waiting-list email addresses at <https://rcart.app/join> and
<https://zynbot.app/join>. Each site forwards to the matching license-service domain. Submissions are
normalized and deduplicated in D1, and the public response does not reveal whether an address was
already present. Inviting an entry in Admin creates its Zyn account when needed, generates a
seven-day single-use download link, marks the waiting-list entry invited, and shows one copyable
invitation. New-account invitations include the one-time temporary password; existing accounts keep
their current password. Removing a waiting-list entry does not delete its Zyn account.

## User flow

1. The admin creates the user's email and shares the generated temporary password.
2. The user signs into Zyn.
3. The first login requires a new password of at least 10 characters.
4. The API mints one active license for that user and device, revoking any earlier active license.
5. Zyn validates the license every five minutes. A definite revoke or disable immediately returns
   the app to its sign-in gate and stops running tasks. Transient network failures have a bounded
   15-minute grace period.

When `proxy_access` is enabled for a user, login returns the current managed proxy lists. Every
five-minute validation sends the revision already in memory; an unchanged revision returns only a
small metadata response, while an admin edit returns the complete new lists. The desktop keeps one
copy of credentials in main-process memory, exposes only names/counts to normal renderer screens,
and never writes managed lists to `proxies.json` or a backup. Removing access clears the lists on the
user’s next validation without revoking the app license.

Optional task types are denied by default. The admin page has a global default for each registered
type and a per-user override with Enabled, Disabled, or Use global. Effective access is returned on
login and every five-minute license validation. If access is removed, the desktop hides the module,
blocks new launches in the main process, and stops that module’s running tasks. Target remains the
always-available base task type. Enabling a type globally clears existing per-user denies so every
current user receives it; individual users can be disabled again afterward.

Each managed list accepts up to 50,000 proxies or 5 MB of raw text. Contents are gzip-compressed and
then AES-256-GCM encrypted before they are stored in D1, avoiding D1's 2 MB row limit for normal
large pools. Existing uncompressed encrypted rows remain readable. The encryption key is
kept in the Worker secret `PROXY_ENCRYPTION_KEY` and this Mac's Keychain under the account
`proxy-encryption-key`; losing or rotating it makes existing lists unreadable, so preserve it with
the other license-service secrets.

Passwords use PBKDF2-SHA256 plus a Worker-only pepper. D1 stores only hashes of passwords, reset
tokens, license bearer tokens, download keys, and download sessions. The desktop bearer token is
encrypted with Electron `safeStorage` and never enters renderer settings or exports.

Encrypted account backups use a private object bucket plus D1 metadata. The desktop gzip-compresses
the portable data bundle, encrypts it with AES-256-GCM using a locally held recovery key, and uploads
only the encrypted envelope. Recovery keys are protected locally with Electron `safeStorage` and are
never sent to the service. Objects are scoped by user UUID and the newest ten revisions are retained.

## Operations

From the repository root:

```sh
# First deployment only:
npm run license:storage:create

npm run license:configure
npm run license:migrate
npm run license:deploy
npm run license:verify
```

- `license:configure` preserves existing Keychain values, generating only missing secrets, and syncs
  them to Cloudflare.
- `license:storage:create` creates the private encrypted-backup bucket. Run it once; later runs will
  report that the bucket already exists.
- `license:migrate` applies pending D1 migrations remotely.
- `license:deploy` deploys the Worker and static admin assets.
- `license:verify` creates a disposable waiting-list entry, invites it, and tests the website form,
  single-use download access, account-disable invalidation, first-login reset, minting, validation,
  encrypted proxy delivery/removal, revocation, rejection, and cleanup using the same API client
  embedded in Zyn.

For a schema change, add a new numbered SQL file under `migrations/`; do not edit an already-applied
migration.
