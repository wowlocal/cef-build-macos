#!/usr/bin/env node

const https = require('https');
const fs = require('fs');

/**
 * Downloads a zip asset from a GitHub release
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} tag - Release tag (e.g., 'v1.0.0') or 'latest'
 * @param {string} assetName - Name of the zip file to download
 * @param {string} outputPath - Where to save the file
 */
async function downloadGitHubRelease(owner, repo, tag, assetName, outputPath) {
  const isLatest = tag === 'latest';
  const apiUrl = isLatest
    ? `https://api.github.com/repos/${owner}/${repo}/releases/latest`
    : `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`;

  console.log(`Fetching release info from: ${apiUrl}`);

  const releaseData = await fetchJson(apiUrl);
  
  const asset = releaseData.assets.find(a => a.name === assetName);
  if (!asset) {
    const availableAssets = releaseData.assets.map(a => a.name).join(', ');
    throw new Error(`Asset "${assetName}" not found. Available: ${availableAssets || 'none'}`);
  }

  console.log(`Found asset: ${asset.name} (${formatBytes(asset.size)})`);
  console.log(`Downloading to: ${outputPath}`);

  await downloadFile(asset.browser_download_url, outputPath);
  
  console.log('Download complete!');
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'github-release-downloader',
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    https.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      
      if (res.statusCode !== 200) {
        return reject(new Error(`API request failed with status ${res.statusCode}`));
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse API response'));
        }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'User-Agent': 'github-release-downloader' }
    };

    https.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location, outputPath).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`Download failed with status ${res.statusCode}`));
      }

      const fileStream = fs.createWriteStream(outputPath);
      res.pipe(fileStream);
      
      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });
      
      fileStream.on('error', (err) => {
        fs.unlink(outputPath, () => {});
        reject(err);
      });
    }).on('error', reject);
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length < 4) {
    console.log('Usage: node download-release.js <owner> <repo> <tag> <asset-name> [output-path]');
    console.log('');
    console.log('Examples:');
    console.log('  node download-release.js wowlocal cef-build-macos 73 cefclient.zip');
    process.exit(1);
  }

  const [owner, repo, tag, assetName, outputPath = assetName] = args;

  downloadGitHubRelease(owner, repo, tag, assetName, outputPath)
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

module.exports = { downloadGitHubRelease, downloadFile, formatBytes };
