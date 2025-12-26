# CEF Build macOS

Pre-built and code-signed [Chromium Embedded Framework (CEF)](https://bitbucket.org/chromiumembedded/cef) client binaries for macOS.

## Why This Repository?

The official CEF builds from [cef-builds.spotifycdn.com](https://cef-builds.spotifycdn.com/index.html) are not code-signed, which means:
- macOS Gatekeeper will block the app from running
- Users see scary "unidentified developer" warnings
- The app may be quarantined or require manual security bypass

This repository provides the same CEF client builds, re-signed with an Apple Developer ID certificate, making them ready to use on macOS without security warnings.

## Integrity Verification

**We have not modified the CEF binaries in any way other than code signing.**

You can verify this yourself using the included verification script, which:
1. Downloads the original unsigned build from Spotify's CDN
2. Verifies the download using SHA1 checksums from the official index
3. Compares all files, properly handling Mach-O binaries to ignore signature-only differences
4. Confirms that only code signing changes were made

## Quick Start

### Download a Release

Download the latest `cefclient.zip` from the [Releases](https://github.com/wowlocal/cef-build-macos/releases) page.

### Verify Integrity (Optional but Recommended)

```bash
# Clone this repo or download the scripts
git clone https://github.com/wowlocal/cef-build-macos.git
cd cef-build-macos

# Verify the downloaded release
node verify-cef-integrity.js /path/to/cefclient.zip
```

## Scripts

### `verify-cef-integrity.js`

Verifies that a re-signed CEF build matches the original from cef-builds.spotifycdn.com.

```bash
node verify-cef-integrity.js <local-zip> [cef-version]
```

**Arguments:**
- `local-zip` - Path to the re-signed cefclient.zip
- `cef-version` - (Optional) CEF version like `73.1.5`. Auto-detected from the app's Info.plist if omitted.

**Example:**
```bash
node verify-cef-integrity.js cefclient.zip
```

**Output:**
```
=== CEF Build Integrity Verification ===

Step 1: Extracting local archive...
Detected CEF version: 73.1.5

Step 2: Finding original CEF build...
Found: cef_binary_73.1.5+g4a68f1d+chromium-73.0.3683.75_macosx64_client.tar.bz2
Expected SHA1: 77a518e286e40e0b6d7d9a25670c21fa9f58b8a6

Step 3: Downloading original CEF build...
Download complete.
Verifying SHA1 checksum...
✅ SHA1 verified: 77a518e286e40e0b6d7d9a25670c21fa9f58b8a6

Step 4: Extracting original archive...

Step 5: Comparing files (ignoring signatures)...

=== Verification Results ===

✅ Files with signature-only changes (expected):
   - Contents/MacOS/cefclient
   - Contents/Frameworks/Chromium Embedded Framework.framework/...
   - ...

Files compared: 106
Matching: 99
Signature-only changes: 7
Content modified: 0
Missing: 0

✅ VERIFICATION PASSED: Build matches original (signature changes only)
```

### `download-release.js`

Downloads assets from GitHub releases.

```bash
node download-release.js <owner> <repo> <tag> <asset-name> [output-path]
```

**Example:**
```bash
node download-release.js wowlocal cef-build-macos 73 cefclient.zip
```

## How Verification Works

The verification script handles the complexity of comparing signed vs unsigned Mach-O binaries:

1. **Archive Verification**: Downloads are verified against SHA1 checksums from the official CEF builds index
2. **File Comparison**: All non-binary files are compared byte-for-byte
3. **Mach-O Binary Comparison**: For executables and dylibs, the script:
   - Parses Mach-O headers using `otool`
   - Extracts and hashes actual code sections (`__text`, `__data`, etc.)
   - Ignores `__LINKEDIT` segment (contains signature data)
   - Ignores Mach-O header changes (new `LC_CODE_SIGNATURE` load command)
   - Ignores zerofill sections (`__bss`, `__common`)
4. **Signature Files**: `_CodeSignature/` directories and `CodeResources` files are excluded from comparison

## Available Releases

| Tag | CEF Version | Chromium Version | Architecture |
|-----|-------------|------------------|--------------|
| 73  | 73.1.5      | 73.0.3683.75     | x86_64       |

## Building Your Own

If you want to sign CEF builds yourself:

1. Download the client distribution from [cef-builds.spotifycdn.com](https://cef-builds.spotifycdn.com/index.html)
2. Extract the archive
3. Sign with your Developer ID:

```bash
# Sign all nested components first, then the main app
codesign --deep --force --verify --verbose \
  --sign "Developer ID Application: Your Name (TEAMID)" \
  --options runtime \
  cefclient.app
```

4. Verify the signature:
```bash
codesign --verify --deep --strict --verbose=2 cefclient.app
spctl --assess --verbose cefclient.app
```

## Requirements

- Node.js 14+ (for running the scripts)
- macOS (for Mach-O binary analysis using `otool`)

## License

This project is licensed under the **BSD 3-Clause License** - see the [LICENSE](LICENSE) file for details.

This is the same license used by CEF itself, ensuring full compatibility. The LICENSE file includes both:
- License for the scripts in this repository
- The original CEF license (as required for redistribution)
