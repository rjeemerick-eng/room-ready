# Releasing Room Ready (OTA)

Room Ready auto-updates from **GitHub Releases** using `electron-updater`.
The repo is public, so installed apps download updates with no credentials.

## One-time setup (already done)

- Public repo: `github.com/rjeemerick-eng/room-ready`
- `build.publish` in `package.json` points electron-builder at that repo.
- Mac targets build **both `dmg` and `zip`** — the updater downloads the
  **zip**; a dmg-only release leaves updaters stuck at 0%.
- `artifactName` has no spaces (`Room-Ready-${version}-${arch}.${ext}`) so
  the blockmap upload doesn't 422 on GitHub.

## Cutting a release (run on your Mac)

Your Developer ID cert must be in the login keychain, and notarization
credentials configured (see below). Then:

```bash
# 1. Compile grandiose against Electron once (or after Electron upgrades)
npm install
npm run rebuild-ndi

# 2. Bump the version — this is what tells old apps an update exists.
#    Never publish twice with the same version.
npm version patch      # 1.0.1 -> 1.0.2   (or: minor / major)

# 3. Build, sign, notarize, and upload to GitHub Releases
npm run release
```

`npm run release` runs `electron-builder --mac --publish always`. It creates
(or updates) a **draft** GitHub Release for the new version and uploads the
dmg, zip, and `latest-mac.yml` (the manifest the updater reads).

### Publish the release

electron-builder uploads to a **draft** release by default. Go to the repo's
Releases page and click **Publish** — updaters only see published releases.

## Notarization credentials

electron-builder needs Apple credentials in the environment to notarize.
Set these once (e.g. in your shell profile), using an
[app-specific password](https://support.apple.com/en-us/102654):

```bash
export APPLE_ID="your-apple-id@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="9BX9Z5V9U4"
```

`electron-builder` needs a GitHub token to upload. `gh auth` already provides
one; if a run can't find it, set `GH_TOKEN` to a token with `repo` scope:

```bash
export GH_TOKEN="$(gh auth token)"
```

## How updates reach the board

- On launch (packaged app only), Room Ready checks GitHub, downloads any
  newer version quietly, and re-checks every 6 hours.
- **The board never restarts on its own.** When a download finishes, a dialog
  offers *Install & Restart Now* or *Later*. "Later" installs automatically
  the next time the app is quit normally.
- Running from source (`npm start`, the `.command`/`.bat` launchers) does
  **not** use OTA — update those installs with `git pull`.
- Menu → **Room Ready** app menu → View → **Check for Updates…** forces a
  manual check with feedback.

## Notes / gotchas

- **Unsigned mac builds cannot auto-update** — Squirrel.Mac refuses them.
  The signed, notarized build is required for OTA to work at all.
- The DMG currently uses electron-builder's default background. To restore a
  custom one, drop `build/dmg-background.png` back in and re-add
  `"background": "build/dmg-background.png"` under `build.dmg` in package.json.
- Windows (`npm run release-win`) works unsigned but SmartScreen will warn
  users. Needs `build/icon.ico` present.
