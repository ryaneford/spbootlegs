import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

const AUDIO_EXTENSIONS = new Set(['.flac', '.shn', '.ape', '.mp3', '.ogg', '.wav', '.m4a', '.aac', '.wma', '.opus', '.aiff', '.aif']);
// Lossless formats in priority order — first match wins
const LOSSLESS = ['.flac', '.shn', '.ape'];

function sanitize(str) {
  return str
    .replace(/[<>:"/\\|?*\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const BAND_NAMES = {
  sp:   'The Smashing Pumpkins',
  zwan: 'Zwan',
  bc:   'Billy Corgan',
};

function bandDisplayName(band) {
  return BAND_NAMES[band] || 'Smashing Pumpkins';
}

function buildDirectoryName(metadata) {
  const parts = [];

  const bandName = bandDisplayName(metadata.band);
  parts.push(bandName);

  if (metadata.date) {
    parts.push(metadata.date);
  }

  if (metadata.venue) {
    parts.push(sanitize(metadata.venue));
  }

  if (metadata.city || metadata.state) {
    const location = [metadata.city, metadata.state].filter(Boolean).join(', ');
    if (location) parts.push(sanitize(location));
  }

  if (metadata.source) {
    parts.push(sanitize(metadata.source));
  }

  return parts.join(' - ') || 'Unknown_Show';
}

const JUNK_EXTENSIONS = new Set([
  '.afpk', '.json', '.gz',
]);

const JUNK_SUFFIXES = [
  '_esshigh.json.gz', '_esslow.json.gz',
  '_spectrogram.png',
];

const JUNK_FILES = new Set(['.ds_store', 'thumbs.db']);

function extractTrackNumber(filename) {
  const base = path.basename(filename, path.extname(filename));
  const patterns = [
    /[Dd](\d+)[_.\-]?[Tt](\d+)/,
    /[Tt](\d+)[_.\-]?[Dd](\d+)/,
    /track[_\-]?(\d+)/i,
    /[Tt](\d{1,3})$/,              // tNN at end — archive naming like tspDATE-tNN
    /^(\d{1,3})[._\-\s]/,
    /[._\-](\d{1,3})$/,
  ];
  for (const pat of patterns) {
    const m = base.match(pat);
    if (m) {
      if (pat === patterns[0] || pat === patterns[1]) {
        return { disc: parseInt(m[1], 10), track: parseInt(m[2], 10) };
      }
      return { disc: null, track: parseInt(m[1] || m[2], 10) };
    }
  }
  return null;
}

function isJunkFile(filename) {
  const lower = filename.toLowerCase();
  if (JUNK_FILES.has(lower)) return true;
  const ext = path.extname(lower);
  if (JUNK_EXTENSIONS.has(ext)) return true;
  if (ext === '.xml' && lower.includes('_meta.xml')) return true;
  if (ext === '.png' && !lower.endsWith('folder.png')) return true;
  for (const suffix of JUNK_SUFFIXES) {
    if (lower.endsWith(suffix.toLowerCase())) return true;
  }
  return false;
}

function collectFiles(dir, allFiles, subDirs, discOverride) {
  const entries = fs.readdirSync(dir);
  // Only treat a directory as a disc dir if its entire name is a disc indicator
  // (e.g. "D1", "Disc2", "disc_3") — not archive identifiers like "bc2025-06-11.aud1"
  const dirBasename = path.basename(dir);
  const dirDiscNum = /^[Dd](?:isc)?[\s_-]?(\d+)$/i.test(dirBasename)
    ? dirBasename.match(/(\d+)/)?.[0] || null
    : null;
  const effectiveDisc = discOverride || dirDiscNum;

  for (const entry of entries) {
    const srcPath = path.join(dir, entry);
    let stat;
    try { stat = fs.statSync(srcPath); } catch { continue; }

    if (stat.isDirectory()) {
      subDirs.push(srcPath);
      collectFiles(srcPath, allFiles, subDirs, effectiveDisc);
    } else if (stat.isFile()) {
      allFiles.push({ original: entry, srcPath, discOverride: effectiveDisc });
    }
  }
}

function lookupTrackTitle(originalName, trackTitles) {
  if (!trackTitles || Object.keys(trackTitles).length === 0) return null;
  if (trackTitles[originalName]) return trackTitles[originalName];
  const base = path.basename(originalName, path.extname(originalName));
  if (trackTitles[base]) return trackTitles[base];
  for (const [key, title] of Object.entries(trackTitles)) {
    const keyBase = path.basename(key, path.extname(key));
    if (keyBase === base) return title;
  }
  return null;
}

function lookupTrackTitleByPosition(disc, track, trackTitles) {
  if (!trackTitles || track == null) return null;
  // Try structured keys first (populated by fetchArchiveTrackTitles / parseSetlistTitles)
  if (disc != null) {
    const k = `d${disc}t${track}`;
    if (trackTitles[k]) return trackTitles[k];
  }
  const tKey = `track_${track}`;
  if (trackTitles[tKey]) return trackTitles[tKey];
  // Fallback for archive items where files have no disc prefix (e.g. tspDATE-tNN)
  const tKeyShort = `t${track}`;
  if (trackTitles[tKeyShort]) return trackTitles[tKeyShort];
  // Legacy regex fallback — exact match only to avoid false positives
  const pattern = disc != null
    ? new RegExp(`[Dd]0?${disc}[_.\\-]?[Tt]0?${track}\\b`, 'i')
    : new RegExp(`^[Tt]0?${track}$`, 'i');
  for (const [key, title] of Object.entries(trackTitles)) {
    if (pattern.test(key) && title && title.trim()) return title.trim();
  }
  return null;
}

function renameFiles(downloadDir, metadata, trackTitles = {}) {
  const prefix = buildDirectoryName(metadata);
  const targetDir = downloadDir;
  const allFiles = [];
  const subDirs = [];

  collectFiles(downloadDir, allFiles, subDirs, null);
  console.log(`[renamer] collected ${allFiles.length} files from ${downloadDir} (${subDirs.length} subdirs)`);

  let trackCounter = 0;
  const renamedFiles = [];
  const audioFiles = allFiles.filter(f => {
    const ext = path.extname(f.original).toLowerCase();
    return AUDIO_EXTENSIONS.has(ext);
  });
  const nonAudioFiles = allFiles.filter(f => {
    const ext = path.extname(f.original).toLowerCase();
    return !AUDIO_EXTENSIONS.has(ext);
  });

  audioFiles.sort((a, b) => {
    const aTrack = extractTrackNumber(a.original);
    const bTrack = extractTrackNumber(b.original);
    if (aTrack && bTrack) {
      const aD = aTrack.disc || a.discOverride ? parseInt(a.discOverride || aTrack.disc, 10) : 0;
      const bD = bTrack.disc || b.discOverride ? parseInt(b.discOverride || bTrack.disc, 10) : 0;
      if (aD !== bD) return aD - bD;
      return aTrack.track - bTrack.track;
    }
    if (aTrack && !bTrack) return -1;
    if (!aTrack && bTrack) return 1;
    return a.original.localeCompare(b.original);
  });

  // Pre-assign counter values for files without explicit disc/track info.
  // Group by basename (minus extension) so that FLAC and MP3 versions of
  // the same archive track get the same counter — otherwise they'd get
  // different T0N values and filterAudioFormats wouldn't de-duplicate them.
  let counterNext = 0;
  const baseToCounter = new Map();
  for (const file of audioFiles) {
    const trackInfo = extractTrackNumber(file.original);
    if (!trackInfo || (!trackInfo.disc && !file.discOverride)) {
      const base = path.basename(file.original, path.extname(file.original));
      if (!baseToCounter.has(base)) {
        baseToCounter.set(base, ++counterNext);
      }
    }
  }

  console.log(`[renamer] audio=${audioFiles.length} nonAudio=${nonAudioFiles.length} total=${allFiles.length} prefix="${prefix}"`);

  const filesToDelete = [];
  const collisions = [];

  for (const file of audioFiles) {
    trackCounter++;
    const ext = path.extname(file.original).toLowerCase();
    const trackInfo = extractTrackNumber(file.original);
    const disc = trackInfo && (trackInfo.disc || file.discOverride) ? parseInt(file.discOverride || trackInfo.disc, 10) : null;
    const track = trackInfo ? trackInfo.track : null;
    let discPart = '';
    if (trackInfo && (trackInfo.disc || file.discOverride)) {
      const d = file.discOverride || trackInfo.disc;
      discPart = `D${d}T${String(trackInfo.track).padStart(2, '0')}`;
    } else {
      const base = path.basename(file.original, path.extname(file.original));
      const counter = baseToCounter.get(base) || trackCounter;
      discPart = `T${String(counter).padStart(2, '0')}`;
    }
    const newName = `${prefix} - ${discPart}${ext}`;
    const destPath = path.join(targetDir, newName);

    if (file.srcPath === destPath) {
      renamedFiles.push({ original: file.original, renamed: newName, path: destPath });
      continue;
    }
    if (!fs.existsSync(file.srcPath)) continue;

    if (fs.existsSync(destPath)) {
      // Two different source files both resolved to the same track slot.
      // Resolve by size instead of silently appending "(1)" to the filename:
      // identical size = true duplicate (drop it), otherwise keep the larger file.
      const newSize = fs.statSync(file.srcPath).size;
      const existingSize = fs.statSync(destPath).size;
      if (newSize === existingSize) {
        collisions.push({ slot: discPart, reason: 'duplicate', kept: 'existing', original: file.original });
        filesToDelete.push(file.srcPath);
        continue;
      }
      if (newSize > existingSize) {
        fs.copyFileSync(file.srcPath, destPath);
        filesToDelete.push(file.srcPath);
        collisions.push({ slot: discPart, reason: 'mismatch', kept: 'new', original: file.original, keptSize: newSize, droppedSize: existingSize });
        const existingEntry = renamedFiles.find(r => r.path === destPath);
        if (existingEntry) existingEntry.original = file.original;
        continue;
      }
      collisions.push({ slot: discPart, reason: 'mismatch', kept: 'existing', original: file.original, keptSize: existingSize, droppedSize: newSize });
      filesToDelete.push(file.srcPath);
      continue;
    }

    fs.copyFileSync(file.srcPath, destPath);
    filesToDelete.push(file.srcPath);
    renamedFiles.push({ original: file.original, renamed: newName, path: destPath });
  }

  for (const file of nonAudioFiles) {
    const lower = file.original.toLowerCase();
    if (isJunkFile(file.original)) {
      filesToDelete.push(file.srcPath);
      continue;
    }
    if (lower === 'folder.png') {
      const destPath = path.join(targetDir, 'folder.png');
      if (file.srcPath !== destPath) {
        fs.copyFileSync(file.srcPath, destPath);
        filesToDelete.push(file.srcPath);
      }
      renamedFiles.push({ original: file.original, renamed: 'folder.png', path: destPath });
      continue;
    }
    const ext = path.extname(file.original).toLowerCase();
    if (['.txt', '.md5', '.ffp', '.stk', '.cue', '.log', '.info'].includes(ext)) {
      const newName = `${prefix}${ext}`;
      const destPath = path.join(targetDir, newName);
      if (file.srcPath !== destPath) {
        if (fs.existsSync(file.srcPath)) {
          fs.copyFileSync(file.srcPath, destPath);
          filesToDelete.push(file.srcPath);
        }
      }
      renamedFiles.push({ original: file.original, renamed: newName, path: destPath });
      continue;
    }
    const newName = sanitize(file.original);
    const destPath = path.join(targetDir, newName);
    if (file.srcPath !== destPath && fs.existsSync(file.srcPath)) {
      fs.copyFileSync(file.srcPath, destPath);
      filesToDelete.push(file.srcPath);
    }
    renamedFiles.push({ original: file.original, renamed: newName, path: destPath });
  }

  for (const p of filesToDelete) {
    try { fs.unlinkSync(p); } catch {}
  }
  for (const subDir of subDirs) {
    try { fs.rmSync(subDir, { recursive: true, force: true }); } catch {}
  }

  const afterEntries = fs.readdirSync(targetDir);
  console.log(`[renamer] after processing: ${afterEntries.length} files remain in ${targetDir}`);
  const afterExts = [...new Set(afterEntries.map(f => path.extname(f).toLowerCase()))].sort();
  console.log(`[renamer] extensions present: ${afterExts.join(', ')}`);

  return { dirName: prefix, targetDir, files: renamedFiles, collisions };
}

// Converts SHN files to FLAC using up to 4 parallel ffmpeg workers
async function convertShnToFlac(dir) {
  const entries = fs.readdirSync(dir);
  const shnFiles = entries.filter(f => path.extname(f).toLowerCase() === '.shn' && fs.statSync(path.join(dir, f)).isFile());
  if (shnFiles.length === 0) return { converted: 0, failed: 0 };

  console.log(`[shn2flac] converting ${shnFiles.length} SHN files to FLAC`);
  let converted = 0, failed = 0;

  const CONCURRENCY = 4;
  const queue = [...shnFiles];

  const worker = async () => {
    while (queue.length > 0) {
      const f = queue.shift();
      const srcPath = path.join(dir, f);
      const destPath = srcPath.replace(/\.shn$/i, '.flac');
      const args = ['-i', srcPath, '-c:a', 'flac', '-y', destPath];
      await new Promise((resolve) => {
        execFile('ffmpeg', args, (err) => {
          if (!err && fs.existsSync(destPath)) {
            try { fs.unlinkSync(srcPath); converted++; } catch { failed++; }
          } else {
            failed++;
            try { fs.unlinkSync(destPath); } catch {}
          }
          resolve();
        });
      });
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, shnFiles.length) }, () => worker()));
  console.log(`[shn2flac] done: ${converted} converted, ${failed} failed`);
  return { converted, failed };
}

function trackBaseName(filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const m = base.match(/[Dd](\d+)[_.\-]?[Tt](\d+)/);
  if (m) return `D${m[1]}T${m[2]}`;
  const m2 = base.match(/[Tt](\d+)/);
  if (m2) return `T${m2[1]}`;
  return base.toLowerCase().trim();
}

function filterAudioFormats(dir) {
  const entries = fs.readdirSync(dir);
  const files = entries.filter(e => { try { return fs.statSync(path.join(dir, e)).isFile(); } catch { return false; } });
  console.log(`[filter] scanning ${dir}: ${files.length} files`);

  const audioByExt = {};
  for (const ext of [...LOSSLESS, '.mp3']) {
    audioByExt[ext] = files.filter(f => path.extname(f).toLowerCase() === ext);
  }

  let bestLossless = null;
  for (const ext of LOSSLESS) {
    if (audioByExt[ext].length > 0) {
      bestLossless = ext;
      console.log(`[filter] found ${audioByExt[ext].length} ${ext} files, using as primary format`);
      break;
    }
  }

  const keepFiles = new Set();
  const deleteFiles = [];

  if (bestLossless) {
    const losslessSet = new Set(audioByExt[bestLossless].map(f => trackBaseName(f)));
    for (const f of audioByExt[bestLossless]) keepFiles.add(f);

    if (audioByExt['.mp3'].length > 0) {
      let mp3Kept = 0;
      for (const f of audioByExt['.mp3']) {
        const base = trackBaseName(f);
        if (!losslessSet.has(base)) {
          keepFiles.add(f);
          mp3Kept++;
        } else {
          deleteFiles.push(f);
        }
      }
      if (mp3Kept > 0) console.log(`[filter] keeping ${mp3Kept} mp3 tracks with no ${bestLossless} equivalent`);
    }

    for (const ext of LOSSLESS) {
      if (ext !== bestLossless) {
        for (const f of audioByExt[ext]) deleteFiles.push(f);
      }
    }
  } else if (audioByExt['.mp3'].length > 0) {
    for (const f of audioByExt['.mp3']) keepFiles.add(f);
    console.log(`[filter] no lossless, keeping ${audioByExt['.mp3'].length} mp3 files`);
  } else {
    console.log(`[filter] WARNING: no audio files with known extensions found!`);
    console.log(`[filter] file extensions present:`, [...new Set(files.map(f => path.extname(f).toLowerCase()))]);
  }

  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (AUDIO_EXTENSIONS.has(ext) && !keepFiles.has(f) && !deleteFiles.includes(f)) {
      deleteFiles.push(f);
    }
  }

  const deleted = [];
  for (const f of deleteFiles) {
    try { fs.unlinkSync(path.join(dir, f)); deleted.push(f); } catch {}
  }

  // Clean up junk files that should never be transferred
  for (const f of files) {
    if (f.endsWith('.tagtmp') || f === '__ia_thumb.jpg' || f === 'audiochecker.log') {
      try { fs.unlinkSync(path.join(dir, f)); deleted.push(f); } catch {}
    }
  }

  const remaining = entries.filter(e => { try { return fs.statSync(path.join(dir, e)).isFile(); } catch { return false; } });
  const keptLabel = bestLossless ? bestLossless.slice(1) : (audioByExt['.mp3'].length > 0 ? 'mp3' : 'none');
  console.log(`[filter] result: kept ${remaining.length} files (${keptLabel}), deleted ${deleted.length}`);
  return { kept: keptLabel, deletedCount: deleted.length, deleted };
}

const TAGGABLE = new Set(['.flac', '.mp3', '.ogg', '.m4a', '.aac', '.opus', '.aiff', '.aif']);

async function tagFiles(dir, metadata, trackTitles = {}, renameMap = null) {
  const album = buildDirectoryName(metadata);
  const artist = bandDisplayName(metadata.band);
  const date = metadata.date || '';
  const entries = fs.readdirSync(dir).filter(f => {
    try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
  });

  const audioFiles = entries.filter(f => {
    const ext = path.extname(f).toLowerCase();
    return TAGGABLE.has(ext);
  }).sort((a, b) => a.localeCompare(b));

  // FLAC files are tagged post-transfer on the NAS via metaflac (faster, no re-encode).
  // Collect their tag data here and skip the ffmpeg step for them.
  const flacTags = [];

  const titleFromFilename = (f) => {
    const ext = path.extname(f);
    const base = path.basename(f, ext);
    const cleanBase = base.replace(/[\[\]]/g, '');
    const prefixes = [buildDirectoryName(metadata) + ' - '];
    for (const pfx of prefixes) {
      if (base.startsWith(pfx) || cleanBase.startsWith(pfx)) {
        const src = base.startsWith(pfx) ? base : cleanBase;
        const remainder = src.slice(pfx.length);
        const m = remainder.match(/^[DT]\d+T\d+\s*-\s*(.+)$/);
        if (m) return m[1].trim();
        const m2 = remainder.match(/^T\d+\s*-\s*(.+)$/);
        if (m2) return m2[1].trim();
        if (!/^[DT]\d+T\d+$/.test(remainder) && !/^T\d+$/.test(remainder)) {
          return remainder.trim();
        }
      }
    }
    return null;
  };

  // Extract title from original upload filenames like "01 - Title - Venue Date.flac"
  const titleFromOriginalFilename = (orig) => {
    const ext = path.extname(orig);
    const base = path.basename(orig, ext);
    const parts = base.split(' - ');
    if (parts.length >= 3 && /^\d+$/.test(parts[0].trim())) {
      // "01 - Title - Venue Date" → "Title" (exclude first and last parts)
      return parts.slice(1, -1).join(' - ').trim() || null;
    }
    if (parts.length === 2 && /^\d+$/.test(parts[0].trim())) {
      // "01 - Title" → "Title"
      return parts[1].trim() || null;
    }
    return null;
  };

  const tagged = [], skipped = [];
  for (let i = 0; i < audioFiles.length; i++) {
    const f = audioFiles[i];
    const ext = path.extname(f).toLowerCase();
    const filePath = path.join(dir, f);
    const tmpPath = filePath + '.tagtmp';
    const trackNum = i + 1;

    const trackInfo = extractTrackNumber(f);
    const disc = trackInfo ? (trackInfo.disc || null) : null;
    const track = trackInfo ? trackInfo.track : null;

    const filenameTitle = titleFromFilename(f);

    const originalName = renameMap ? renameMap[f] : null;
    const archiveTitle = (originalName && lookupTrackTitle(originalName, trackTitles))
      || (originalName && lookupTrackTitleByPosition(disc, track, trackTitles))
      || (!originalName && lookupTrackTitle(f, trackTitles))
      || (!originalName && lookupTrackTitleByPosition(disc, track, trackTitles));

    const originalFilenameTitle = (!filenameTitle && originalName) ? titleFromOriginalFilename(originalName) : null;

    let title;
    if (filenameTitle) {
      title = filenameTitle;
    } else if (originalFilenameTitle) {
      title = originalFilenameTitle;
    } else if (archiveTitle) {
      title = archiveTitle;
    } else if (trackInfo) {
      title = `Track ${trackInfo.disc ? `D${trackInfo.disc}T${String(trackInfo.track).padStart(2, '0')}` : String(trackInfo.track).padStart(2, '0')}`;
    } else {
      title = `Track ${trackNum}`;
    }

    // FLAC: defer to post-transfer metaflac on NAS (no re-encode, instant, no temp files)
    if (ext === '.flac') {
      flacTags.push({ filename: f, trackNum, title, artist, albumArtist: artist, album, date });
      tagged.push(f);
      continue;
    }

    const formatFlag = ['-f', 'mp3'];
    const codecFlag = ['-c:a', 'libmp3lame', '-b:a', '320k'];
    const args = ['-i', filePath,
      '-map_metadata', '-1',
      '-map', '0:a',
      ...formatFlag,
      ...codecFlag,
      '-metadata', `ARTIST=${artist}`,
      '-metadata', `ALBUMARTIST=${artist}`,
      '-metadata', `ALBUM=${album}`,
      '-metadata', `DATE=${date}`,
      '-metadata', `TRACKNUMBER=${trackNum}`,
      '-metadata', `TITLE=${title}`,
      '-y', tmpPath];
    await new Promise((resolve) => {
      execFile('ffmpeg', args, (err) => {
        if (!err && fs.existsSync(tmpPath)) {
          fs.renameSync(tmpPath, filePath);
          tagged.push(f);
        } else {
          try { fs.unlinkSync(tmpPath); } catch {}
          skipped.push(f);
          if (err) console.log(`[tag] ffmpeg error for ${f}: ${err.message}`);
        }
        resolve();
      });
    });
  }
  console.log(`[tag] tagged ${tagged.length} files (${flacTags.length} flac deferred to NAS), skipped ${skipped.length}`);
  return { tagged, skipped, flacTags };
}

function parseNfoFile(content) {
  const result = { date: '', venue: '', city: '', state: '', source: '', lineage: '', generation: '', trackTitles: {} };
  const monthMap = { january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',july:'07',august:'08',september:'09',october:'10',november:'11',december:'12' };
  const META_KEY = /^(SOURCE|LINEAGE|TRANSFER|COMMENT|GENERATION|SETLIST|TRACKLIST|ENCORE|MD5|RECORDED|DISTRIBUTION|NOTES|TAPER|FORMAT|BITRATE|LENGTH|VENUE)/i;
  const nonBlank = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  let dateIdx = -1;

  for (let i = 0; i < nonBlank.length; i++) {
    const line = nonBlank[i];

    // Date
    if (!result.date) {
      const dm = line.match(/(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})/i);
      if (dm) {
        const mo = monthMap[dm[1].toLowerCase()];
        if (mo) { result.date = `${dm[3]}-${mo}-${dm[2].padStart(2, '0')}`; dateIdx = i; }
      }
      if (!result.date) {
        const iso = line.match(/(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
        if (iso) { result.date = `${iso[1]}-${iso[2]}-${iso[3]}`; dateIdx = i; }
      }
    }

    // "Venue; City, ST[, Country]" — single-line combined format
    if (!result.venue && line.includes(';')) {
      const semi = line.indexOf(';');
      const vp = line.slice(0, semi).trim();
      const lp = line.slice(semi + 1).trim();
      const lm = lp.match(/^(.+?),\s*([A-Z]{2})(?:,[\s\w]+)?$/);
      if (lm) { result.venue = vp; result.city = lm[1].trim(); result.state = lm[2]; }
    }

    // Explicit key: value metadata
    const sm = line.match(/^SOURCE\s*(?:\([^)]+\))?\s*:\s*(.+)/i);
    if (sm) result.source = result.source || sm[1].trim();
    const lnm = line.match(/^(?:LINEAGE|TRANSFER|COMMENT)\s*:\s*(.+)/i);
    if (lnm) result.lineage = result.lineage || lnm[1].trim();
    const gm = line.match(/^GENERATION\s*:\s*(.+)/i);
    if (gm) result.generation = result.generation || gm[1].trim();
    const vm = line.match(/^VENUE\s*:\s*(.+)/i);
    if (vm) result.venue = result.venue || vm[1].trim();

    // Disc-track format with optional tab-separated duration: "d1t01\tTitle\t04:22"
    const dtm = line.match(/^[Dd](\d+)[Tt](\d+)[\s\t]+(.+)$/);
    if (dtm) {
      const disc = parseInt(dtm[1], 10);
      const track = parseInt(dtm[2], 10);
      const title = dtm[3].replace(/\s+\d+:\d+\s*$/, '').replace(/[\t ]{2,}/g, ' ').trim();
      if (title) {
        result.trackTitles[`d${disc}t${track}`] = title;
        result.trackTitles[`track_${track}`] = title;
      }
      continue;
    }

    // Standard numbered track: "01. Track Title" or "1) Track Title"
    const nm = line.match(/^(\d+)[.\)]\s+(.+)/);
    if (nm) {
      const trackNum = parseInt(nm[1], 10);
      // Strip trailing tab-separated duration and collapse whitespace
      const title = nm[2].replace(/\s+\d+:\d+\s*$/, '').replace(/[\t ]{2,}/g, ' ').trim();
      if (!title.includes(' > ') && !title.match(/^[0-9a-f]{32}/i) && title.length > 0) {
        result.trackTitles[`track_${trackNum}`] = title;
      }
    }
  }

  // Positional venue fallback: line after date is venue, line after that is "City, ST"
  if (!result.venue && dateIdx >= 0) {
    const after = nonBlank[dateIdx + 1];
    if (after && !META_KEY.test(after) && !after.match(/^\d/) && !after.includes(';')) {
      result.venue = after;
      const loc = nonBlank[dateIdx + 2];
      if (loc) {
        const lm2 = loc.match(/^(.+?),\s*([A-Z]{2})(?:,[\s\w]+)?$/);
        if (lm2) { result.city = lm2[1].trim(); result.state = lm2[2]; }
      }
    }
  }

  return result;
}

function parseNfoFiles(dir) {
  const NFO_EXTS = new Set(['.txt', '.nfo', '.info', '.log', '.md']);
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }

  const merged = { date: '', venue: '', city: '', state: '', source: '', lineage: '', trackTitles: {} };
  let found = false;

  for (const entry of entries) {
    const ext = path.extname(entry).toLowerCase();
    if (!NFO_EXTS.has(ext)) continue;
    const fPath = path.join(dir, entry);
    try {
      const stat = fs.statSync(fPath);
      if (!stat.isFile() || stat.size > 200000) continue;
      const content = fs.readFileSync(fPath, 'utf8');
      const parsed = parseNfoFile(content);
      if (parsed.date || parsed.source || parsed.lineage || Object.keys(parsed.trackTitles).length > 0) {
        found = true;
        if (parsed.date) merged.date = merged.date || parsed.date;
        if (parsed.venue) merged.venue = merged.venue || parsed.venue;
        if (parsed.city) merged.city = merged.city || parsed.city;
        if (parsed.state) merged.state = merged.state || parsed.state;
        if (parsed.source) merged.source = merged.source || parsed.source;
        if (parsed.lineage) merged.lineage = merged.lineage || parsed.lineage;
        Object.assign(merged.trackTitles, parsed.trackTitles);
      }
    } catch {}
  }

  return found ? merged : null;
}

function parseSetlistTitles(text) {
  if (!text) return {};
  const titles = {};
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)[.\)]\s+(.+)/);
    if (m) titles[`track_${parseInt(m[1], 10)}`] = m[2].trim();
  }
  return titles;
}

export { buildDirectoryName, renameFiles, filterAudioFormats, convertShnToFlac, tagFiles, sanitize, AUDIO_EXTENSIONS, parseNfoFiles, parseSetlistTitles, BAND_NAMES };
