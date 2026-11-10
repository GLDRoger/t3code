# Kin assets

`scripts/kin-brand.ts` copies every file here, except this README, to the same path in the branded copy. A file here whose path doesn't exist upstream fails the run, so a moved upstream asset shows up at the next sync.

Kin's icon is the hearth: a roof over one ember, cream (`#FFF1DC`) and amber (`#FFB238`) on night (`#182543`). Its source is `branding/source/kin-icon.svg`, and the Icon Composer layer `assets/prod/app-icon.icon/Assets/text.svg` is the same mark. `black-ios-1024.png` is that bundle exported with Icon Composer's `ictool` (iOS, Default rendition); the rest are drawn from the source at each size. Keep each file's size and format, because the builds read them as they are. The Android adaptive background and notification tint are colours in `apps/mobile/app.config.ts`, set by text rules in `rules.yaml`.

Besides images, this folder replaces a few files that carry T3 Code's identity:

- `apps/web/src/components/T3Wordmark.tsx` and `apps/mobile/src/components/T3Wordmark.tsx`: a text "Kin" wordmark with the same props, until a drawn one exists. `sourceAssets` in `rules.yaml` holds each upstream file's sha256; when upstream changes one, the run fails until you review the change, update the asset, and set the new hash.
- `apps/desktop/resources/linux/com.t3tools.t3code.metainfo.xml`: Kin's Linux app metadata. The .deb installs it as `com.gldroger.kin.metainfo.xml`.

The copy has no `.well-known` app-link files (`remove` in `rules.yaml`), so a server running Kin claims no app. Add Kin's own here once it has an Apple team and signing key, and drop them from `remove`.

## Expected files

Each file replaces the upstream file at the same path. Rows marked **Kin** are in this folder; the rest still ship upstream's T3 artwork.

| Path                                               | Size                 | Format                               | Used for                                                                          |
| -------------------------------------------------- | -------------------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| `assets/prod/black-ios-1024.png`                   | 1024×1024            | PNG, RGBA                            | Mobile app icon (iOS and Android legacy), mobile splash, Expo web favicon **Kin** |
| `assets/prod/app-icon.icon/`                       | Icon Composer bundle | `icon.json` plus `Assets/text.svg`   | iOS app icon (iOS 26 layered icon) **Kin**                                        |
| `assets/prod/black-macos-1024.png`                 | 1024×1024            | PNG, RGBA                            | macOS desktop icon (the build makes `icon.icns` from it)                          |
| `assets/prod/black-universal-1024.png`             | 1024×1024            | PNG, RGBA                            | Linux desktop icon                                                                |
| `assets/prod/t3-black-windows.ico`                 | 16 to 256 px         | ICO with 7 PNG sizes                 | Windows desktop icon                                                              |
| `assets/prod/t3-black-web-favicon.ico`             | 16 to 256 px         | ICO with 7 PNG sizes                 | Hosted web `favicon.ico` **Kin**                                                  |
| `assets/prod/t3-black-web-favicon-16x16.png`       | 16×16                | PNG, RGBA                            | Hosted web `favicon-16x16.png` **Kin**                                            |
| `assets/prod/t3-black-web-favicon-32x32.png`       | 32×32                | PNG, RGBA                            | Hosted web `favicon-32x32.png` **Kin**                                            |
| `assets/prod/t3-black-web-apple-touch-180.png`     | 180×180              | PNG, RGBA                            | Hosted web `apple-touch-icon.png`, splash logo **Kin**                            |
| `assets/prod/t3-black-web-icon-192x192.png`        | 192×192              | PNG, RGBA                            | Hosted web install icon **Kin**                                                   |
| `assets/prod/t3-black-web-icon-512x512.png`        | 512×512              | PNG, RGBA                            | Hosted web install icon **Kin**                                                   |
| `apps/web/public/favicon.ico`                      | 16 to 256 px         | ICO with 7 PNG sizes                 | Locally served web (`npx t3`, desktop) **Kin**                                    |
| `apps/web/public/favicon-16x16.png`                | 16×16                | PNG, RGBA                            | Locally served web. **Kin**                                                       |
| `apps/web/public/favicon-32x32.png`                | 32×32                | PNG, RGBA                            | Locally served web **Kin**                                                        |
| `apps/web/public/apple-touch-icon.png`             | 180×180              | PNG, RGBA                            | Locally served web, boot splash logo **Kin**                                      |
| `apps/web/public/icon-192x192.png`                 | 192×192              | PNG, RGBA                            | Locally served web install icon **Kin**                                           |
| `apps/web/public/icon-512x512.png`                 | 512×512              | PNG, RGBA                            | Locally served web install icon **Kin**                                           |
| `apps/mobile/assets/android-icon-foreground.png`   | 432×432              | PNG, RGBA, mark inside the safe zone | Android adaptive icon foreground, quick-action icon **Kin**                       |
| `apps/mobile/assets/android-icon-mark.png`         | 432×432              | PNG, RGBA, one colour on transparent | Android themed (monochrome) icon **Kin**                                          |
| `apps/mobile/assets/android-notification-icon.png` | 96×96                | PNG, white on transparent            | Android notification icon **Kin**                                                 |
| `apps/mobile/assets/android-splash-icon-prod.png`  | 1152×1152            | PNG, RGBA, mark in the central third | Android 12+ splash **Kin**                                                        |
| `apps/mobile/assets/widget/T3Mark.svg`             | 111×74 viewBox       | SVG                                  | Logo inside the iOS widgets **Kin**                                               |

The dev and nightly variants (`assets/dev/`, `assets/nightly/`, `android-*-dev.png`, `android-*-nightly.png`) can stay upstream's until Kin ships those channels.
