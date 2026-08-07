import WebTorrent from 'webtorrent';
import path from 'path';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/ten/streaming/downloads';

class Downloader {
  constructor() {
    this.client = null;
    this.activeTorrents = new Map();
    this.onDoneCallbacks = new Map();
    // Tracks torrents where 'done' fired before the callback was registered (race condition)
    this.firedDones = new Set();
    this.activeDirectDownloads = new Map(); // identifier -> { cancel }
    if (!fs.existsSync(DOWNLOAD_DIR)) {
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    }
  }

  _getClient() {
    if (!this.client) {
      this.client = new WebTorrent({ maxConns: 55, utp: true });
      this.client.on('error', (err) => console.error('WebTorrent client error:', err.message));
    }
    return this.client;
  }

  add(input, options = {}) {
    return new Promise((resolve, reject) => {
      const client = this._getClient();
      const destDir = options.destDir || DOWNLOAD_DIR;

      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      client.add(input, { path: destDir }, (torrent) => {
        this._setupTorrent(torrent, destDir, options, resolve, reject);
      });
    });
  }

  async checkPeers(input, timeoutMs = 15000) {
    const checkClient = new WebTorrent({ maxConns: 25, utp: true });
    checkClient.on('error', (err) => console.error('WebTorrent peer-check error:', err.message));
    const tmpDir = `/tmp/peercheck_${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        try { checkClient.destroy(); } catch (_) {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        resolve(result);
      };

      const timeout = setTimeout(() => {
        const entry = checkClient.torrents[0];
        finish({
          peers: entry ? entry.numPeers : 0,
          seeds: entry && entry.files ? entry.files.length : 0,
          name: entry ? entry.name : '',
          infoHash: entry ? entry.infoHash : '',
          timedOut: true,
        });
      }, timeoutMs);

      const onTorrent = (torrent) => {
        const check = () => {
          if (settled) return;
          clearTimeout(timeout);
          finish({
            peers: torrent.numPeers,
            seeds: torrent.files.length,
            name: torrent.name,
            infoHash: torrent.infoHash,
            timedOut: false,
          });
        };

        if (torrent.numPeers > 0) {
          check();
          return;
        }

        torrent.on('wire', () => {
          if (torrent.numPeers > 0) check();
        });

        torrent.on('error', () => {
          if (!settled) {
            clearTimeout(timeout);
            finish({ peers: 0, seeds: 0, name: '', infoHash: '', timedOut: false, error: true });
          }
        });
      };

      try {
        if (Buffer.isBuffer(input)) {
          checkClient.add(input, { path: tmpDir }, onTorrent);
        } else {
          checkClient.add(input, { path: tmpDir }, onTorrent);
        }
      } catch (err) {
        clearTimeout(timeout);
        finish({ peers: 0, seeds: 0, name: '', infoHash: '', timedOut: false, error: true });
      }
    });
  }

  _setupTorrent(torrent, destDir, options, resolve, reject) {
    this.activeTorrents.set(torrent.infoHash, {
      torrent,
      destDir,
      metadata: options.metadata || {},
      lastActivityAt: Date.now(),
    });

    let nearDoneAt = null;
    let doneFired = false;

    const fireDone = () => {
      if (doneFired) return;
      doneFired = true;
      clearTimeout(stallTimeout);
      clearInterval(nearDoneInterval);
      const cb = this.onDoneCallbacks.get(torrent.infoHash);
      if (cb) {
        cb(torrent.infoHash);
      } else {
        // Callback not yet registered — park it so onDone() can fire immediately later
        this.firedDones.add(torrent.infoHash);
      }
    };

    torrent.on('error', (err) => {
      clearInterval(nearDoneInterval);
      this.activeTorrents.delete(torrent.infoHash);
      this.onDoneCallbacks.delete(torrent.infoHash);
      reject(err);
    });

    torrent.on('done', () => fireDone());

    // Every 10s: update activity timestamp and check for near-done stall
    const nearDoneInterval = setInterval(() => {
      if (doneFired) { clearInterval(nearDoneInterval); return; }
      if (torrent.downloadSpeed > 0) {
        const entry = this.activeTorrents.get(torrent.infoHash);
        if (entry) entry.lastActivityAt = Date.now();
      }
      // At >=99% with 0 speed for 60s, fire done regardless of peer count
      if (torrent.progress >= 0.99 && torrent.downloadSpeed === 0) {
        if (!nearDoneAt) {
          nearDoneAt = Date.now();
        } else if (Date.now() - nearDoneAt >= 60000) {
          fireDone();
        }
      } else {
        nearDoneAt = null;
      }
    }, 10000);

    const stallTimeout = setTimeout(() => {
      if (torrent.progress === 0 && torrent.numPeers === 0) {
        clearInterval(nearDoneInterval);
        this.activeTorrents.delete(torrent.infoHash);
        this.onDoneCallbacks.delete(torrent.infoHash);
        this.client.remove(torrent);
        reject(new Error('No peers found. The torrent may be dead.'));
      }
    }, 300000);

    resolve({
      infoHash: torrent.infoHash,
      name: torrent.name,
      files: torrent.files.map((f) => f.name),
      destDir,
    });
  }

  onDone(infoHash, callback) {
    if (this.firedDones.has(infoHash)) {
      // 'done' already fired before this callback was registered — invoke immediately
      this.firedDones.delete(infoHash);
      setImmediate(() => callback(infoHash));
      return;
    }
    this.onDoneCallbacks.set(infoHash, callback);
  }

  getProgress(infoHash) {
    const entry = this.activeTorrents.get(infoHash);
    if (!entry) return null;
    const { torrent, lastActivityAt } = entry;
    const stalledMs = torrent.downloadSpeed === 0 && torrent.progress > 0.05 && torrent.progress < 0.999
      ? Date.now() - lastActivityAt
      : 0;
    return {
      infoHash: torrent.infoHash,
      name: torrent.name,
      progress: torrent.progress,
      downloadSpeed: torrent.downloadSpeed,
      numPeers: torrent.numPeers,
      timeRemaining: torrent.timeRemaining,
      total: torrent.length,
      downloaded: torrent.downloaded,
      done: torrent.done,
      stalledMs,
      files: torrent.files.map((f) => ({
        name: f.name,
        length: f.length,
        progress: f.progress,
        done: f.done,
      })),
    };
  }

  getAllProgress() {
    const results = [];
    for (const [infoHash] of this.activeTorrents) {
      results.push(this.getProgress(infoHash));
    }
    return results;
  }

  getTorrentPath(infoHash) {
    const entry = this.activeTorrents.get(infoHash);
    if (!entry) return null;
    return entry.destDir;
  }

  removeTorrent(infoHash) {
    const entry = this.activeTorrents.get(infoHash);
    if (!entry) return;
    this.client.remove(entry.torrent);
    this.activeTorrents.delete(infoHash);
    this.onDoneCallbacks.delete(infoHash);
  }

  async downloadDirect(identifier, destDir, { onProgress } = {}) {
    const filesXmlUrl = `https://s3.us.archive.org/${identifier}/${identifier}_files.xml`;
    let xml;
    try {
      xml = await this._fetchText(filesXmlUrl);
    } catch (err) {
      throw new Error(`Failed to fetch file list for ${identifier}: ${err.message}`);
    }

    const AUDIO_EXTS = new Set(['.flac', '.shn', '.ape', '.mp3', '.ogg', '.wav', '.m4a', '.aac', '.opus']);
    const files = [];
    const fileRegex = /<file\s+name="([^"]+)"\s+source="original"[^>]*>([\s\S]*?)<\/file>/g;
    let m;
    while ((m = fileRegex.exec(xml)) !== null) {
      const name = m[1];
      const ext = path.extname(name).toLowerCase();
      if (!AUDIO_EXTS.has(ext)) continue;
      const sizeMatch = m[2].match(/<size>(\d+)<\/size>/);
      files.push({ name, size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0 });
    }

    if (files.length === 0) throw new Error(`No audio files found for ${identifier}`);

    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    let cancelled = false;
    this.activeDirectDownloads.set(identifier, { cancel: () => { cancelled = true; } });

    const filesTotal = files.length;
    let filesDone = 0;

    try {
      for (const file of files) {
        if (cancelled) throw new Error('Cancelled');

        const destPath = path.join(destDir, file.name);

        // Skip files already fully downloaded (e.g. by a prior torrent)
        if (file.size > 0 && fs.existsSync(destPath)) {
          try {
            if (fs.statSync(destPath).size === file.size) {
              filesDone++;
              if (onProgress) onProgress({ percent: filesDone / filesTotal, filesDone, filesTotal });
              continue;
            }
          } catch {}
        }

        const fileUrl = `https://archive.org/download/${identifier}/${encodeURIComponent(file.name)}`;
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await this._downloadFile(fileUrl, destPath); lastErr = null; break; } catch (err) {
            lastErr = err;
            if (attempt < 2) await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
          }
        }
        if (lastErr) throw lastErr;
        filesDone++;
        if (onProgress) onProgress({ percent: filesDone / filesTotal, filesDone, filesTotal });
      }
    } finally {
      this.activeDirectDownloads.delete(identifier);
    }

    if (cancelled) throw new Error('Cancelled');
    return { filesTotal, filesDone, destDir };
  }

  cancelDirectDownload(identifier) {
    const entry = this.activeDirectDownloads.get(identifier);
    if (entry) entry.cancel();
  }

  async _fetchText(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return res.text();
  }

  async _downloadFile(url, destPath) {
    const res = await fetch(url, { signal: AbortSignal.timeout(300000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
  }

  destroy() {
    if (this.client) this.client.destroy();
  }
}

const downloader = new Downloader();
export default downloader;