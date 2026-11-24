# Releasing Rulebox

How to cut a release, what each secret and variable is, what to send SignPath, and how anyone
verifies a download. The pipeline is `.github/workflows/release.yml` (plan:
`docs/plans/phase-6-installer-pilot.md`, Step 9).

## Policy: unsigned until SignPath approves

- Until the SignPath application is approved **and** the signing variable is on, every release is
  **unsigned**. The MSI is named `Rulebox-<version>-x64-unsigned.msi` and the release notes say so.
- Never rename an unsigned file to drop `-unsigned`. The name must tell the truth.
- Unsigned builds are for test PCs and the one-laptop pilot (plan Q2). The group pilot needs a
  signed build.
- When signing is on, the MSI is `Rulebox-<version>-x64.msi` and the three executables inside it
  are signed too. Release notes drop the warning by themselves.

## Cut a release

1. **Check main.** The last run of your normal checks is green and the plan step you are releasing
   is committed.
2. **Dry run first (recommended).** GitHub, Actions, Release, "Run workflow", enter `x.y.z`. It
   builds, tests and packages everything and leaves the files as a workflow artifact. It publishes
   nothing.
3. **Tag.** The owner (nobody else, and no tool) runs:

   ```powershell
   git tag v0.1.0
   git push origin v0.1.0
   ```

   Tags are `vX.Y.Z`, or `vX.Y.Z-rc1` for a prerelease. The MSI uses only `X.Y.Z` (Windows Installer
   ignores a fourth field), and a prerelease suffix marks the GitHub release as a prerelease.
4. **Wait.** The run takes a long time (a full release build plus all tests). It tests first, so a
   failure is quick.
5. **Check the release page.** It must hold `Rulebox-<version>-x64[-unsigned].msi` and `SHA256SUMS`.
   Download both and verify (below) before you tell anyone.
6. **Re-running** the same tag replaces the files and keeps the release.

What the workflow does, in order: tests (Rust workspace, the production-guard test with the feature
on, JavaScript, MSI source checks), release build of the agent and launcher with the production
guard (`rulebox-win32/production`, the feature the agent's `production` feature forwards to), release
build of the Staff App, WiX v7 install and EULA acceptance, MSI build, optional SignPath steps,
`SHA256SUMS`, release publish, optional website rebuild.

## Secrets and variables

Set these in GitHub, Settings, Secrets and variables, Actions. Nothing here is ever committed.

| Name | Kind | Needed for | What it is |
|---|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | secret | later (nothing reads it today) | Private key for the Tauri update **format** signature (PRD 23.8). Create it once, on your own PC, outside the repository: `pnpm --filter @rulebox/staff-app tauri signer generate -w <path outside the repo>`. Paste the key file's content as the secret. The matching public key is not secret and will go into `tauri.conf.json` when updater artifacts are switched on. Back the key up in a password manager; if it is lost, a new key means new installs. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secret | with the key | The password you gave the key. |
| `SIGNPATH_API_TOKEN` | secret | signing | API token of the SignPath user that submits requests (SignPath, user settings). |
| `SIGNPATH_ENABLED` | variable | signing | Set to `true` only when SignPath approved and the five values below are filled in. Anything else keeps signing off. |
| `SIGNPATH_ORGANIZATION_ID` | variable | signing | The organization id shown in SignPath. |
| `SIGNPATH_PROJECT_SLUG` | variable | signing | The SignPath project. |
| `SIGNPATH_SIGNING_POLICY_SLUG` | variable | signing | The signing policy (for example a release policy that needs an approval). |
| `SIGNPATH_BINARIES_CONFIGURATION_SLUG` | variable | signing | Artifact configuration that signs the `.exe` files at the root of a zip. |
| `SIGNPATH_MSI_CONFIGURATION_SLUG` | variable | signing | Artifact configuration that signs the `.msi` at the root of a zip. |
| `WEBSITE_REBUILD` | variable | website | `true` makes the last step send a `repository_dispatch` (event type `rulebox-release`, payload `tag` and `version`) that the website workflow listens for. Off by default. |
| `WEBSITE_DISPATCH_REPO` | variable | website, optional | `owner/name` when the website lives in another repository. Default: this repository. |
| `WEBSITE_DISPATCH_TOKEN` | secret | website, optional | A token allowed to dispatch to that other repository. Not needed for this repository (the built-in workflow token can send a `repository_dispatch`). |

`GITHUB_TOKEN` is built in; the release job asks for `contents: write` and nothing more.

The workflow files reference the updater key only as `secrets.TAURI_SIGNING_PRIVATE_KEY`. It reaches
the one Staff App build step and nothing else.

## WiX EULA

WiX v7 will not run until its Open Source Maintenance Fee EULA is accepted. The workflow has a
visible, commented step for that, and `build.ps1 -AcceptEula` passes `-acceptEula wix7`. The record
(who accepted, when, which version) and the fee rule live in
`apps/installer/README.md`, section "WiX v7 EULA (OSMF) record". Fill the record in before the first
tag. The fee is due once revenue from projects that use WiX reaches US$10,000 a year.

## SignPath application

The owner submits this. SignPath Foundation's current terms and form are at
<https://signpath.org/> (read them first; the requirements below are from memory and may have
changed). Needs, as far as known: an OSI-approved licence, a public repository with a build on
hosted CI, a public code-signing policy on the project's page, and no proprietary components in the
signed files.

Text to adapt:

> **Project:** Rulebox, <https://github.com/zubairbinshaukat/rulebox>
>
> **What it is:** Open-source (MIT) kiosk OS for Windows. It turns a PC into a locked, branded
> workstation, managed from a web dashboard. The installable parts are a Windows service (the agent,
> written in Rust), a launcher and a desktop app (Tauri), packaged as one per-machine MSI built with
> WiX.
>
> **Why signing:** Without a signature, Windows SmartScreen warns every administrator who installs
> Rulebox, and Smart App Control blocks unsigned files. Rulebox is installed by people who manage
> other people's PCs (shops, schools, libraries), so an unsigned installer is a real barrier to
> adoption and to trust.
>
> **Licence:** MIT. All signed files are built from this repository. No proprietary components are
> signed. Third-party notices are in `THIRD_PARTY_NOTICES.md`.
>
> **Build:** GitHub Actions, `.github/workflows/release.yml`, on `windows-latest`, from a version
> tag. The workflow submits two signing requests: the executables (`rulebox-agent.exe`,
> `rulebox-shell.exe`, `rulebox-staff.exe`), then the MSI built from them. Checksums
> (`SHA256SUMS`) are published with each release.
>
> **Team and roles:** *Confirm before sending.* Maintainer and sole committer: the repository owner
> (GitHub: zubairbinshaukat), acting as author, reviewer and approver. Approvals use an account with
> multi-factor authentication.
>
> **Code signing policy:** published in the project README, section "Code signing policy".
>
> **Privacy:** Rulebox sends no data to its authors. Each installation connects only to the Convex
> deployment its own administrator set up. See the policy section in the README.
>
> **Contact:** *add the owner's contact email.*

After approval: create the SignPath project, signing policy and the two artifact configurations
named in the table above, set the secret and the variables, then run a dry run with
`SIGNPATH_ENABLED` set to `true`. The SignPath steps in the workflow have **never run**; the action
version and its input names must be checked against the action's README on the first real run.

The certificate's subject will name SignPath, not Rulebox. That is why Rulebox's own publisher rules
(plan 4.13, Step 9 item 5) must match product name and file name and never the publisher alone. Those
rules wait for a real certificate and are not part of the pipeline yet.

## Verify a download

Every release has a `SHA256SUMS` file, one line per file: `<sha256>  <file name>` (two spaces,
lower-case hex).

In PowerShell, in the folder with both files:

```powershell
$name = 'Rulebox-0.1.0-x64-unsigned.msi'
$expected = ((Get-Content SHA256SUMS) | Where-Object { $_ -match "  $([regex]::Escape($name))$" }) -split '\s+' | Select-Object -First 1
$actual = (Get-FileHash $name -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -eq $expected) { 'OK: the hash matches' } else { "MISMATCH: expected $expected, got $actual" }
```

With a Unix-style tool (Git Bash, WSL): `sha256sum -c --ignore-missing SHA256SUMS`.

`SHA256SUMS` comes from the same release page as the MSI, so it proves the download was not damaged,
not that the release page itself is genuine. The website's download page shows the same hash from a
second place, and a signed build adds the Windows signature check (right-click the MSI, Properties,
Digital Signatures).
