import express from 'express';
import path from 'path';
import fs from 'fs';
import downloader from './lib/downloader.js';
import { lookup, fetchTorrentFile, fetchArchiveMetadata, fetchArchiveTrackTitles } from './lib/splra.js';
import { buildDirectoryName, renameFiles, filterAudioFormats, convertShnToFlac, tagFiles, AUDIO_EXTENSIONS, parseNfoFiles, parseSetlistTitles } from './lib/renamer.js';
import { transfer, tagFlacOnNas } from './lib/transfer.js';
import { generateCover } from './lib/cover.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/ten/streaming/downloads';
const CACHE_DIR = process.env.CACHE_DIR || '/ten/streaming/cache';
const JOBS_FILE = path.join(DOWNLOAD_DIR, '.jobs.json');
const app = express();
const PORT = process.env.PORT || 3999;
const HOST = process.env.HOST || '0.0.0.0';

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

app.set('trust proxy', true);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const LOG_FILE = path.join(DOWNLOAD_DIR, '.spbootlegs.log');
const jobs = new Map();

function logJob(level, action, jobId, detail) {
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] job=${jobId || '-'} action=${action} ${detail || ''}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  if (level === 'ERROR' || level === 'WARN') {
    console.error(`${ts} [${level}] ${action}: ${detail || ''}`);
  } else {
    console.log(`${ts} [${level}] ${action}: ${detail || ''}`);
  }
}

function logRenameCollisions(result, jobId) {
  if (!result.collisions || result.collisions.length === 0) return;
  for (const c of result.collisions) {
    const sizeNote = c.keptSize != null ? ` keptSize=${c.keptSize} droppedSize=${c.droppedSize}` : '';
    logJob('WARN', 'track_collision', jobId, `slot=${c.slot} reason=${c.reason} kept=${c.kept}${sizeNote} original="${c.original}"`);
  }
}

function parseDirectoryName(dirName) {
  const metadata = {};
  const parts = dirName.split(' - ');
  if (parts.length >= 1 && /^\d{4}-\d{2}-\d{2}$/.test(parts[0].trim())) {
    metadata.date = parts[0].trim();
  }
  if (parts.length >= 2) {
    metadata.venue = parts[1].trim();
  }
  if (parts.length >= 3) {
    const location = parts[2].trim();
    const lastComma = location.lastIndexOf(',');
    if (lastComma !== -1) {
      metadata.city = location.substring(0, lastComma).trim();
      metadata.state = location.substring(lastComma + 1).trim();
    } else {
      metadata.city = location;
    }
  }
  if (parts.length >= 4) {
    metadata.source = parts.slice(3).join(' - ').trim();
  }
  return metadata;
}

// Merges track titles from three sources: archive.org _files.xml > NFO files > SPLRA setlist
async function buildTrackTitles(destDir, metadata, archiveId) {
  const setlistTitles = parseSetlistTitles(metadata.setlist || '');

  const nfoData = parseNfoFiles(destDir);
  const nfoTitles = nfoData ? nfoData.trackTitles : {};

  let archiveTitles = {};
  if (archiveId) {
    try {
      archiveTitles = await fetchArchiveTrackTitles(archiveId);
    } catch (e) {
      console.log(`[track-titles] archive fetch failed: ${e.message}`);
    }
  }

  // archive > NFO > setlist; later Object.assign entries win
  return { ...setlistTitles, ...nfoTitles, ...archiveTitles };
}

// Fills missing metadata fields from NFO files found in the download directory
function enrichMetadataFromNfo(metadata, destDir) {
  const nfo = parseNfoFiles(destDir);
  if (!nfo) return metadata;
  const out = { ...metadata };
  if (nfo.date && !out.date) out.date = nfo.date;
  if (nfo.venue && !out.venue) out.venue = nfo.venue;
  if (nfo.city && !out.city) out.city = nfo.city;
  if (nfo.state && !out.state) out.state = nfo.state;
  if (nfo.source && !out.source) out.source = nfo.source;
  if (nfo.lineage && !out.lineage) out.lineage = nfo.lineage;
  return out;
}

function saveJobs() {
  try {
    fs.writeFileSync(JOBS_FILE, JSON.stringify([...jobs.values()], null, 2));
  } catch (e) {
    console.error('Failed to save jobs:', e.message);
  }
}

async function runPostDownloadPipeline(job) {
  try {
    const cachePath = path.join(CACHE_DIR, job.dirName);
    fs.mkdirSync(cachePath, { recursive: true });
    fs.cpSync(job.destDir, cachePath, { recursive: true });
    logJob('INFO', 'cache_saved', job.id, `cached to ${cachePath}`);
  } catch (e) {
    logJob('WARN', 'cache_save_failed', job.id, e.message);
  }

  const archiveId = job.metadata.archiveIdentifier
    || (job.metadata.archiveLinks && job.metadata.archiveLinks.length > 0 ? job.metadata.archiveLinks[0].identifier : null);

  job.metadata = enrichMetadataFromNfo(job.metadata, job.destDir);

  let trackTitles = {};
  try {
    trackTitles = await buildTrackTitles(job.destDir, job.metadata, archiveId);
    logJob('INFO', 'track_titles', job.id, `merged ${Object.keys(trackTitles).length} titles (archive+nfo+setlist)`);
  } catch (e) {
    logJob('WARN', 'track_titles_failed', job.id, e.message);
  }

  const result = renameFiles(job.destDir, job.metadata, trackTitles);
  job.renameResult = result;
  logJob('INFO', 'rename', job.id, `renamed=${result.files.length} files to dir=${result.dirName}`);
  logRenameCollisions(result, job.id);
  try { await convertShnToFlac(result.targetDir); logJob('INFO', 'shn2flac', job.id, 'SHN conversion done'); } catch (e) { logJob('ERROR', 'shn2flac_failed', job.id, e.message); }
  job.filterResult = filterAudioFormats(result.targetDir);
  logJob('INFO', 'filter', job.id, `kept=${job.filterResult.kept} deleted=${job.filterResult.deletedCount}`);
  const renameMap = {};
  for (const f of result.files) { renameMap[f.renamed] = f.original; }
  try {
    const tagResult = await tagFiles(result.targetDir, job.metadata, trackTitles, renameMap);
    job.flacTags = tagResult.flacTags || [];
    logJob('INFO', 'tag', job.id, `tagging done (${job.flacTags.length} flac deferred to NAS)`);
  } catch (e) { logJob('ERROR', 'tag_failed', job.id, e.message); }
  saveJobs();
  try { await generateCover(job.metadata, result.targetDir); logJob('INFO', 'cover', job.id, 'cover generated'); } catch (e) { logJob('ERROR', 'cover_failed', job.id, e.message); }
  startTransfer(job);
}

function registerPipeline(job) {
  downloader.onDone(job.id, async (infoHash) => {
    const j = jobs.get(infoHash);
    if (!j) return;
    logJob('INFO', 'download_complete', infoHash, `dir=${j.dirName}`);
    await runPostDownloadPipeline(j);
  });
}

function resumeDirectDownload(job) {
  const archiveId = job.metadata && job.metadata.archiveIdentifier;
  if (!archiveId) {
    job.status = 'interrupted';
    saveJobs();
    logJob('ERROR', 'resume_direct_failed', job.id, 'no archiveIdentifier');
    return;
  }
  job.status = 'downloading';
  job.downloadMode = 'direct';
  job.directProgress = { percent: 0, filesDone: 0, filesTotal: 0 };
  saveJobs();
  logJob('INFO', 'resume_direct', job.id, `resuming direct download (${archiveId})`);
  downloader.downloadDirect(archiveId, job.destDir, {
    onProgress: (p) => { job.directProgress = p; },
  }).then(async () => {
    logJob('INFO', 'direct_download_complete', job.id, `dir=${job.dirName}`);
    await runPostDownloadPipeline(job);
  }).catch((err) => {
    logJob('ERROR', 'direct_download_failed', job.id, err.message);
    job.status = 'interrupted';
    // Keep downloadMode as 'direct' so restart retries via resumeDirectDownload
    saveJobs();
  });
}

async function resumeDownload(job) {
  try {
    job.status = 'downloading';
    saveJobs();
    logJob('INFO', 'resume', job.id, `resuming download dir=${job.destDir}`);
    let torrentInput = job.magnetURI;
    if (torrentInput && torrentInput.startsWith('http')) {
      torrentInput = await fetchTorrentFile(torrentInput);
    }
    const torrentInfo = await downloader.add(torrentInput, { destDir: job.destDir, metadata: job.metadata });
    if (torrentInfo.infoHash !== job.id) {
      jobs.delete(job.id);
      job.id = torrentInfo.infoHash;
      jobs.set(job.id, job);
      saveJobs();
    }
    registerPipeline(job);
  } catch (e) {
    job.status = 'interrupted';
    saveJobs();
    logJob('ERROR', 'resume_failed', job.id, e.message);
  }
}

function loadJobs() {
  try {
    if (!fs.existsSync(JOBS_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    for (const job of saved) {
      if (job.status === 'transferring') {
        job.status = 'transfer_failed';
        job.transferError = 'Container restarted during transfer';
        job.transferProgress = { phase: 'failed', elapsedMs: 0 };
      }
      jobs.set(job.id, job);
      if (job.status === 'transferred') {
        setTimeout(() => { jobs.delete(job.id); saveJobs(); }, 60000);
      }
    }
    if (jobs.size > 0) console.log(`Restored ${jobs.size} job(s) from disk`);
  } catch (e) {
    console.error('Failed to load jobs:', e.message);
  }
}

loadJobs();

const STALL_FALLBACK_MS = 5 * 60 * 1000;
const progressSnapshots = new Map(); // jobId -> { progress, ts }

// Auto-resume any interrupted downloads after startup
setTimeout(() => {
  for (const [, job] of jobs) {
    if (job.status === 'downloading' || job.status === 'interrupted') {
      if (job.destDir) {
        logJob('INFO', 'auto_resume', job.id, `auto-resuming ${job.dirName}`);
        if (job.downloadMode === 'direct' && job.metadata && job.metadata.archiveIdentifier) {
          resumeDirectDownload(job);
        } else if (job.magnetURI) {
          resumeDownload(job);
        }
      }
    }
  }
}, 2000);

// Stall fallback: if a torrent job gains <1% progress over 5min and has an archiveIdentifier, switch to direct HTTP download
setInterval(async () => {
  const now = Date.now();
  for (const [, job] of jobs) {
    if (job.status !== 'downloading' || job.downloadMode === 'direct') continue;
    const archiveId = job.metadata && job.metadata.archiveIdentifier;
    if (!archiveId) continue;
    const progress = downloader.getProgress(job.id);
    if (!progress) continue;

    const snap = progressSnapshots.get(job.id);
    if (!snap) {
      progressSnapshots.set(job.id, { progress: progress.progress, ts: now });
      continue;
    }

    const elapsed = now - snap.ts;
    const gained = progress.progress - snap.progress;

    // Reset snapshot whenever meaningful progress is made (>5% gained)
    if (gained >= 0.05) {
      progressSnapshots.set(job.id, { progress: progress.progress, ts: now });
      continue;
    }

    // After 5min, if progress gained < 1%, fire fallback
    if (elapsed < STALL_FALLBACK_MS) continue;

    logJob('WARN', 'stall_fallback', job.id, `<1% progress in ${Math.round(elapsed / 60000)}min → switching to direct HTTP download (${archiveId})`);
    progressSnapshots.delete(job.id);
    downloader.removeTorrent(job.id);
    job.downloadMode = 'direct';
    job.directProgress = { percent: 0, filesDone: 0, filesTotal: 0 };
    saveJobs();

    downloader.downloadDirect(archiveId, job.destDir, {
      onProgress: (p) => { job.directProgress = p; },
    }).then(async () => {
      logJob('INFO', 'direct_download_complete', job.id, `dir=${job.dirName}`);
      await runPostDownloadPipeline(job);
    }).catch((err) => {
      logJob('ERROR', 'direct_download_failed', job.id, err.message);
      job.status = 'interrupted';
      // Keep downloadMode as 'direct' so restart retries via resumeDirectDownload
      // rather than torrent (which may find partial files and declare near-done prematurely)
      saveJobs();
    });
  }
}, 60000);

function cleanupAndRemove(job) {
  try {
    if (job.destDir && fs.existsSync(job.destDir)) {
      fs.rmSync(job.destDir, { recursive: true, force: true });
    }
  } catch (e) {}
  if (job.dirName) {
    const cachePath = path.join(CACHE_DIR, job.dirName);
    if (fs.existsSync(cachePath)) {
      try { fs.rmSync(cachePath, { recursive: true, force: true }); } catch (e) {}
    }
  }
  jobs.delete(job.id);
  saveJobs();
}

function hasAudioFiles(dir) {
  try {
    return fs.readdirSync(dir).some(f => AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase()));
  } catch { return false; }
}

function startTransfer(job) {
  const sourceDir = job.renameResult ? job.renameResult.targetDir : job.destDir;

  job.status = 'transferring';
  job.transferError = null;
  job.transferProgress = { phase: 'connecting' };
  job.transferStartedAt = Date.now();
  saveJobs();
  logJob('INFO', 'transfer_start', job.id, `dir=${sourceDir}`);

  transfer(sourceDir, {
    onProgress: (p) => { job.transferProgress = p; },
    flacTags: job.flacTags || [],
  })
    .then((result) => {
      if (result.files.length === 0) {
        logJob('WARN', 'transfer_empty', job.id, 'no files transferred');
        cleanupAndRemove(job);
        return;
      }
      job.transferResult = result;
      job.transferProgress = { phase: 'complete', durationMs: result.durationMs };
      job.status = 'transferred';
      logJob('INFO', 'transfer_complete', job.id, `files=${result.files.length} duration=${result.durationMs}ms verified=${result.verified}`);
      if (result.nasTagResult) {
        const ok = result.nasTagResult.filter(r => r.ok).length;
        logJob('INFO', 'nas_tag', job.id, `metaflac tagged ${ok}/${result.nasTagResult.length} FLAC files on NAS`);
      }
      if (result.verified) {
        const dirToDelete = job.destDir;
        try {
          fs.rmSync(dirToDelete, { recursive: true, force: true });
          job.localDeleted = true;
        } catch (e) {
          job.localDeleted = false;
          job.localDeleteError = e.message;
          logJob('ERROR', 'local_delete_failed', job.id, e.message);
        }
      }
      const cachePath = path.join(CACHE_DIR, job.dirName);
      if (fs.existsSync(cachePath)) {
        try {
          fs.rmSync(cachePath, { recursive: true, force: true });
          logJob('INFO', 'cache_deleted', job.id, `deleted cache ${cachePath}`);
        } catch (e) {
          logJob('WARN', 'cache_delete_failed', job.id, e.message);
        }
      }
      saveJobs();
      setTimeout(() => { jobs.delete(job.id); saveJobs(); }, 60000);
    })
    .catch((err) => {
      job.transferError = err.message;
      job.transferProgress = {
        ...(job.transferProgress || {}),
        phase: 'failed',
        elapsedMs: Date.now() - job.transferStartedAt,
      };
      job.status = 'transfer_failed';
      logJob('ERROR', 'transfer_failed', job.id, err.message);
      saveJobs();
    });
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/lookup', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const metadata = await lookup(url);
    if (metadata.isVideo) {
      return res.status(400).json({ error: `This is a video recording, not audio. ${metadata.videoReason} Only audio bootlegs are supported.`, metadata: { isVideo: true, videoReason: metadata.videoReason, source: metadata.source } });
    }
    const dirName = buildDirectoryName(metadata);

    res.json({ metadata, suggestedDirName: dirName, archiveLinks: metadata.archiveLinks || [], recordings: metadata.recordings || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/archive-lookup', async (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier) return res.status(400).json({ error: 'identifier is required' });
    const meta = await fetchArchiveMetadata(identifier);
    res.json(meta);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/check-peers', async (req, res) => {
  try {
    const { identifier, torrentUrl } = req.body;
    let torrentInput = null;

    if (identifier) {
      const url = `https://s3.us.archive.org/${identifier}/${identifier}_archive.torrent`;
      try {
        torrentInput = await fetchTorrentFile(url);
      } catch (err) {
        return res.json({ peers: 0, seeds: 0, name: '', infoHash: '', error: `Failed to fetch torrent: ${err.message}` });
      }
    } else if (torrentUrl) {
      try {
        torrentInput = await fetchTorrentFile(torrentUrl);
      } catch (err) {
        return res.json({ peers: 0, seeds: 0, name: '', infoHash: '', error: `Failed to fetch torrent: ${err.message}` });
      }
    } else {
      return res.status(400).json({ error: 'identifier or torrentUrl is required' });
    }

    const result = await downloader.checkPeers(torrentInput, 15000);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jobs', async (req, res) => {
  try {
    let { magnetURI, splraUrl, customMetadata, archiveIdentifier } = req.body;

    if (!magnetURI && !splraUrl && !archiveIdentifier) {
      return res.status(400).json({ error: 'magnetURI, splraUrl, or archiveIdentifier is required' });
    }

    let metadata = customMetadata || {};
    let torrentInput = magnetURI || null;

    if (archiveIdentifier) {
      const id = archiveIdentifier.toLowerCase();
      if (id.startsWith('zwan')) metadata.band = 'zwan';
      else if (id.startsWith('bc')) metadata.band = 'bc';
      else if (!metadata.band || metadata.band === 'sp') metadata.band = 'sp';
    }
    if (!metadata.band) metadata.band = 'sp';

    if (archiveIdentifier) {
      const archiveTorrentUrl = `https://s3.us.archive.org/${archiveIdentifier}/${archiveIdentifier}_archive.torrent`;
      try {
        const torrentBuffer = await fetchTorrentFile(archiveTorrentUrl);
        torrentInput = torrentBuffer;
        metadata.torrentFileUrl = archiveTorrentUrl;
        metadata.archiveIdentifier = archiveIdentifier;

        const arMeta = await fetchArchiveMetadata(archiveIdentifier);
        if (!metadata.date && arMeta.date) metadata.date = arMeta.date;
        if (!metadata.venue && arMeta.venue) metadata.venue = arMeta.venue;
        if (!metadata.city && arMeta.city) metadata.city = arMeta.city;
        if (!metadata.state && arMeta.state) metadata.state = arMeta.state;
        if (!metadata.country && arMeta.country) metadata.country = arMeta.country;
        if (!metadata.source && arMeta.source) metadata.source = arMeta.source;
        if (!metadata.lineage && arMeta.lineage) metadata.lineage = arMeta.lineage;
      } catch (err) {
        return res.status(400).json({ error: `Failed to fetch archive.org torrent: ${err.message}` });
      }
    }

    if (splraUrl) {
      const lookupResult = await lookup(splraUrl);
      metadata = { ...metadata, ...lookupResult };

      if (!torrentInput && lookupResult.magnetLinks && lookupResult.magnetLinks.length > 0) {
        torrentInput = lookupResult.magnetLinks[0];
      }

      if (lookupResult.isVideo) {
        return res.status(400).json({ error: `This is a video recording, not audio. ${lookupResult.videoReason} Only audio bootlegs are supported.` });
      }

      if (!torrentInput && lookupResult.torrentLinks && lookupResult.torrentLinks.length > 0) {
        const torrentUrl = lookupResult.torrentLinks[0];
        try {
          const torrentBuffer = await fetchTorrentFile(torrentUrl);
          torrentInput = torrentBuffer;
          metadata.torrentFileUrl = torrentUrl;
        } catch (err) {
          return res.status(400).json({
            error: `Found .torrent link but failed to download it: ${err.message}`,
          });
        }
      }

      if (!torrentInput && !archiveIdentifier) {
        return res.status(400).json({ error: 'No torrent file or magnet link found on this page. Nothing to download.' });
      }
    }

    if (!torrentInput) {
      return res.status(400).json({ error: 'No torrent file or magnet link found. Provide a SPLRA URL with a torrent.' });
    }

    const dirName = buildDirectoryName(metadata);
    const destDir = path.join(DOWNLOAD_DIR, dirName);

    if (fs.existsSync(destDir)) {
      return res.status(409).json({ error: `"${dirName}" already exists in downloads. Remove it first if you want to re-download.` });
    }

    for (const [, existing] of jobs) {
      if (existing.dirName === dirName && ['downloading', 'transferring'].includes(existing.status)) {
        return res.status(409).json({ error: `"${dirName}" is already being downloaded.` });
      }
    }

    let torrentInfo;
    try {
      torrentInfo = await downloader.add(torrentInput, { destDir, metadata });
    } catch (err) {
      return res.status(400).json({ error: `Failed to start torrent: ${err.message}` });
    }

    const jobId = torrentInfo.infoHash;
    const job = {
      id: jobId,
      magnetURI: typeof torrentInput === 'string' ? torrentInput : metadata.torrentFileUrl || 'torrent file',
      splraUrl,
      metadata,
      dirName,
      destDir,
      status: 'downloading',
      downloadMode: 'torrent',
      directProgress: null,
      transferResult: null,
      transferError: null,
      transferProgress: null,
      renameResult: null,
      localDeleted: false,
      localDeleteError: null,
    };
    jobs.set(jobId, job);
    saveJobs();
    logJob('INFO', 'job_created', jobId, `dir=${dirName} url=${splraUrl || 'orphan'}`);

    registerPipeline(job);

    res.json({ jobId, metadata, dirName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs', (req, res) => {
  const result = [];
  for (const [id, job] of jobs) {
    const isDirect = job.downloadMode === 'direct';
    const progress = isDirect ? null : downloader.getProgress(id);
    const dp = job.directProgress || null;
    result.push({
      id: job.id,
      magnetURI: job.magnetURI,
      splraUrl: job.splraUrl,
      metadata: job.metadata,
      dirName: job.dirName,
      status: job.status,
      downloadMode: job.downloadMode || 'torrent',
      progress: isDirect ? (dp ? dp.percent : 0) : (progress ? progress.progress : 0),
      downloadSpeed: isDirect ? 0 : (progress ? progress.downloadSpeed : 0),
      numPeers: isDirect ? 0 : (progress ? progress.numPeers : 0),
      done: isDirect ? false : (progress ? progress.done : false),
      stalledMs: isDirect ? 0 : (progress ? (progress.stalledMs || 0) : 0),
      directProgress: dp,
      transferResult: job.transferResult,
      transferError: job.transferError,
      transferProgress: job.transferProgress,
      transferStartedAt: job.transferStartedAt || null,
      renameResult: job.renameResult,
      filterResult: job.filterResult || null,
      localDeleted: job.localDeleted,
      localDeleteError: job.localDeleteError,
    });
  }
  res.json(result);
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const isDirect = job.downloadMode === 'direct';
  const progress = isDirect ? null : downloader.getProgress(req.params.id);
  const dp = job.directProgress || null;
  res.json({
    id: job.id,
    magnetURI: job.magnetURI,
    splraUrl: job.splraUrl,
    metadata: job.metadata,
    dirName: job.dirName,
    status: job.status,
    downloadMode: job.downloadMode || 'torrent',
    progress: isDirect ? (dp ? dp.percent : 0) : (progress ? progress.progress : 0),
    downloadSpeed: isDirect ? 0 : (progress ? progress.downloadSpeed : 0),
    numPeers: isDirect ? 0 : (progress ? progress.numPeers : 0),
    done: isDirect ? false : (progress ? progress.done : false),
    files: isDirect ? [] : (progress ? progress.files : []),
    directProgress: dp,
    transferResult: job.transferResult,
    transferError: job.transferError,
    transferProgress: job.transferProgress,
    renameResult: job.renameResult,
  });
});

app.post('/api/jobs/:id/transfer', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (job.status === 'transferring') {
    return res.status(409).json({ error: 'Transfer already in progress' });
  }

  if (job.status === 'interrupted' || job.status === 'downloading') {
    if (!fs.existsSync(job.destDir)) {
      cleanupAndRemove(job);
      return res.status(410).json({ error: 'Staging directory no longer exists — job cleared', removed: true });
    }
    if (!job.renameResult) {
      logJob('INFO', 'force_rename', job.id, `dir=${job.destDir}`);
      const archiveId0 = job.metadata.archiveIdentifier
        || (job.metadata.archiveLinks && job.metadata.archiveLinks.length > 0 ? job.metadata.archiveLinks[0].identifier : null);
      job.metadata = enrichMetadataFromNfo(job.metadata, job.destDir);
      let trackTitles = {};
      try { trackTitles = await buildTrackTitles(job.destDir, job.metadata, archiveId0); } catch {}
      const result = renameFiles(job.destDir, job.metadata, trackTitles);
      job.renameResult = result;
      logJob('INFO', 'rename', job.id, `renamed=${result.files.length} files`);
      logRenameCollisions(result, job.id);
      try { await convertShnToFlac(result.targetDir); } catch (e) { logJob('ERROR', 'shn2flac_failed', job.id, e.message); }
      job.filterResult = filterAudioFormats(result.targetDir);
      logJob('INFO', 'filter', job.id, `kept=${job.filterResult.kept} deleted=${job.filterResult.deletedCount}`);
      if (!hasAudioFiles(result.targetDir)) {
        cleanupAndRemove(job);
        return res.status(410).json({ error: 'No audio files found after filtering — job cleared', removed: true });
      }
      const renameMap2 = {};
      for (const f of result.files) { renameMap2[f.renamed] = f.original; }
      try {
        const tagResult2 = await tagFiles(result.targetDir, job.metadata, trackTitles, renameMap2);
        job.flacTags = tagResult2.flacTags || [];
        logJob('INFO', 'tag', job.id, `tagging done (${job.flacTags.length} flac deferred to NAS)`);
      } catch (e) { logJob('ERROR', 'tag_failed', job.id, e.message); }
      try { await generateCover(job.metadata, result.targetDir); } catch (e) { logJob('ERROR', 'cover_failed', job.id, e.message); }
      saveJobs();
    }
    logJob('INFO', 'force_transfer', job.id, `${job.status}→transfer dir=${job.destDir}`);
    res.json({ status: 'transferring', message: 'Transfer started' });
    startTransfer(job);
    return;
  }

  if (!job.renameResult) {
    return res.status(400).json({ error: 'Download not complete yet' });
  }

  res.json({ status: 'transferring', message: 'Transfer started' });
  startTransfer(job);
});

app.get('/api/cover-preview', async (req, res) => {
  try {
    const metadata = {
      date: req.query.date || '',
      venue: req.query.venue || '',
      city: req.query.city || '',
      state: req.query.state || '',
      country: req.query.country || '',
      source: req.query.source || '',
      band: req.query.band || 'sp',
    };
    const coverPath = await generateCover(metadata, '/tmp');
    res.set('Content-Type', 'image/png');
    res.sendFile(coverPath, () => {
      try { fs.unlinkSync(coverPath); } catch {}
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const ND_BASE = process.env.ND_BASE || 'https://pumpkins.buis2.net/rest';
const ND_USER = process.env.ND_USER || 'admin';
const ND_PASS = process.env.ND_PASS || '';
const ND_AUTH = `u=${encodeURIComponent(ND_USER)}&p=${encodeURIComponent(ND_PASS)}&v=1.16.1&c=spbootlegs&f=json`;
const NAVIDROME_ENABLED = Boolean(ND_BASE && ND_USER && ND_PASS);

app.get('/api/navidrome-art/:id', async (req, res) => {
  if (!NAVIDROME_ENABLED) return res.status(404).send('Navidrome integration not configured');
  try {
    const url = `${ND_BASE}/getCoverArt.view?${ND_AUTH}&id=${req.params.id}`;
    const response = await fetch(url);
    res.set('Content-Type', response.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Error fetching art');
  }
});

const shareCache = new Map();

app.get('/api/recent-albums', async (req, res) => {
  if (!NAVIDROME_ENABLED) return res.json([]);
  try {
    const url = `${ND_BASE}/getAlbumList2.view?${ND_AUTH}&type=newest&size=8`;
    const response = await fetch(url);
    const data = await response.json();
    const albums = data?.['subsonic-response']?.albumList2?.album || [];
    res.json(albums.map(a => ({
      id: a.id,
      name: a.name,
      artist: a.artist || a.displayArtist || '',
      coverArt: a.coverArt || '',
      songCount: a.songCount || 0,
      duration: a.duration || 0,
      created: a.created || '',
      year: a.year || null,
    })));
  } catch (err) {
    res.json([]);
  }
});

app.post('/api/share-album', async (req, res) => {
  if (!NAVIDROME_ENABLED) return res.status(404).json({ error: 'Navidrome integration not configured' });
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing album id' });

  if (shareCache.has(id)) {
    const cached = shareCache.get(id);
    if (Date.now() - cached.ts < 86400000) {
      return res.json({ url: cached.url });
    }
  }

  try {
    const url = `${ND_BASE}/createShare.view?${ND_AUTH}&id=${encodeURIComponent(id)}`;
    const response = await fetch(url);
    const data = await response.json();
    const shares = data?.['subsonic-response']?.shares?.share;
    if (shares && shares.length > 0) {
      const shareUrl = shares[0].url;
      shareCache.set(id, { url: shareUrl, ts: Date.now() });
      res.json({ url: shareUrl });
    } else {
      res.status(500).json({ error: 'No share returned' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orphaned', (req, res) => {
  try {
    const activeDirNames = new Set([...jobs.values()].map(j => j.dirName));
    let entries;
    try { entries = fs.readdirSync(DOWNLOAD_DIR); } catch { return res.json([]); }
    const orphaned = entries
      .filter(entry => {
        try { return fs.statSync(path.join(DOWNLOAD_DIR, entry)).isDirectory() && !activeDirNames.has(entry); } catch { return false; }
      })
      .map(dirName => {
        const full = path.join(DOWNLOAD_DIR, dirName);
        try {
          const files = fs.readdirSync(full).filter(f => { try { return fs.statSync(path.join(full, f)).isFile(); } catch { return false; } });
          const totalBytes = files.reduce((sum, f) => { try { return sum + fs.statSync(path.join(full, f)).size; } catch { return sum; } }, 0);
          return { dirName, fileCount: files.length, totalBytes };
        } catch { return { dirName, fileCount: 0, totalBytes: 0 }; }
      });
    res.json(orphaned);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orphaned/:dirName/transfer', async (req, res) => {
  const { dirName } = req.params;
  const localDir = path.join(DOWNLOAD_DIR, dirName);

  if (!fs.existsSync(localDir)) {
    return res.status(404).json({ error: 'Directory not found' });
  }

  for (const [, j] of jobs) {
    if (j.dirName === dirName && (j.status === 'transferring' || j.status === 'downloading')) {
      return res.status(409).json({ error: 'Transfer already in progress' });
    }
  }

  const jobId = `orphan-${Date.now()}`;
  const job = {
    id: jobId,
    magnetURI: '',
    splraUrl: null,
    metadata: {},
    dirName,
    destDir: localDir,
    status: 'transferring',
    transferResult: null,
    transferError: null,
    transferProgress: { phase: 'connecting' },
    transferStartedAt: Date.now(),
    renameResult: { targetDir: localDir },
    localDeleted: false,
    localDeleteError: null,
    isOrphaned: true,
  };
  jobs.set(jobId, job);
  saveJobs();

  res.json({ jobId, status: 'transferring' });
  startTransfer(job);
});

app.get('/api/cache', (req, res) => {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      return res.json([]);
    }
    const entries = fs.readdirSync(CACHE_DIR)
      .filter(e => { try { return fs.statSync(path.join(CACHE_DIR, e)).isDirectory(); } catch { return false; } });
    const cache = entries.map(dirName => {
      const full = path.join(CACHE_DIR, dirName);
      try {
        function countFiles(dir) {
          let count = 0;
          for (const e of fs.readdirSync(dir)) {
            const p = path.join(dir, e);
            try { if (fs.statSync(p).isDirectory()) { count += countFiles(p); } else { count++; } } catch {}
          }
          return count;
        }
        return { dirName, fileCount: countFiles(full) };
      } catch { return { dirName, fileCount: 0 }; }
    });
    res.json(cache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cache/:dirName/reprocess', async (req, res) => {
  const { dirName } = req.params;
  const cachePath = path.join(CACHE_DIR, dirName);

  if (!fs.existsSync(cachePath)) {
    return res.status(404).json({ error: 'Cache directory not found' });
  }

  const stagingDir = path.join(DOWNLOAD_DIR, dirName);
  if (fs.existsSync(stagingDir)) {
    return res.status(409).json({ error: 'Staging directory already exists. Delete it first or wait for existing job to finish.' });
  }

  try {
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.cpSync(cachePath, stagingDir, { recursive: true });
    logJob('INFO', 'reprocess_start', '-', `copied cache to ${stagingDir}`);
  } catch (err) {
    return res.status(500).json({ error: `Failed to copy from cache: ${err.message}` });
  }

  let metadata = parseDirectoryName(dirName);
  const archiveId2 = req.body.archiveIdentifier || metadata.archiveIdentifier;
  metadata = enrichMetadataFromNfo(metadata, stagingDir);
  let trackTitles = {};
  try {
    trackTitles = await buildTrackTitles(stagingDir, metadata, archiveId2);
    logJob('INFO', 'track_titles', '-', `merged ${Object.keys(trackTitles).length} titles (archive+nfo+setlist)`);
  } catch (e) {
    logJob('WARN', 'track_titles_failed', '-', e.message);
  }

  try {
    const result = renameFiles(stagingDir, metadata, trackTitles);
    logJob('INFO', 'rename', '-', `renamed=${result.files.length} files`);
    logRenameCollisions(result, '-');
    try { await convertShnToFlac(result.targetDir); } catch (e) { logJob('ERROR', 'shn2flac_failed', '-', e.message); }
    const filterResult = filterAudioFormats(result.targetDir);
    logJob('INFO', 'filter', '-', `kept=${filterResult.kept} deleted=${filterResult.deletedCount}`);
    if (!hasAudioFiles(result.targetDir)) {
      return res.status(400).json({ error: 'No audio files found after filtering', renameResult: result });
    }
    const renameMap = {};
    for (const f of result.files) { renameMap[f.renamed] = f.original; }
    try { await tagFiles(result.targetDir, metadata, trackTitles, renameMap); logJob('INFO', 'tag', '-', 'done'); } catch (e) { logJob('ERROR', 'tag_failed', '-', e.message); }
    try { await generateCover(metadata, result.targetDir); } catch (e) { logJob('ERROR', 'cover_failed', '-', e.message); }

    const jobId = `reprocess-${Date.now()}`;
    const job = {
      id: jobId,
      magnetURI: '',
      splraUrl: null,
      metadata,
      dirName,
      destDir: stagingDir,
      status: 'transferring',
      transferResult: null,
      transferError: null,
      transferProgress: { phase: 'connecting' },
      transferStartedAt: Date.now(),
      renameResult: result,
      filterResult,
      localDeleted: false,
      localDeleteError: null,
    };
    jobs.set(jobId, job);
    saveJobs();
    startTransfer(job);

    res.json({ jobId, status: 'processing', message: 'Re-processing from cache', renameResult: result, filterResult });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jobs/:id/resume', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!['interrupted', 'downloading'].includes(job.status)) {
    return res.status(400).json({ error: `Job is ${job.status}, not resumable` });
  }
  res.json({ success: true, message: 'Resuming download' });
  if (job.downloadMode === 'direct' && job.metadata && job.metadata.archiveIdentifier) {
    resumeDirectDownload(job);
  } else {
    resumeDownload(job);
  }
});

app.delete('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  downloader.removeTorrent(req.params.id);
  if (job.downloadMode === 'direct' && job.metadata && job.metadata.archiveIdentifier) {
    downloader.cancelDirectDownload(job.metadata.archiveIdentifier);
  }
  progressSnapshots.delete(req.params.id);
  cleanupAndRemove(job);
  res.json({ success: true });
});

app.listen(PORT, HOST, () => {
  console.log(`spbootlegs running on http://${HOST}:${PORT}`);
  console.log(`SSH transfer target: ${process.env.SP_SSH_USER || 'admin'}@${process.env.SP_SSH_HOST || '(not configured)'}:${process.env.SP_SSH_REMOTE_DIR || '/downloads'}`);
  logJob('INFO', 'startup', '-', `spbootlegs started on port ${PORT}`);
});

process.on('SIGINT', () => {
  downloader.destroy();
  process.exit(0);
});