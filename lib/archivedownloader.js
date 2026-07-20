import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';

const AUDIO_EXTS = new Set(['.flac', '.shn', '.mp3', '.ape', '.ogg', '.wav', '.m4a', '.aac', '.opus']);

function httpGet(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'sp-bootleg-downloader/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        res.resume();
        httpGet(res.headers.location, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

async function getAudioFileList(identifier) {
  const url = `https://s3.us.archive.org/${identifier}/${identifier}_files.xml`;
  const { statusCode, body } = await httpGet(url);
  if (statusCode !== 200) throw new Error(`Files XML returned HTTP ${statusCode} for ${identifier}`);

  const files = [];
  const fileRegex = /<file\s+name="([^"]+)"\s+source="original"[^>]*>([\s\S]*?)<\/file>/g;
  let m;
  while ((m = fileRegex.exec(body)) !== null) {
    const name = m[1];
    const ext = path.extname(name).toLowerCase();
    if (!AUDIO_EXTS.has(ext)) continue;
    const sizeMatch = m[2].match(/<size>(\d+)<\/size>/);
    files.push({ name, size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0 });
  }
  return files;
}

function downloadFile(url, destPath, onBytes, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'sp-bootleg-downloader/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        res.resume();
        downloadFile(res.headers.location, destPath, onBytes, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const stream = fs.createWriteStream(destPath);
      res.on('data', chunk => { stream.write(chunk); if (onBytes) onBytes(chunk.length); });
      res.on('end', () => stream.end(resolve));
      res.on('error', err => { stream.destroy(); try { fs.unlinkSync(destPath); } catch {} reject(err); });
    });
    req.on('error', err => reject(err));
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Download timed out')); });
  });
}

async function downloadFromArchive(identifier, destDir, onProgress) {
  const files = await getAudioFileList(identifier);
  if (files.length === 0) throw new Error(`No source audio files found for ${identifier}`);

  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  let downloadedBytes = 0;
  const totalFiles = files.length;
  let completedFiles = 0;

  const CONCURRENCY = 3;
  const queue = [...files];

  const worker = async () => {
    while (queue.length > 0) {
      const file = queue.shift();
      const fileUrl = `https://s3.us.archive.org/${identifier}/${encodeURIComponent(file.name)}`;
      const destPath = path.join(destDir, file.name);

      if (onProgress) onProgress({
        phase: 'downloading',
        completedFiles,
        totalFiles,
        currentFile: file.name,
        downloadedBytes,
        totalBytes,
      });

      await downloadFile(fileUrl, destPath, (bytes) => {
        downloadedBytes += bytes;
        if (onProgress) onProgress({
          phase: 'downloading',
          completedFiles,
          totalFiles,
          currentFile: file.name,
          downloadedBytes,
          totalBytes,
        });
      });

      completedFiles++;
      console.log(`[archive-dl] ${file.name} (${completedFiles}/${totalFiles})`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()));

  if (onProgress) onProgress({ phase: 'done', completedFiles: totalFiles, totalFiles, downloadedBytes, totalBytes });
  return { files: files.map(f => f.name), totalBytes };
}

export { downloadFromArchive, getAudioFileList };
