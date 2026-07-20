import { NodeSSH } from 'node-ssh';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONCURRENCY = 4;

const DEFAULTS = {
  host: process.env.SP_SSH_HOST || '192.168.0.101',
  username: process.env.SP_SSH_USER || 'admin',
  password: process.env.SP_SSH_PASS || '',
  remoteDir: process.env.SP_SSH_REMOTE_DIR || '/ten/streaming/downloads',
};

async function transfer(localDir, options = {}) {
  const host = options.host || DEFAULTS.host;
  const username = options.username || DEFAULTS.username;
  const password = options.password || DEFAULTS.password;
  const remoteDir = options.remoteDir || DEFAULTS.remoteDir;
  const onProgress = options.onProgress || null;

  const ssh = new NodeSSH();
  const startTime = Date.now();

  if (onProgress) onProgress({ phase: 'connecting' });
  await ssh.connect({ host, username, password });

  const dirName = path.basename(localDir);
  const remoteTarget = `${remoteDir}/${dirName}`;

  if (onProgress) onProgress({ phase: 'preparing', message: `Creating ${remoteTarget}` });
  await ssh.execCommand(`mkdir -p "${remoteTarget}"`);

  const entries = fs.readdirSync(localDir);
  const files = entries.filter((entry) => fs.statSync(path.join(localDir, entry)).isFile());
  const results = [];
  const errors = [];
  const totalFiles = files.length;
  const totalBytes = files.reduce((sum, f) => sum + fs.statSync(path.join(localDir, f)).size, 0);
  let transferredBytes = 0;
  let startedFiles = 0;
  const queue = files.slice();

  const worker = async () => {
    while (true) {
      const entry = queue.shift();
      if (!entry) break;
      const localPath = path.join(localDir, entry);
      const stat = fs.statSync(localPath);
      const remoteFilePath = `${remoteTarget}/${entry}`;
      const fileIndex = ++startedFiles;

      if (onProgress) onProgress({
        phase: 'transferring',
        fileIndex,
        totalFiles,
        currentFile: entry,
        fileSize: stat.size,
        transferredBytes,
        totalBytes,
        elapsedMs: Date.now() - startTime,
      });

      try {
        await ssh.putFile(localPath, remoteFilePath);
        results.push({ file: entry, size: stat.size, remotePath: remoteFilePath });
        transferredBytes += stat.size;
      } catch (err) {
        errors.push({ file: entry, error: err.message });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length || 1) }, () => worker()));

  if (onProgress) onProgress({ phase: 'verifying', message: 'Verifying files on remote...' });
  let verified = true;
  for (const r of results) {
    try {
      const check = await ssh.execCommand(`stat -c '%s' "${r.remotePath}" 2>/dev/null`);
      const remoteSize = parseInt(check.stdout.trim(), 10);
      if (isNaN(remoteSize) || remoteSize !== r.size) {
        verified = false;
        break;
      }
    } catch {
      verified = false;
      break;
    }
  }

  const durationMs = Date.now() - startTime;
  if (onProgress) onProgress({ phase: 'complete', totalFiles, totalTransferred: results.length, errors: errors.length, verified, durationMs });

  let nasTagResult = null;
  if (verified && options.flacTags && options.flacTags.length > 0) {
    if (onProgress) onProgress({ phase: 'tagging', message: `Tagging ${options.flacTags.length} FLAC files on NAS` });
    nasTagResult = await tagFlacOnNas(ssh, remoteTarget, options.flacTags);
  }

  ssh.dispose();
  return { host, remoteTarget, files: results, errors, verified, durationMs, nasTagResult };
}

// Tags FLAC files on the NAS using up to 4 parallel metaflac commands
async function tagFlacOnNas(ssh, remoteTarget, flacTags) {
  const CONCURRENCY = 4;
  const queue = [...flacTags];
  const results = [];

  const worker = async () => {
    while (queue.length > 0) {
      const { filename, trackNum, title, artist, albumArtist, album, date } = queue.shift();
      const remotePath = `${remoteTarget}/${filename}`;
      const tagData = [
        `ARTIST=${artist}`,
        `ALBUMARTIST=${albumArtist}`,
        `ALBUM=${album}`,
        `DATE=${date}`,
        `TRACKNUMBER=${trackNum}`,
        `TITLE=${title}`,
      ].join('\n') + '\n';

      const result = await ssh.execCommand(
        `metaflac --remove-all-tags --import-tags-from=- "${remotePath}"`,
        { stdin: tagData }
      );
      const ok = result.code === 0;
      if (!ok) console.log(`[nas-tag] metaflac error on ${filename}: ${result.stderr}`);
      results.push({ filename, ok });
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, flacTags.length) }, () => worker()));
  const okCount = results.filter(r => r.ok).length;
  console.log(`[nas-tag] tagged ${okCount}/${results.length} FLAC files on NAS`);
  return results;
}

async function testConnection(options = {}) {
  const host = options.host || DEFAULTS.host;
  const username = options.username || DEFAULTS.username;
  const password = options.password || DEFAULTS.password;
  const remoteDir = options.remoteDir || DEFAULTS.remoteDir;

  const ssh = new NodeSSH();

  try {
    await ssh.connect({ host, username, password });
    const result = await ssh.execCommand(`ls -la ${remoteDir}`);
    ssh.dispose();
    return { success: true, host, output: result.stdout };
  } catch (err) {
    return { success: false, host, error: err.message };
  }
}

export { transfer, tagFlacOnNas, testConnection, DEFAULTS };
