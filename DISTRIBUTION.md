# Distributing PulseDeck

How the code gets to GitHub, how people install it from your website, and how updates reach them.

## 1. Put the code on GitHub (one time)

1. On GitHub, create a new **public** repository named `pulsedeck` (no README, no license — the repo already has them).
2. If your GitHub username is not `IsaacHHB`, change it in `package.json` (`homepage`, `repository.url`, and `build.publish[0].owner`) before pushing.
3. From the `pulsedeck` folder:

```bash
git remote add origin https://github.com/IsaacHHB/pulsedeck.git
git push -u origin main
```

That's it — the `Tests` workflow runs on every push.

## 2. Publish a release (every version)

GitHub Actions builds the Windows installer for you on a Windows runner, so you never need to build on your own PC.

```bash
npm version 0.6.0        # bumps package.json and creates the v0.6.0 tag
git push --follow-tags   # pushes the commit and the tag
```

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which:

1. builds `PulseDeck-Setup.exe` (installer) and `PulseDeck-Portable.zip` (portable),
2. creates a GitHub Release for the tag with both files attached, plus `latest.yml` (the file installed copies read to discover updates).

Watch it under the repo's **Actions** tab (about 4–6 minutes). Edit the release afterwards to add notes; those notes are what users see.

Test a release without publishing: `npm run dist` builds into `dist/` locally (Windows only for the installer).

## 3. The download link on your website

The build uses fixed file names, so two stable URLs always point at the newest files — link straight to them from your site:

- Installer: `https://github.com/IsaacHHB/pulsedeck/releases/latest/download/PulseDeck-Setup.exe`
- Portable zip: `https://github.com/IsaacHHB/pulsedeck/releases/latest/download/PulseDeck-Portable.zip`
- Release page with notes and version history: `https://github.com/IsaacHHB/pulsedeck/releases/latest`

GitHub hosts the files on its CDN for free, with unlimited bandwidth for public repos, so your website only needs a button. If you would rather host the `.exe` on your own server, upload the installer *and* `latest.yml` to the same folder and point `build.publish` at that URL with the `generic` provider — but GitHub Releases is less work and is what the updater is configured for.

A minimal button for your site (Laravel Blade or plain HTML):

```html
<a class="btn" href="https://github.com/IsaacHHB/pulsedeck/releases/latest/download/PulseDeck-Setup.exe">
    Download PulseDeck for Windows
</a>
<a href="https://github.com/IsaacHHB/pulsedeck/releases/latest">Release notes &amp; portable version</a>
```

If you want the site to show the current version number automatically, GitHub's public API returns it with no auth:
`GET https://api.github.com/repos/IsaacHHB/pulsedeck/releases/latest` → `tag_name`, `assets[].browser_download_url`. Cache it server-side (Laravel `Cache::remember`) for an hour to stay under the unauthenticated rate limit.

## 4. How users get updates

**Installed copies (the .exe installer): automatic.** The app checks GitHub Releases about 8 seconds after launch and every 4 hours while running. When a newer version exists it downloads in the background and a **Restart to update** button appears in the top bar; the footer shows progress. If they ignore it, the update installs the next time they quit. Nothing happens while a broadcast is live unless they click the button (and then they get a 5-second warning). Users can also click the version in the footer to check manually.

**Portable zip copies: manual.** The zip has no updater. The footer still shows the version and links to the releases page when clicked; people re-download and unzip over the old folder. Their `PulseDeck Data` folder next to the exe is kept.

**Sounds and settings survive updates** — installed builds keep data in `%APPDATA%\PulseDeck\PulseDeck Data`, which the installer never touches.

## 5. Windows SmartScreen and code signing

An unsigned installer shows a blue "Windows protected your PC" SmartScreen warning the first few hundred times it is downloaded; users click **More info → Run anyway**. Mention this on the download page. It goes away on its own once Microsoft's reputation system has seen enough clean installs, but only per version/file — so it returns with every release.

To remove it properly, sign the installer. Two realistic options:

- **Azure Trusted Signing** (~$10/month, identity validation required) — cheapest, and SmartScreen trusts it immediately. electron-builder supports it via the `win.azureSignOptions` config and Azure credentials in repo secrets.
- **An OV/EV code-signing certificate** from a CA (Sectigo, DigiCert, SSL.com; roughly $200–400/year). Store it as the `CSC_LINK` (base64 .pfx) and `CSC_KEY_PASSWORD` secrets and uncomment the two lines in `release.yml`.

Signing also lets electron-updater verify that an update really came from you; with an unsigned app it relies on HTTPS to GitHub alone, which is acceptable for a hobby project but not for wide distribution.

## 6. Checklist for each release

1. Add a section to `WHATS-NEW.md` (optional, but it makes good release notes).
2. `npm test` passes.
3. `npm version 0.6.0 && git push --follow-tags` — the app reads its version from `package.json`, nothing else to bump.
4. Wait for the Release workflow, then edit the GitHub Release to add notes.
5. Installed users update themselves; the website button already points at the newest release.
