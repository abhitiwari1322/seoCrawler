# Windows Testing Build

This app uses Tauri with a Node.js crawler sidecar. Build Windows installers on Windows so Tauri can package the correct `.exe` sidecar binary.

## Option 1: Build With GitHub Actions

1. Commit and push the repository to GitHub.
2. Open the repository on GitHub.
3. Go to **Actions**.
4. Select **Windows Build**.
5. Click **Run workflow**.
6. After the workflow finishes, open the run details.
7. Download the `scout-seo-crawler-windows` artifact.
8. Extract the zip.
9. Install the `.exe` from `nsis`, or the `.msi` from `msi` if generated.

This is the recommended path because the build machine is clean and Windows-native.

## Option 2: Build Directly On Your Windows Laptop

Install:

- Node.js 20 LTS
- Git
- Rust stable from `https://rustup.rs`
- Microsoft Visual Studio Build Tools with the C++ desktop workload
- WebView2 Runtime, if Windows does not already have it

Then run:

```powershell
git clone <your-repo-url>
cd <repo-folder>
npm ci
npm run tauri:build
```

The installer output will be here:

```text
src-tauri\target\release\bundle\nsis\
src-tauri\target\release\bundle\msi\
```

Use the NSIS `.exe` installer first for testing.

## What To Test

- App opens without a blank window.
- Start, pause, resume, and stop crawl.
- Site crawl mode.
- Uploaded URL-list crawl mode.
- CSV export writes to `Downloads`.
- Exported CSV includes the new SEO columns.
- Compare report accepts a previous Scout CSV.
- PageSpeed disabled crawl.
- PageSpeed enabled crawl, if an API key is available.

## Notes

- Windows may show a security warning because the installer is not code-signed yet.
- For internal testing, click **More info** and **Run anyway**.
- For public distribution, add code signing before sharing broadly.
