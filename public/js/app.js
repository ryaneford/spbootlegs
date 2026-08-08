const $ = (sel) => document.querySelector(sel);

const ALLOWED_HOSTS = ['splra.org', 'www.splra.org', 'archive.org', 'www.archive.org'];

const META_FIELDS = ['date', 'venue', 'city', 'state', 'source'];

function getMetaFields() {
  const out = {};
  for (const f of META_FIELDS) out[f] = $(`#meta-${f}`).value;
  return out;
}

// Only overwrites fields present (and truthy) in `values` — matches the old
// per-field `if (data.metadata.x) ...` behavior of not clobbering existing input.
function setMetaFields(values) {
  for (const f of META_FIELDS) {
    if (values[f]) $(`#meta-${f}`).value = values[f];
  }
}

function clearMetaFields() {
  for (const f of META_FIELDS) $(`#meta-${f}`).value = '';
}

let currentMetadata = null;
let selectedArchiveId = null;
let selectedReleasePageUrl = null;
let pollInterval = null;

function startPolling(fast) {
  clearInterval(pollInterval);
  pollInterval = setInterval(refreshJobs, fast ? 3000 : 10000);
}
let lookupTimeout = null;

function isAllowedUrl(url) {
  try {
    const u = new URL(url);
    return ALLOWED_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

function showToast(msg, type = 'info') {
  const toast = $('#toast');
  toast.textContent = msg;
  toast.className = `toast ${type} show`;
  setTimeout(() => { toast.className = 'toast'; }, 4000);
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatSpeed(bps) {
  if (!bps && bps !== 0) return '';
  return formatBytes(bps) + '/s';
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '';
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function updateNamePreview() {
  const { date, venue, city, state, source } = getMetaFields();
  const parts = [];
  if (date) parts.push(date);
  if (venue) parts.push(venue);
  const loc = [city, state].filter(Boolean).join(', ');
  if (loc) parts.push(loc);
  if (source) parts.push(`[${source}]`);
  $('#name-preview').textContent = parts.join(' - ') || 'Unknown_Show';
}

function updateCoverPreview() {
  const qp = new URLSearchParams({
    ...getMetaFields(),
    country: (currentMetadata && currentMetadata.country) || '',
    band: $('#band-select').value || 'sp',
  });
  $('#cover-img').src = `/api/cover-preview?${qp.toString()}`;
  $('#cover-preview').style.display = 'block';
}

function renderRecordings(recordings) {
  const container = $('#recordings-list');
  const section = $('#recordings-section');

  const audioRecordings = recordings.filter(r => !r.isVideo);
  const videoRecordings = recordings.filter(r => r.isVideo);

  if (audioRecordings.length === 0 && videoRecordings.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  let html = '';

  for (const rec of audioRecordings) {
    const label = rec.heading || rec.source;
    const details = [rec.source, rec.format, rec.length, rec.complete === 'Yes' ? 'Complete' : rec.complete === 'No' ? 'Incomplete' : ''].filter(Boolean).join(' &bull; ');
    const archiveTag = rec.archiveId ? ' &bull; Archive.org' : '';
    html += `<div class="recording-item recording-audio" data-archive-id="${rec.archiveId || ''}" data-release-page-url="${rec.releasePageUrl || ''}" data-source="${rec.source || ''}" onclick="selectRecording(this)">
      <div class="recording-heading">${label}</div>
      <div class="recording-details">${details}${archiveTag}${rec.archiveId ? `<span class="recording-peers"></span>` : ''}</div>
      ${rec.notes ? `<div class="recording-notes">${rec.notes.substring(0, 120)}${rec.notes.length > 120 ? '...' : ''}</div>` : ''}
    </div>`;
  }

  for (const rec of videoRecordings) {
    const label = rec.heading || rec.source;
    const details = [rec.source, rec.format, rec.length].filter(Boolean).join(' &bull; ');
    html += `<div class="recording-item recording-video">
      <div class="recording-heading">${label}</div>
      <div class="recording-details">${details} &bull; Video — not available</div>
    </div>`;
  }

  container.innerHTML = html;
}

window.selectRecording = function(el) {
  const archiveId = el.dataset.archiveId;
  const source = el.dataset.source;

  document.querySelectorAll('.recording-audio').forEach(r => r.classList.remove('selected'));
  el.classList.add('selected');

  const releasePageUrl = el.dataset.releasePageUrl;

  if (!archiveId && !releasePageUrl) {
    showToast('No download available for this recording', 'error');
    $('#download-btn').disabled = true;
    selectedArchiveId = null;
    selectedReleasePageUrl = null;
    return;
  }

  selectedArchiveId = archiveId || null;
  selectedReleasePageUrl = null;

  // Release-page recording (SPLRA S3 torrent, no archive.org ID)
  if (releasePageUrl && !archiveId) {
    selectedReleasePageUrl = releasePageUrl;
    if (source && !$('#meta-source').value) $('#meta-source').value = source;
    updateNamePreview();
    updateCoverPreview();
    const lookupStatus = $('#lookup-status');
    lookupStatus.className = 'lookup-status success';
    lookupStatus.innerHTML = `Selected: ${el.querySelector('.recording-heading').textContent} — SPLRA torrent`;
    $('#download-btn').disabled = false;
    return;
  }
  if (source && !$('#meta-source').value) {
    $('#meta-source').value = source;
  }
  updateNamePreview();
  updateCoverPreview();

  const lookupStatus = $('#lookup-status');
  const downloadBtn = $('#download-btn');

  downloadBtn.disabled = true;
  lookupStatus.className = 'lookup-status loading';
  lookupStatus.innerHTML = '<span class="spinner"></span> Checking seeders...';

  const peerEl = el.querySelector('.recording-peers');
  if (peerEl) peerEl.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> Checking...';

  fetch('/api/check-peers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: archiveId }),
  })
    .then(r => r.json())
    .then(result => {
      if (result.error) {
        lookupStatus.className = 'lookup-status error';
        lookupStatus.innerHTML = `Error checking peers: ${result.error}`;
        if (peerEl) peerEl.textContent = 'Error';
        return;
      }

      const peers = result.peers || 0;
      const name = result.name || '';

      if (result.timedOut && peers === 0) {
        lookupStatus.className = 'lookup-status error';
        lookupStatus.innerHTML = `No seeders found for this torrent. It may be dead.`;
        el.classList.add('no-seeders');
        el.classList.remove('selected');
        if (peerEl) peerEl.textContent = '0 seeders';
        downloadBtn.disabled = true;
        selectedArchiveId = null;
      } else {
        lookupStatus.className = 'lookup-status success';
        lookupStatus.innerHTML = `Selected: ${el.querySelector('.recording-heading').textContent}${peers > 0 ? ` (${peers} peer${peers !== 1 ? 's' : ''})` : ''}`;
        if (peerEl) peerEl.textContent = `${peers} peer${peers !== 1 ? 's' : ''}`;
        el.classList.remove('no-seeders');
        downloadBtn.disabled = false;
      }
    })
    .catch(() => {
      lookupStatus.className = 'lookup-status success';
      lookupStatus.innerHTML = `Selected: ${el.querySelector('.recording-heading').textContent}`;
      downloadBtn.disabled = false;
      if (peerEl) peerEl.textContent = '';
    });
};

async function doLookup(url) {
  const urlStatus = $('#url-status');
  const lookupStatus = $('#lookup-status');
  const downloadBtn = $('#download-btn');

  urlStatus.className = 'url-status loading';
  lookupStatus.style.display = 'block';
  lookupStatus.className = 'lookup-status loading';
  lookupStatus.innerHTML = '<span class="spinner"></span> Looking up...';
  downloadBtn.disabled = true;
  selectedArchiveId = null;
  $('#recordings-section').style.display = 'none';

  // Show a "still working" hint after 15s in case FlareSolverr is retrying
  const stillWorkingTimer = setTimeout(() => {
    if (lookupStatus.classList.contains('loading')) {
      lookupStatus.innerHTML = '<span class="spinner"></span> Solving Cloudflare challenge… this can take up to a minute';
    }
  }, 15000);

  try {
    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 420000); // 7 min hard cap
    let resp, data;
    try {
      resp = await fetch('/api/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });
      clearTimeout(fetchTimeout);
    } catch (fetchErr) {
      clearTimeout(fetchTimeout);
      throw new Error(fetchErr.name === 'AbortError' ? 'Lookup timed out — FlareSolverr could not solve the Cloudflare challenge' : `Network error: ${fetchErr.message}`);
    }
    try {
      data = await resp.json();
    } catch {
      throw new Error(`Server returned an unexpected response (HTTP ${resp.status}). Please try again.`);
    }

    if (!resp.ok) {
      const errMeta = data.metadata || {};
      if (errMeta.isVideo) {
        urlStatus.className = 'url-status invalid';
        lookupStatus.className = 'lookup-status error';
        lookupStatus.innerHTML = `Video recording &mdash; ${errMeta.videoReason || 'Only audio bootlegs are supported'}`;
        downloadBtn.disabled = true;
        return;
      }
      throw new Error(data.error || 'Lookup failed');
    }

    currentMetadata = data.metadata;
    urlStatus.className = 'url-status valid';

    const recordings = data.recordings || [];

    if (recordings.length > 0) {
      renderRecordings(recordings);

      const audioWithArchive = recordings.filter(r => !r.isVideo && r.archiveId);
      if (audioWithArchive.length === 1) {
        const rec = audioWithArchive[0];
        selectedArchiveId = rec.archiveId;
        if (rec.source && !data.metadata.source) data.metadata.source = rec.source;

        lookupStatus.className = 'lookup-status success';
        lookupStatus.innerHTML = `Found 1 audio recording with archive.org download`;
        downloadBtn.disabled = false;

        setTimeout(() => {
          const el = document.querySelector(`[data-archive-id="${rec.archiveId}"]`);
          if (el) el.classList.add('selected');
        }, 50);
      } else if (audioWithArchive.length > 1) {
        lookupStatus.className = 'lookup-status success';
        lookupStatus.innerHTML = `Found ${audioWithArchive.length} audio recordings. Select one below:`;
        downloadBtn.disabled = true;
      } else {
        lookupStatus.className = 'lookup-status error';
        lookupStatus.innerHTML = 'No audio recordings with archive.org downloads available';
        downloadBtn.disabled = true;
      }
    } else if (data.metadata.torrentLinks && data.metadata.torrentLinks.length > 0) {
      lookupStatus.className = 'lookup-status success';
      lookupStatus.innerHTML = `Found .torrent &mdash; ${data.metadata.venue || data.metadata.date || 'metadata loaded'}`;
      downloadBtn.disabled = false;
    } else if (data.archiveLinks && data.archiveLinks.length > 0) {
      lookupStatus.className = 'lookup-status success';
      lookupStatus.innerHTML = `Found ${data.archiveLinks.length} archive.org recording(s). Resolving...`;
      downloadBtn.disabled = true;

      for (const al of data.archiveLinks) {
        try {
          const arResp = await fetch('/api/archive-lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier: al.identifier }),
          });
          const arData = await arResp.json();
          if (arData.torrentUrl) {
            data.metadata.torrentLinks.push(arData.torrentUrl);
            if (arData.archiveTitle) data.metadata.archiveTitle = arData.archiveTitle;
            if (arData.venue && !data.metadata.venue) data.metadata.venue = arData.venue;
            if (arData.date && !data.metadata.date) data.metadata.date = arData.date;
            if (arData.source && !data.metadata.source) data.metadata.source = arData.source;
            if (arData.city && !data.metadata.city) data.metadata.city = arData.city;
            if (arData.state && !data.metadata.state) data.metadata.state = arData.state;
            if (arData.country && !data.metadata.country) data.metadata.country = arData.country;
          }
        } catch (e) { /* skip failed archive lookups */ }
      }

      if (data.metadata.torrentLinks.length > 0) {
        lookupStatus.className = 'lookup-status success';
        lookupStatus.innerHTML = `Found ${data.metadata.torrentLinks.length} audio torrent(s) from archive.org`;
        downloadBtn.disabled = false;
      } else {
        lookupStatus.className = 'lookup-status error';
        lookupStatus.innerHTML = 'No audio torrents found on archive.org';
        downloadBtn.disabled = true;
      }
    } else if (data.metadata.torrentLinks && data.metadata.torrentLinks.length > 0) {
      lookupStatus.className = 'lookup-status success';
      lookupStatus.innerHTML = `Found .torrent file &mdash; ${data.metadata.venue || data.metadata.date || 'metadata loaded'}`;
      downloadBtn.disabled = false;
    } else if (data.metadata.magnetLinks && data.metadata.magnetLinks.length > 0) {
      lookupStatus.className = 'lookup-status success';
      lookupStatus.innerHTML = `Found magnet link &mdash; ${data.metadata.venue || data.metadata.date || 'metadata loaded'}`;
      downloadBtn.disabled = false;
    } else {
      lookupStatus.className = 'lookup-status error';
      lookupStatus.innerHTML = 'No torrent or magnet link found on this page';
      downloadBtn.disabled = true;
    }

    $('#metadata-section').style.display = 'block';
    setMetaFields(data.metadata);

    updateNamePreview();

    if (data.metadata.date || data.metadata.venue || data.metadata.source) {
      $('#suggested-name').style.display = 'block';
      updateCoverPreview();
    }
  } catch (err) {
    urlStatus.className = 'url-status invalid';
    lookupStatus.className = 'lookup-status error';
    lookupStatus.innerHTML = err.message;
    downloadBtn.disabled = true;
  } finally {
    clearTimeout(stillWorkingTimer);
  }
}

$('#splra-url').addEventListener('input', () => {
  const url = $('#splra-url').value.trim();
  const urlStatus = $('#url-status');
  const lookupStatus = $('#lookup-status');
  const downloadBtn = $('#download-btn');

  clearTimeout(lookupTimeout);
  currentMetadata = null;
  selectedArchiveId = null;
  selectedReleasePageUrl = null;
  downloadBtn.disabled = true;
  $('#metadata-section').style.display = 'none';
  $('#suggested-name').style.display = 'none';
  $('#cover-preview').style.display = 'none';
  $('#recordings-section').style.display = 'none';
  lookupStatus.style.display = 'none';

  if (!url) {
    urlStatus.className = 'url-status';
    return;
  }

  if (!isAllowedUrl(url)) {
    urlStatus.className = 'url-status invalid';
    $('#url-hint').textContent = 'Only splra.org and archive.org URLs are accepted';
    $('#url-hint').className = 'hint-invalid';
    return;
  }

  urlStatus.className = 'url-status';
  $('#url-hint').textContent = 'Only URLs from splra.org and archive.org are accepted';
  $('#url-hint').className = '';

  // Auto-detect band from URL
  const titleMatch = url.match(/[?&]title=([^&]+)/i);
  if (titleMatch) {
    const title = decodeURIComponent(titleMatch[1]);
    if (/^zwan/i.test(title)) $('#band-select').value = 'zwan';
    else if (/^bc/i.test(title)) $('#band-select').value = 'bc';
    else if (/^tsp/i.test(title)) $('#band-select').value = 'sp';
  }

  lookupTimeout = setTimeout(() => doLookup(url), 600);
});

$('#splra-url').addEventListener('paste', (e) => {
  e.preventDefault();
  const url = (e.clipboardData || window.clipboardData).getData('text').trim();
  $('#splra-url').value = url;
  $('#splra-url').dispatchEvent(new Event('input'));
});

META_FIELDS.forEach((f) => {
  $(`#meta-${f}`).addEventListener('input', () => {
    if (!currentMetadata) return;
    updateNamePreview();
  });
});

$('#band-select').addEventListener('change', () => {
  if (currentMetadata) updateCoverPreview();
});

$('#job-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const splraUrl = $('#splra-url').value.trim();

  if (!splraUrl) {
    showToast('Provide a URL', 'error');
    return;
  }

  if (!isAllowedUrl(splraUrl)) {
    showToast('Only splra.org and archive.org URLs are accepted', 'error');
    return;
  }

  const customMetadata = { ...getMetaFields(), band: $('#band-select').value };

  const payload = { customMetadata };
  if (selectedReleasePageUrl) {
    payload.splraUrl = selectedReleasePageUrl;
  } else {
    payload.splraUrl = splraUrl;
    if (selectedArchiveId) {
      payload.archiveIdentifier = selectedArchiveId;
    }
  }

  const downloadBtn = $('#download-btn');
  downloadBtn.disabled = true;
  downloadBtn.innerHTML = '<span class="spinner"></span> Starting...';

  try {
    const resp = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();

    if (!resp.ok) throw new Error(data.error || 'Failed to start download');

    showToast(`Download started: ${data.dirName}`, 'success');
    downloadBtn.textContent = 'Start Download';
    resetForm();
    refreshJobs();

    startPolling(true);
  } catch (err) {
    showToast(err.message, 'error');
    downloadBtn.disabled = false;
    downloadBtn.textContent = 'Start Download';
  }
});

function resetForm() {
  $('#splra-url').value = '';
  $('#url-status').className = 'url-status';
  $('#lookup-status').style.display = 'none';
  clearMetaFields();
  $('#metadata-section').style.display = 'none';
  $('#suggested-name').style.display = 'none';
  $('#cover-preview').style.display = 'none';
  $('#recordings-section').style.display = 'none';
  $('#download-btn').disabled = true;
  $('#download-btn').textContent = 'Start Download';
  currentMetadata = null;
  selectedArchiveId = null;
}

async function refreshJobs() {
  try {
    const resp = await fetch('/api/jobs');
    const jobs = await resp.json();
    renderJobs(jobs, '#jobs-list', 'No active downloads. Paste a URL above to get started.');
  } catch (_) {}
}

function renderTransferProgress(job) {
  const tp = job.transferProgress;
  if (!tp) return '';

  if (tp.phase === 'connecting') {
    return `<div class="phase-box phase-box-working">
      <span class="spinner"></span> Connecting to server...
    </div>`;
  }
  if (tp.phase === 'preparing') {
    return `<div class="phase-box phase-box-working">
      <span class="spinner"></span> ${tp.message || 'Preparing remote directory...'}
    </div>`;
  }
  if (tp.phase === 'transferring') {
    const pct = tp.totalFiles > 0 ? Math.round((tp.fileIndex / tp.totalFiles) * 100) : 0;
    const bytesPct = tp.totalBytes > 0 ? Math.round((tp.transferredBytes / tp.totalBytes) * 100) : pct;
    const elapsed = tp.elapsedMs ? ` &mdash; ${formatDuration(tp.elapsedMs)}` : '';
    return `
      <div class="phase-box phase-box-working">
        <div class="phase-label">Transferring to server (${tp.fileIndex}/${tp.totalFiles})${elapsed}</div>
        <div class="progress-bar">
          <div class="progress-bar-fill progress-bar-transfer" style="width:${bytesPct}%"></div>
        </div>
        <div class="phase-detail">${tp.currentFile} (${formatBytes(tp.fileSize)}) &bull; ${formatBytes(tp.transferredBytes)} / ${formatBytes(tp.totalBytes)}</div>
      </div>`;
  }
  if (tp.phase === 'verifying') {
    return `<div class="phase-box phase-box-working"><span class="spinner"></span> Verifying files on remote...</div>`;
  }
  return '';
}

function renderPipeline(job) {
  const pct = job.progress || 0;
  const isDone = job.done || pct >= 1;
  const tp = job.transferProgress;

  let steps;
  if (job.status === 'downloading' || job.status === 'renamed') {
    const directDone = job.downloadMode === 'direct' && job.directProgress && job.directProgress.phase === 'done';
    if (!directDone && pct < 0.99 && !isDone) {
      steps = ['active', 'pending', 'pending', 'pending', 'pending'];
    } else if (!job.renameResult) {
      steps = ['done', 'active', 'pending', 'pending', 'pending'];
    } else {
      steps = ['done', 'done', 'active', 'pending', 'pending'];
    }
  } else if (job.status === 'transferring') {
    steps = ['done', 'done', 'done', 'active', 'pending'];
  } else if (job.status === 'transferred') {
    steps = ['done', 'done', 'done', 'done', 'done'];
  } else if (job.status === 'transfer_failed') {
    steps = ['done', 'done', 'done', 'error', 'pending'];
  } else if (job.status === 'interrupted') {
    steps = ['error', 'pending', 'pending', 'pending', 'pending'];
  } else {
    steps = ['active', 'pending', 'pending', 'pending', 'pending'];
  }

  const labels = ['Download', 'Rename', 'Cover', 'Transfer', 'Done'];
  const nodeContent = { pending: '&ndash;', active: '<span class="step-spinner"></span>', done: '&#10003;', error: '&#10007;' };

  let pHtml = '<div class="pipeline">';
  labels.forEach((label, i) => {
    const s = steps[i];
    pHtml += `<div class="pipeline-step step-${s}"><div class="step-node">${nodeContent[s]}</div><div class="step-label">${label}</div></div>`;
    if (i < labels.length - 1) {
      pHtml += `<div class="pipeline-connector ${steps[i] === 'done' ? 'connector-done' : 'connector-pending'}"></div>`;
    }
  });
  pHtml += '</div>';

  let detail = '';

  if (job.status === 'downloading' || job.status === 'renamed') {
    if (job.downloadMode === 'direct' && job.directProgress) {
      const dp = job.directProgress;
      if (dp.phase === 'starting') {
        detail = `<div class="pipeline-detail pd-spinner-row">No peers found — fetching file list from archive.org…</div>`;
      } else if (dp.phase === 'done') {
        if (!job.renameResult) {
          detail = `<div class="pipeline-detail pd-spinner-row">Direct download complete — renaming files…</div>`;
        } else {
          const rName = job.renameResult.targetDir ? job.renameResult.targetDir.split('/').pop() : '';
          const fr2 = job.filterResult;
          const filterNote2 = fr2 && fr2.deletedCount > 0 ? ` — kept ${fr2.kept.toUpperCase()}, removed ${fr2.deletedCount} file${fr2.deletedCount !== 1 ? 's' : ''}` : '';
          detail = `<div class="pipeline-detail pd-spinner-row">Generating cover art${rName ? ` — <em>${rName}</em>` : ''}${filterNote2}…</div>`;
        }
      } else {
        const bytesPct = dp.totalBytes > 0 ? Math.round((dp.downloadedBytes / dp.totalBytes) * 100) : 0;
        const filesInfo = dp.totalFiles > 0 ? `${dp.completedFiles}/${dp.totalFiles} files` : '';
        detail = `<div class="pipeline-detail">
          <div class="pd-fallback-notice">No peers — downloading from archive.org <span class="pd-badge pd-badge-warn">fallback</span></div>
          <div class="pd-progress-bar"><div class="pd-progress-fill" style="width:${bytesPct}%"></div></div>
          <div class="pd-stats">
            <span>${bytesPct}%</span>
            ${filesInfo ? `<span>${filesInfo}</span>` : ''}
            <span>${formatBytes(dp.downloadedBytes)} / ${formatBytes(dp.totalBytes)}</span>
          </div>
          ${dp.currentFile ? `<div class="pd-current-file">${dp.currentFile}</div>` : ''}
        </div>`;
      }
    } else if (pct < 0.99 && !isDone) {
      const pctInt = Math.round(pct * 100);
      const stalledMins = job.stalledMs ? Math.floor(job.stalledMs / 60000) : 0;
      const stalledNote = stalledMins >= 5
        ? `<div class="pd-stalled ${stalledMins >= 10 ? 'pd-stalled-warn' : ''}">No activity for ${stalledMins}m${stalledMins >= 10 ? ' &mdash; may be dead' : ''}</div>`
        : '';
      detail = `<div class="pipeline-detail">
        <div class="pd-progress-bar"><div class="pd-progress-fill" style="width:${pctInt}%"></div></div>
        <div class="pd-stats">
          <span>${pctInt}%</span>
          ${(job.downloadSpeed || 0) > 0 ? `<span>${formatSpeed(job.downloadSpeed)}</span>` : ''}
          <span>${job.numPeers || 0} peer${(job.numPeers || 0) !== 1 ? 's' : ''}</span>
        </div>
        ${stalledNote}
      </div>`;
    } else if (!job.renameResult) {
      detail = `<div class="pipeline-detail pd-spinner-row">Renaming files&hellip;</div>`;
    } else {
      const rName = job.renameResult.targetDir ? job.renameResult.targetDir.split('/').pop() : '';
      const fr = job.filterResult;
      let filterNote = '';
      if (fr && fr.deletedCount > 0) {
        filterNote = ` &mdash; kept ${fr.kept.toUpperCase()}, removed ${fr.deletedCount} file${fr.deletedCount !== 1 ? 's' : ''}`;
      }
      detail = `<div class="pipeline-detail pd-spinner-row">Generating cover art${rName ? ` &mdash; <em>${rName}</em>` : ''}${filterNote}&hellip;</div>`;
    }
  } else if (job.status === 'transferring') {
    if (!tp || tp.phase === 'connecting') {
      detail = `<div class="pipeline-detail pd-spinner-row">Connecting to server&hellip;</div>`;
    } else if (tp.phase === 'preparing') {
      detail = `<div class="pipeline-detail pd-spinner-row">Creating remote directory&hellip;</div>`;
    } else if (tp.phase === 'transferring') {
      const bp = tp.totalBytes > 0 ? Math.round((tp.transferredBytes / tp.totalBytes) * 100) : 0;
      const el = tp.elapsedMs ? formatDuration(tp.elapsedMs) : '';
      detail = `<div class="pipeline-detail">
        <div class="pd-transfer-header">
          <span>${tp.fileIndex} / ${tp.totalFiles} files</span>
          ${el ? `<span>${el}</span>` : ''}
          <span>${formatBytes(tp.transferredBytes)} / ${formatBytes(tp.totalBytes)}</span>
        </div>
        <div class="pd-progress-bar"><div class="pd-progress-fill pd-fill-transfer" style="width:${bp}%"></div></div>
        <div class="pd-current-file">${tp.currentFile}</div>
      </div>`;
    } else if (tp.phase === 'verifying') {
      detail = `<div class="pipeline-detail pd-spinner-row">Verifying files on server&hellip;</div>`;
    }
  } else if (job.status === 'transferred') {
    const r = job.transferResult;
    const duration = r && r.durationMs ? formatDuration(r.durationMs) : '';
    const verified = r && r.verified;
    const vBadge = verified ? '<span class="pd-badge pd-badge-ok">verified</span>' : '<span class="pd-badge pd-badge-warn">unverified</span>';
    const cBadge = verified && job.localDeleted ? '<span class="pd-badge pd-badge-ok">local removed</span>'
      : (verified && !job.localDeleted ? '<span class="pd-badge pd-badge-warn">cleanup failed</span>' : '');
    const fr = job.filterResult;
    const fBadge = fr && fr.kept !== 'none' ? `<span class="pd-badge pd-badge-ok">${fr.kept.toUpperCase()} only</span>` : '';
    const modeBadge = job.downloadMode === 'direct' ? '<span class="pd-badge pd-badge-warn">archive.org fallback</span>' : '';
    detail = `<div class="pipeline-detail pd-done">
      <div class="pd-done-main">${r ? r.files.length : 0} files &rarr; <code>${r ? r.host : ''}</code>${duration ? ` &mdash; ${duration}` : ''}</div>
      <div class="pd-done-badges">${vBadge}${cBadge}${fBadge}${modeBadge}</div>
    </div>`;
  } else if (job.status === 'transfer_failed') {
    const el = tp && tp.elapsedMs ? formatDuration(tp.elapsedMs) : '';
    const fn = tp && tp.fileIndex && tp.totalFiles ? `${tp.fileIndex - 1}/${tp.totalFiles} files` : '';
    detail = `<div class="pipeline-detail pd-error">
      <div class="pd-error-msg">${job.transferError || 'Unknown error'}</div>
      ${el || fn ? `<div class="pd-error-meta">${[el ? `after ${el}` : '', fn].filter(Boolean).join(' &bull; ')}</div>` : ''}
    </div>`;
  } else if (job.status === 'interrupted') {
    const hasFilesDetail = job.renameResult && job.renameResult.files && job.renameResult.files.length > 0;
    detail = `<div class="pipeline-detail pd-error">
      <div class="pd-error-msg">Download interrupted &mdash; container restarted</div>
      <div class="pd-error-meta">${hasFilesDetail ? 'Files were downloaded before the interruption &mdash; click Delete Download to discard.' : 'No files were downloaded &mdash; click Resume to try again or Cancel to discard.'}</div>
    </div>`;
  }

  return `<div class="pipeline-wrap">${pHtml}${detail}</div>`;
}

function renderJobs(jobs, containerSel, emptyMsg) {
  const container = document.querySelector(containerSel);
  if (!container) return;

  if (!jobs || jobs.length === 0) {
    container.innerHTML = `<p class="empty-state">${emptyMsg}</p>`;
    if (containerSel === '#jobs-list') startPolling(false);
    return;
  }

  container.innerHTML = jobs.map((job) => {
    const pct = Math.round((job.progress || 0) * 100);
    const isDone = job.done || pct >= 100;

    const phaseHtml = renderPipeline(job);

    let actions = '';
    if (job.status === 'transfer_failed') {
      actions = `<button class="btn btn-small btn-primary" onclick="retryTransfer('${job.id}')">Retry Transfer</button> <button class="btn btn-small btn-danger" onclick="cancelJob('${job.id}')">Cancel</button>`;
    } else if (job.status === 'interrupted') {
      const hasFiles = job.renameResult && job.renameResult.files && job.renameResult.files.length > 0;
      if (hasFiles) {
        actions = `<button class="btn btn-small btn-danger" onclick="cancelJob('${job.id}')">Delete Download</button>`;
      } else {
        actions = `<button class="btn btn-small btn-primary" onclick="resumeDownload('${job.id}')">Resume</button> <button class="btn btn-small btn-danger" onclick="cancelJob('${job.id}')">Cancel</button>`;
      }
    } else if (job.status === 'downloading') {
      actions = `<button class="btn btn-small btn-danger" onclick="cancelJob('${job.id}')">Cancel</button>`;
    }

    return `
    <div class="job-item" data-id="${job.id}">
      <div class="job-header">
        <span class="job-name">${job.dirName || job.id}</span>
      </div>
      <div class="job-meta">
        ${job.metadata.date ? `<span>${job.metadata.date}</span>` : ''}
        ${job.metadata.venue ? `<span>${job.metadata.venue}</span>` : ''}
        ${job.metadata.source ? `<span>${job.metadata.source}</span>` : ''}
      </div>
      ${phaseHtml}
      ${actions ? `<div class="job-actions">${actions}</div>` : ''}
    </div>`;
  }).join('');

  if (pollInterval === null && jobs.some((j) => j.status === 'downloading' || j.status === 'transferring')) {
    pollInterval = setInterval(refreshJobs, 3000);
  }
}

// Shared by the simple fetch-then-toast-then-refresh action handlers below.
// retryTransfer() is NOT built on this — it needs to inspect the response
// body (the `removed` case) before deciding whether it succeeded.
async function runAction(url, { method = 'POST', confirmMsg, successMsg, successType = 'info', after = [], errorPrefix } = {}) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  try {
    const resp = await fetch(url, { method });
    if (!resp.ok) throw new Error((await resp.json()).error);
    if (successMsg) showToast(successMsg, successType);
    after.forEach((fn) => fn());
  } catch (err) {
    showToast(`${errorPrefix} failed: ${err.message}`, 'error');
  }
}

function dismissJob(id) {
  return runAction(`/api/jobs/${id}`, { method: 'DELETE', after: [refreshJobs, refreshOrphaned], errorPrefix: 'Dismiss' });
}

function resumeDownload(id) {
  return runAction(`/api/jobs/${id}/resume`, { successMsg: 'Resuming download...', after: [refreshJobs, () => startPolling(true)], errorPrefix: 'Resume' });
}

function cancelJob(id) {
  return runAction(`/api/jobs/${id}`, {
    method: 'DELETE',
    confirmMsg: 'Cancel this download and discard any downloaded data?',
    successMsg: 'Download cancelled',
    after: [refreshJobs, refreshOrphaned],
    errorPrefix: 'Cancel',
  });
}

async function retryTransfer(id) {
  try {
    const resp = await fetch(`/api/jobs/${id}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await resp.json();
    if (data.removed) {
      showToast(data.error, 'info');
      refreshJobs();
      refreshOrphaned();
      return;
    }
    if (!resp.ok) throw new Error(data.error);
    showToast('Transfer started', 'info');
    refreshJobs();
    startPolling(true);
  } catch (err) {
    showToast(`Transfer failed: ${err.message}`, 'error');
  }
}

async function loadRecentAlbums() {
  try {
    const resp = await fetch('/api/recent-albums');
    const albums = await resp.json();
    const container = $('#recent-albums');
    if (!albums || albums.length === 0) {
      container.innerHTML = '<p class="empty-state">No albums found</p>';
      return;
    }

    const shareUrls = await Promise.all(albums.map(async a => {
      try {
        const r = await fetch('/api/share-album', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: a.id }),
        });
        const d = await r.json();
        return d.url || '#';
      } catch {
        return '#';
      }
    }));

    container.innerHTML = '<ul class="album-list">' + albums.map((a, i) => {
      const artUrl = a.coverArt ? `/api/navidrome-art/${a.coverArt}` : '';
      const albumUrl = shareUrls[i];
      const duration = a.duration ? `${Math.floor(a.duration / 60)}m` : '';
      const meta = [a.songCount ? `${a.songCount} tracks` : '', duration].filter(Boolean).join(' • ');
      return `<li class="album-item">
        <a href="${albumUrl}" target="_blank" rel="noopener" class="album-link">
        ${artUrl ? `<img class="album-art" src="${artUrl}" alt="" loading="lazy" onerror="this.style.display='none'" />` : '<div class="album-art"></div>'}
        <div class="album-info">
          <div class="album-name" title="${a.name}">${a.name}</div>
          <div class="album-artist">${a.artist}</div>
          ${meta ? `<div class="album-meta">${meta}</div>` : ''}
        </div>
        </a>
      </li>`;
    }).join('') + '</ul>';
  } catch (_) {
    $('#recent-albums').innerHTML = '<p class="empty-state">Could not load albums</p>';
  }
}

async function refreshOrphaned() {
  try {
    const resp = await fetch('/api/orphaned');
    const dirs = await resp.json();
    renderOrphaned(dirs);
  } catch (_) {}
}

function renderOrphaned(dirs) {
  const section = $('#orphaned-section');
  if (!dirs || dirs.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  const list = $('#orphaned-list');
  list.innerHTML = dirs.map(d => `
    <div class="orphaned-item">
      <div class="orphaned-info">
        <span class="orphaned-name">${d.dirName}</span>
        <span class="orphaned-meta">${d.fileCount} file${d.fileCount !== 1 ? 's' : ''} &bull; ${formatBytes(d.totalBytes)}</span>
      </div>
      <button class="btn btn-small btn-primary" onclick="transferOrphaned('${d.dirName.replace(/'/g, "\\'")}')">Transfer</button>
    </div>`).join('');
}

window.transferOrphaned = function(dirName) {
  return runAction(`/api/orphaned/${encodeURIComponent(dirName)}/transfer`, {
    successMsg: `Transfer started: ${dirName}`,
    successType: 'success',
    after: [refreshOrphaned, refreshJobs, () => startPolling(true)],
    errorPrefix: 'Transfer',
  });
};

refreshJobs();
loadRecentAlbums();
refreshOrphaned();
setInterval(loadRecentAlbums, 60000);
setInterval(refreshOrphaned, 15000);
startPolling(false);

window.addEventListener('DOMContentLoaded', () => {
  $('#splra-url').value = '';
});
