#!/usr/bin/env node

/**
 * Verifies that a re-signed CEF build matches the original from cef-builds.spotifycdn.com
 * by comparing file contents while ignoring code signature differences.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const CEF_BUILDS_INDEX = 'https://cef-builds.spotifycdn.com/index.json';

// Files/patterns to skip when comparing (signature-related)
const SIGNATURE_PATTERNS = [
  '_CodeSignature',
  '.DS_Store',
  'CodeResources',
  'embedded.provisionprofile'
];

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log('Usage: node verify-cef-integrity.js <local-zip> [cef-version]');
    console.log('');
    console.log('Arguments:');
    console.log('  local-zip    Path to your re-signed cefclient.zip');
    console.log('  cef-version  Full CEF version (e.g., 73.1.5) or major version (e.g., 73).');
    console.log('               If omitted, version is auto-detected from the app\'s Info.plist.');
    console.log('');
    console.log('Example:');
    console.log('  node verify-cef-integrity.js cefclient.zip');
    console.log('  node verify-cef-integrity.js cefclient.zip 73.1.5');
    process.exit(1);
  }

  const localZipPath = args[0];
  const cefVersionArg = args[1];

  if (!fs.existsSync(localZipPath)) {
    console.error(`Error: File not found: ${localZipPath}`);
    process.exit(1);
  }

  console.log('=== CEF Build Integrity Verification ===\n');

  // Create temp directory for extraction
  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cef-verify-'));
  const localExtractDir = path.join(tempDir, 'local');
  const originalExtractDir = path.join(tempDir, 'original');

  try {
    // Step 1: Extract local archive first to detect version
    console.log('Step 1: Extracting local archive...');
    fs.mkdirSync(localExtractDir, { recursive: true });
    execSync(`unzip -q "${localZipPath}" -d "${localExtractDir}"`, { stdio: 'pipe' });
    
    const localAppPath = findCefClientApp(localExtractDir);
    if (!localAppPath) {
      throw new Error('Could not find cefclient.app in local archive');
    }
    
    // Detect version from Info.plist if not provided
    let cefVersion = cefVersionArg;
    if (!cefVersion) {
      cefVersion = detectCefVersion(localAppPath);
      console.log(`Detected CEF version: ${cefVersion}`);
    }
    console.log('');

    // Step 2: Find and download original CEF build
    console.log('Step 2: Finding original CEF build...');
    const originalBuild = await findOriginalCefBuild(cefVersion);
    console.log(`Found: ${originalBuild.name}`);
    console.log(`Expected SHA1: ${originalBuild.sha1}`);
    console.log(`Expected size: ${formatBytes(originalBuild.size)}\n`);

    console.log('Step 3: Downloading original CEF build...');
    const originalZipPath = path.join(tempDir, 'original.tar.bz2');
    await downloadFile(originalBuild.url, originalZipPath);
    console.log('Download complete.');
    
    // Verify SHA1 checksum
    console.log('Verifying SHA1 checksum...');
    const actualSha1 = hashFileSha1(originalZipPath);
    if (actualSha1 !== originalBuild.sha1) {
      throw new Error(`SHA1 mismatch!\n  Expected: ${originalBuild.sha1}\n  Actual:   ${actualSha1}`);
    }
    console.log(`✅ SHA1 verified: ${actualSha1}\n`);

    // Step 4: Extract original archive
    console.log('Step 4: Extracting original archive...');
    fs.mkdirSync(originalExtractDir, { recursive: true });
    execSync(`tar -xjf "${originalZipPath}" -C "${originalExtractDir}"`, { stdio: 'pipe' });
    console.log('Extraction complete.\n');

    // Find the cefclient.app in original (it's nested in the tarball)
    const originalAppPath = findCefClientApp(originalExtractDir);

    if (!originalAppPath) {
      throw new Error('Could not find cefclient.app in original archive');
    }

    console.log(`Local app: ${localAppPath}`);
    console.log(`Original app: ${originalAppPath}\n`);

    // Step 5: Compare files
    console.log('Step 5: Comparing files (ignoring signatures)...\n');
    const result = await compareApps(localAppPath, originalAppPath, tempDir);

    // Report results
    console.log('\n=== Verification Results ===\n');
    
    if (result.missingInLocal.length > 0) {
      console.log('❌ Files missing in local build:');
      result.missingInLocal.forEach(f => console.log(`   - ${f}`));
      console.log('');
    }

    if (result.missingInOriginal.length > 0) {
      console.log('⚠️  Extra files in local build (may be expected):');
      result.missingInOriginal.forEach(f => console.log(`   - ${f}`));
      console.log('');
    }

    if (result.modified.length > 0) {
      console.log('❌ Modified files (content differs):');
      result.modified.forEach(f => console.log(`   - ${f}`));
      console.log('');
    }

    if (result.signatureOnly.length > 0) {
      console.log('✅ Files with signature-only changes (expected):');
      result.signatureOnly.forEach(f => console.log(`   - ${f}`));
      console.log('');
    }

    console.log(`Files compared: ${result.matched + result.signatureOnly.length + result.modified.length}`);
    console.log(`Matching: ${result.matched}`);
    console.log(`Signature-only changes: ${result.signatureOnly.length}`);
    console.log(`Content modified: ${result.modified.length}`);
    console.log(`Missing: ${result.missingInLocal.length}`);

    const isValid = result.modified.length === 0 && result.missingInLocal.length === 0;
    
    console.log('\n' + (isValid 
      ? '✅ VERIFICATION PASSED: Build matches original (signature changes only)'
      : '❌ VERIFICATION FAILED: Build has unexpected modifications'));

    process.exit(isValid ? 0 : 1);

  } finally {
    // Cleanup
    console.log('\nCleaning up...');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function detectCefVersion(appPath) {
  const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');
  if (!fs.existsSync(infoPlistPath)) {
    throw new Error('Could not find Info.plist to detect version');
  }
  
  // Use plutil to convert to JSON and parse
  try {
    const jsonOutput = execSync(`plutil -convert json -o - "${infoPlistPath}"`, { encoding: 'utf8' });
    const plist = JSON.parse(jsonOutput);
    const bundleVersion = plist.CFBundleShortVersionString; // e.g., "73.1.5.0"
    if (!bundleVersion) {
      throw new Error('CFBundleShortVersionString not found');
    }
    // Return first 3 components (e.g., "73.1.5")
    const parts = bundleVersion.split('.');
    return parts.slice(0, 3).join('.');
  } catch (e) {
    throw new Error(`Failed to parse Info.plist: ${e.message}`);
  }
}

async function findOriginalCefBuild(version) {
  console.log('Fetching CEF builds index...');
  const index = await fetchJson(CEF_BUILDS_INDEX);
  
  // version can be "73" or "73.1.5"
  const versionParts = version.split('.');
  const majorVersion = versionParts[0];
  const fullVersion = versionParts.length >= 3 ? version : null;
  
  // Look for client distribution matching the version
  for (const platform of ['macosx64', 'macosarm64']) {
    const builds = index[platform]?.versions || [];
    for (const build of builds) {
      if (!build.cef_version) continue;
      
      // Check if version matches
      let matches = false;
      if (fullVersion) {
        // Match exact version like "73.1.5"
        matches = build.cef_version.startsWith(fullVersion + '+');
      } else {
        // Match major version like "73"
        matches = build.cef_version.startsWith(majorVersion + '.');
      }
      
      if (matches) {
        // Find the client distribution file
        const clientFile = build.files?.find(f => f.type === 'client');
        if (clientFile) {
          return {
            url: `https://cef-builds.spotifycdn.com/${clientFile.name}`,
            sha1: clientFile.sha1,
            size: clientFile.size,
            name: clientFile.name
          };
        }
      }
    }
  }

  throw new Error(`Could not find CEF build for version ${version}. Check https://cef-builds.spotifycdn.com/index.html`);
}

function findCefClientApp(dir) {
  // Recursively find cefclient.app
  const find = (currentDir) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'cefclient.app') {
          return fullPath;
        }
        const found = find(fullPath);
        if (found) return found;
      }
    }
    return null;
  };
  return find(dir);
}

async function compareApps(localApp, originalApp, tempDir) {
  const result = {
    matched: 0,
    modified: [],
    signatureOnly: [],
    missingInLocal: [],
    missingInOriginal: []
  };

  const localFiles = getAllFiles(localApp, localApp);
  const originalFiles = getAllFiles(originalApp, originalApp);

  const localSet = new Set(localFiles.map(f => f.relativePath));
  const originalSet = new Set(originalFiles.map(f => f.relativePath));

  // Check for missing files (excluding signature files)
  for (const relPath of originalSet) {
    if (shouldSkipFile(relPath)) continue;
    if (!localSet.has(relPath)) {
      result.missingInLocal.push(relPath);
    }
  }

  for (const relPath of localSet) {
    if (shouldSkipFile(relPath)) continue;
    if (!originalSet.has(relPath)) {
      result.missingInOriginal.push(relPath);
    }
  }

  // Compare matching files
  for (const localFile of localFiles) {
    if (shouldSkipFile(localFile.relativePath)) continue;
    if (!originalSet.has(localFile.relativePath)) continue;

    const originalFile = originalFiles.find(f => f.relativePath === localFile.relativePath);
    
    const comparison = await compareFiles(
      localFile.absolutePath,
      originalFile.absolutePath,
      localFile.relativePath,
      tempDir
    );

    if (comparison === 'match') {
      result.matched++;
    } else if (comparison === 'signature-only') {
      result.signatureOnly.push(localFile.relativePath);
    } else {
      result.modified.push(localFile.relativePath);
    }
  }

  return result;
}

function getAllFiles(dir, baseDir) {
  const files = [];
  
  const walk = (currentDir) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push({
          absolutePath: fullPath,
          relativePath: path.relative(baseDir, fullPath)
        });
      }
    }
  };
  
  walk(dir);
  return files;
}

function shouldSkipFile(relativePath) {
  return SIGNATURE_PATTERNS.some(pattern => relativePath.includes(pattern));
}

async function compareFiles(localPath, originalPath, relativePath, tempDir) {
  const localHash = hashFile(localPath);
  const originalHash = hashFile(originalPath);

  if (localHash === originalHash) {
    return 'match';
  }

  // If hashes differ, check if it's a Mach-O binary (signature difference)
  if (isMachO(localPath)) {
    try {
      // Compare code segments using lipo/otool to extract just the code
      // The __TEXT and __DATA segments contain the actual code
      const localSegmentHash = hashMachOSegments(localPath, tempDir, 'local');
      const originalSegmentHash = hashMachOSegments(originalPath, tempDir, 'original');

      if (localSegmentHash === originalSegmentHash) {
        return 'signature-only';
      }
    } catch (e) {
      // If segment extraction fails, fall through to modified
    }
  }

  return 'modified';
}

function hashMachOSegments(filePath, tempDir, prefix) {
  // Compare actual code sections (__text, __data, etc.) not entire segments
  // because the Mach-O header (part of __TEXT segment) changes when signing
  try {
    const otoolOutput = execSync(`otool -l "${filePath}"`, { encoding: 'utf8' });
    
    // Parse all sections to hash
    const sections = [];
    const sectionRegex = /sectname (\S+)\s+segname (\S+)\s+addr \S+\s+size (\S+)\s+offset (\d+)/g;
    let match;
    while ((match = sectionRegex.exec(otoolOutput)) !== null) {
      const [, sectname, segname, sizeHex, offsetStr] = match;
      const offset = parseInt(offsetStr, 10);
      const size = parseInt(sizeHex, 16);
      
      // Skip sections that might be modified by signing
      if (segname === '__LINKEDIT') continue;
      
      // Skip zerofill sections (offset 0 means they don't exist in file)
      // These include __bss and __common which are uninitialized data
      if (offset === 0) continue;
      
      // Skip empty sections
      if (size === 0) continue;
      
      sections.push({
        name: `${segname}.${sectname}`,
        offset,
        size
      });
    }
    
    if (sections.length === 0) {
      throw new Error('No sections found');
    }
    
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    
    // Hash each section
    for (const section of sections) {
      const buffer = Buffer.alloc(section.size);
      fs.readSync(fd, buffer, 0, section.size, section.offset);
      hash.update(buffer);
    }
    
    fs.closeSync(fd);
    return hash.digest('hex');
  } catch (e) {
    throw new Error(`Failed to hash segments: ${e.message}`);
  }
}

function isMachO(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(4);
    fs.readSync(fd, buffer, 0, 4, 0);
    fs.closeSync(fd);
    
    // Mach-O magic numbers
    const magic = buffer.readUInt32LE(0);
    return (
      magic === 0xFEEDFACE ||  // MH_MAGIC (32-bit)
      magic === 0xFEEDFACF ||  // MH_MAGIC_64 (64-bit)
      magic === 0xCAFEBABE ||  // FAT_MAGIC (universal)
      magic === 0xBEBAFECA     // FAT_CIGAM (universal, swapped)
    );
  } catch (e) {
    return false;
  }
}

function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function hashFileSha1(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha1').update(content).digest('hex');
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'cef-verify' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    
    const request = (url) => {
      https.get(url, { headers: { 'User-Agent': 'cef-verify' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        
        const totalSize = parseInt(res.headers['content-length'], 10);
        let downloaded = 0;
        
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          const percent = totalSize ? Math.round((downloaded / totalSize) * 100) : '?';
          process.stdout.write(`\rDownloading: ${percent}%`);
        });
        
        res.pipe(file);
        file.on('finish', () => {
          process.stdout.write('\n');
          file.close();
          resolve();
        });
      }).on('error', reject);
    };
    
    request(url);
  });
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
