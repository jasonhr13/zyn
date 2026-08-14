# Zyn bot runtime

This directory contains reviewed, source-controlled bot files that Zyn copies into
`Resources/bot`. It replaces first-party source inherited implicitly from the ignored runtime-base
application.

The Target account generator and the compatibility bots were imported from the release recorded in
`config/account-generator-upstream.json`. Zyn-specific security and integration changes are kept in
these files so the packaged behavior can be reviewed without extracting an installer. Target signup
does not use the legacy SMS client; that file remains only because P-Bandai signup requires SMS.

Third-party dependencies, Chromium builds, generated ASAR files, encrypted proxy pools, and account
credentials do not belong in this directory.
