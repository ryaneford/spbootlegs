import http from 'http';
import path from 'path';

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://flaresolverr:8191/v1';

function parseUrlTitle(url) {
  const match = url.match(/[?&]title=([^&]+)/);
  if (!match) return null;

  const title = decodeURIComponent(match[1]);
  const result = { rawTitle: title, sourceType: '', showDate: '', entryId: '' };

  const releaseMatch = title.match(/^(\d+)-Release-(\d{4}-\d{2}-\d{2})(.*)/);
  if (releaseMatch) {
    result.entryId = releaseMatch[1];
    result.showDate = releaseMatch[2];
    result.sourceType = releaseMatch[3].trim();
    return result;
  }

  const showMatch = title.match(/^(\d{4})-(\d{2})-(\d{2})(.*)/);
  if (showMatch) {
    result.showDate = `${showMatch[1]}-${showMatch[2]}-${showMatch[3]}`;
    result.sourceType = showMatch[4].trim();
    return result;
  }

  const tspMatch = title.match(/^Tsp(\d{4})-(\d{2})-(\d{2})/);
  if (tspMatch) {
    result.showDate = `${tspMatch[1]}-${tspMatch[2]}-${tspMatch[3]}`;
    return result;
  }

  return result;
}

function parseHtml(html) {
  const metadata = {
    title: '',
    date: '',
    venue: '',
    city: '',
    state: '',
    country: '',
    source: '',
    lineage: '',
    generation: '',
    length: '',
    setlist: '',
    torrentLinks: [],
    magnetLinks: [],
    archiveLinks: [],
    recordings: [],
    rawContent: '',
  };

  const titleMatch = html.match(/<span class="mw-page-title-main"[^>]*>([^<]+)<\/span>/);
  if (titleMatch) {
    metadata.title = titleMatch[1].trim();
  }

  const headlineMatch = html.match(/<span[^>]*id="SPLRA_Release:[^"]*"[^>]*>([^<]+)<\/span>/);
  if (headlineMatch) {
    metadata.title = metadata.title || headlineMatch[1].trim();
  }

  const VIDEO_FORMATS = /^(?:VHS|DVB|DVD|VCD|MKV|AVI|MP4|MPEG\d*|XviD|DivX|x264|x265|h264|h265|HEVC|VC[R1]?|VID)$/i;
  const VIDEO_SOURCES = /^(?:TV|dTV|PRO|PRO-SHOT|AMT)$/i;

  // Parse infobox table (tour page sidebar)
  const thtdPairs = [];
  const thtdRegex = /<th[^>]*>([^<]*)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
  let pairMatch;
  while ((pairMatch = thtdRegex.exec(html)) !== null) {
    const label = pairMatch[1].replace(/<[^>]+>/g, '').trim();
    const value = pairMatch[2].replace(/<[^>]+>/g, '').trim();
    thtdPairs.push({ label, value });
  }

  for (const { label, value } of thtdPairs) {
    if (label === 'Date' && !metadata.date) {
      metadata.date = value;
    } else if (label === 'Venue' && !metadata.venue) {
      metadata.venue = value;
    } else if (label === 'Location' && !metadata.city) {
      const locMatch = value.match(/^(.+?),\s*([A-Z]{2})(?:,\s*([A-Z]{2}))?$/);
      if (locMatch) {
        metadata.city = locMatch[1].trim();
        metadata.state = locMatch[2];
        metadata.country = locMatch[3] || '';
      } else {
        const locMatch2 = value.match(/^(.+?),\s*(.+)$/);
        if (locMatch2) {
          metadata.city = locMatch2[1].trim();
          metadata.state = locMatch2[2].trim();
        }
      }
    }
  }

  // Parse Surfaced Recordings section
  const srStart = html.indexOf('Surfaced Recordings');
  const srEnd = html.indexOf('Unsurfaced Recordings');
  if (srStart > -1) {
    const srHtml = srEnd > -1 ? html.substring(srStart, srEnd) : html.substring(srStart);

    // Split into individual recordings by their headings
    // Recording headings: <th bgcolor="#fff9de" colspan="2" align="left">pFM #1</th>
    const headingRegex = /<th[^>]*bgcolor="#fff9de"[^>]*>\s*(.*?)\s*<\/th>/gs;
    const headings = [];
    let hMatch;
    while ((hMatch = headingRegex.exec(srHtml)) !== null) {
      headings.push({ heading: hMatch[1].replace(/<[^>]+>/g, '').trim(), index: hMatch.index });
    }

    for (let i = 0; i < headings.length; i++) {
      const recHtml = i + 1 < headings.length
        ? srHtml.substring(headings[i].index, headings[i + 1].index)
        : srHtml.substring(headings[i].index);

      const recording = {
        heading: headings[i].heading,
        source: '',
        format: '',
        length: '',
        complete: '',
        archiveId: null,
        archiveUrl: null,
        isVideo: false,
        videoReason: '',
        notes: '',
      };

const recPairs = [];
      const recPairRegex = /<th[^>]*>([^<]*)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
      let rpMatch;
      while ((rpMatch = recPairRegex.exec(recHtml)) !== null) {
        const label = rpMatch[1].replace(/<[^>]+>/g, '').trim();
        const value = rpMatch[2].trim();
        recPairs.push({ label, value });
      }

      for (const { label, value } of recPairs) {
        const cleanValue = value.replace(/<[^>]+>/g, '').trim();
        if (label === 'Source') recording.source = cleanValue;
        else if (label === 'Format') recording.format = cleanValue;
        else if (label === 'Length') recording.length = cleanValue;
        else if (label === 'Complete?') recording.complete = cleanValue;
        else if (label === 'Notes') recording.notes = cleanValue;
        else if (label === 'Release') {
          // Links to a SPLRA release page which hosts its own torrent (SPLRA S3)
          const relMatch = value.match(/href="(\/wiki\/[^"#]+)"/i);
          if (relMatch) {
            recording.releasePageUrl = 'https://www.splra.org' + relMatch[1].replace(/&amp;/g, '&');
          }
        }
        else if (label === 'Live Music Archive') {
          const arMatch = value.match(/href="(https?:\/\/(?:www\.)?archive\.org\/details\/([^"&]+))"/i);
          if (arMatch) {
            recording.archiveUrl = arMatch[1].replace(/&amp;/g, '&');
            recording.archiveId = arMatch[2];
          }
          const archiveText = value.replace(/<[^>]+>/g, '').trim();
          if (archiveText && !recording.notes) recording.notes = archiveText;
        }
      }

      // Determine if this is a video recording
      if (VIDEO_SOURCES.test(recording.source)) {
        recording.isVideo = true;
        recording.videoReason = `Source "${recording.source}" is a video recording`;
      } else if (VIDEO_FORMATS.test(recording.format)) {
        recording.isVideo = true;
        recording.videoReason = `Format "${recording.format}" is a video format`;
      }

      metadata.recordings.push(recording);
    }
  }

  // Parse <pre> block (release pages)
  const preMatch = html.match(/<pre>([\s\S]*?)<\/pre>/);
  if (preMatch) {
    const preContent = preMatch[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    metadata.rawContent = preContent;

    const lines = preContent.split('\n').map((l) => l.trim());

    let currentSection = '';
    const setlistLines = [];

    for (const line of lines) {
      if (/^\d{4}/.test(line) && line.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i)) {
        const dateStr = line.trim();
        const monthMap = {
          january: '01', february: '02', march: '03', april: '04',
          may: '05', june: '06', july: '07', august: '08',
          september: '09', october: '10', november: '11', december: '12',
        };
        const dm = dateStr.match(/(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i);
        if (dm) {
          const month = monthMap[dm[1].toLowerCase()];
          const day = dm[2].padStart(2, '0');
          metadata.date = `${dm[3]}-${month}-${day}`;
        }
      }

      const sourceMatch = line.match(/^SOURCE\s*(?:\(([^)]+)\))?\s*:\s*(.+)/i);
      if (sourceMatch) {
        metadata.source = sourceMatch[2].trim();
        if (sourceMatch[1]) metadata.source = `${sourceMatch[1]}: ${sourceMatch[2].trim()}`;
      }

      const lineageMatch = line.match(/^LINEAGE\s*:\s*(.+)/i);
      if (lineageMatch) {
        metadata.lineage = lineageMatch[1].trim();
      }

      const generationMatch = line.match(/^GENERATION\s*:\s*(.+)/i);
      if (generationMatch) {
        metadata.generation = generationMatch[1].trim();
      }

      const lengthMatch = line.match(/^LENGTH\s*:\s*(.+)/i);
      if (lengthMatch) {
        metadata.length = lengthMatch[1].trim();
      }

      if (line.startsWith('SETLIST:') || line.startsWith('SETLIST')) {
        currentSection = 'setlist';
        continue;
      }
      if (line.startsWith('ENCORE:') || line.startsWith('ENCORE')) {
        currentSection = 'encore';
        continue;
      }
      if (line.startsWith('MD5') || line.startsWith('RECORDED BY') || line.startsWith('DISTRIBUTION')) {
        currentSection = '';
      }

      if (currentSection === 'setlist' || currentSection === 'encore') {
        if (/^\d+\./.test(line)) {
          setlistLines.push(line);
        }
      }

      if (!metadata.venue) {
        const lines2 = preContent.split('\n');
        for (let i = 0; i < lines2.length; i++) {
          const l = lines2[i].trim();
          if (l.match(/^\d/) && l.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i) && i + 1 < lines2.length) {
            const nextLine = lines2[i + 1].trim();
            if (nextLine && !nextLine.match(/^(SOURCE|LINEAGE|GENERATION|SETLIST)/) && !nextLine.match(/^\d/) && nextLine.length > 0) {
              metadata.venue = nextLine;
            }
            break;
          }
        }
      }
    }

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i) && i + 1 < lines.length) {
        const venueLine = lines[i + 1].trim();
        if (venueLine && !venueLine.match(/^(SOURCE|LINEAGE|GENERATION|SETLIST|TRANSFER)/)) {
          metadata.venue = metadata.venue || venueLine;
          if (i + 2 < lines.length) {
            const locLine = lines[i + 2].trim();
            const locMatch = locLine.match(/^(.+?),\s*([A-Z]{2})(?:,\s*(\w+))?$/);
            if (locMatch) {
              metadata.city = locMatch[1].trim();
              metadata.state = locMatch[2];
              metadata.country = locMatch[3] || '';
            } else {
              const locMatch2 = locLine.match(/^(.+?),\s*(.+)$/);
              if (locMatch2) {
                metadata.city = locMatch2[1].trim();
                metadata.state = locMatch2[2].trim();
              }
            }
          }
          break;
        }
      }
    }

    metadata.setlist = setlistLines.join('\n');
  }

  const linkRegex = /href="([^"]*\.torrent[^"]*)"/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    metadata.torrentLinks.push(linkMatch[1].replace(/&amp;/g, '&'));
  }

  const magnetRegex = /href="(magnet:[^"]+)"/gi;
  let magnetMatch;
  while ((magnetMatch = magnetRegex.exec(html)) !== null) {
    metadata.magnetLinks.push(magnetMatch[1].replace(/&amp;/g, '&'));
  }

  const VIDEO_INDICATORS = /-(?:VHS|DVD|MPEG\d*|x264|x265|h264|h265|mp4|mkv|avi|XviD|DivX|PRO-?SHOT|webm|HEVC|VC[D1]?\b)/i;
  const VIDEO_SOURCE_TYPES = /^(?:PRO\d*a?|AMT\d*a?|PRO-SHOT\d*a?)$/i;

  // Only check isVideo for release pages (not tour pages with recordings array)
  if (metadata.recordings.length === 0) {
    const isVideoSource = VIDEO_SOURCE_TYPES.test(metadata.source);
    const hasVideoTorrent = metadata.torrentLinks.some(l => VIDEO_INDICATORS.test(l));

    if (isVideoSource || hasVideoTorrent) {
      metadata.isVideo = true;
      metadata.videoReason = isVideoSource
        ? `Source type "${metadata.source}" is a video recording`
        : `Torrent file appears to be video: ${metadata.torrentLinks.find(l => VIDEO_INDICATORS.test(l))}`;
    }
  }

  // Build archiveLinks from recordings AND from standalone links
  metadata.archiveLinks = [];

  // Add archive links from recordings
  for (const rec of metadata.recordings) {
    if (rec.archiveId && !rec.isVideo) {
      metadata.archiveLinks.push({ url: rec.archiveUrl, identifier: rec.archiveId, heading: rec.heading, source: rec.source, format: rec.format, length: rec.length, complete: rec.complete });
    }
  }

  // Also find standalone archive links (not already captured from recordings)
  const archiveLinkRegex = /href="(https?:\/\/(?:www\.)?archive\.org\/details\/([^"&]+))"/gi;
  let archiveMatch;
  const seenIds = new Set(metadata.archiveLinks.map(a => a.identifier));
  while ((archiveMatch = archiveLinkRegex.exec(html)) !== null) {
    const id = archiveMatch[2];
    if (!seenIds.has(id)) {
      metadata.archiveLinks.push({ url: archiveMatch[1].replace(/&amp;/g, '&'), identifier: id });
      seenIds.add(id);
    }
  }

  return metadata;
}

function normalizeSplraUrl(url) {
  const match = url.match(/splra\.org\/wiki\/(index\.php\?title=)?(.+)/);
  if (match) {
    const title = match[2].replace(/&.*$/, '');
    return `https://www.splra.org/wiki/index.php?title=${title}`;
  }
  return url;
}

async function lookup(url) {
  // Direct archive.org URL
  const archiveMatch = url.match(/archive\.org\/details\/([^&?]+)/);
  if (archiveMatch) {
    const identifier = archiveMatch[1];
    const meta = await fetchArchiveMetadata(identifier);
    const idLower = identifier.toLowerCase();
    let band = 'sp';
    if (idLower.startsWith('zwan')) band = 'zwan';
    else if (idLower.startsWith('bc')) band = 'bc';
    const metadata = {
      band,
      title: meta.title || identifier,
      date: meta.date || '',
      venue: meta.venue || '',
      city: meta.city || '',
      state: meta.state || '',
      country: meta.country || '',
      source: meta.source || '',
      lineage: meta.lineage || '',
      generation: '',
      length: '',
      setlist: '',
      torrentLinks: meta.torrentUrl ? [meta.torrentUrl] : [],
      magnetLinks: [],
      archiveLinks: [{ url: `https://archive.org/details/${identifier}`, identifier }],
      archiveIdentifier: identifier,
      rawContent: '',
      isVideo: false,
      videoReason: '',
    };
    return metadata;
  }

  url = normalizeSplraUrl(url);

  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 3000;
  const FS_TIMEOUT_MS = 120000;

  const urlInfo = parseUrlTitle(url);

  async function attempt(n) {
    const body = JSON.stringify({ cmd: 'request.get', url, maxTimeout: FS_TIMEOUT_MS });

    const metadata = await new Promise((resolve, reject) => {
      const parsedUrl = new URL(FLARESOLVERR_URL);
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.status !== 'ok') {
              return reject(new Error(`FlareSolverr error: ${json.message || 'Unknown error'}`));
            }
            const html = json.solution && json.solution.response;
            if (!html) {
              return reject(new Error('FlareSolverr returned empty response'));
            }
            resolve(parseHtml(html));
          } catch (err) {
            reject(new Error(`Failed to parse FlareSolverr response: ${err.message}`));
          }
        });
      });

      req.on('error', (err) => reject(new Error(`FlareSolverr request failed: ${err.message}`)));
      req.setTimeout(FS_TIMEOUT_MS + 5000, () => {
        req.destroy();
        reject(new Error('FlareSolverr request timed out'));
      });

      req.write(body);
      req.end();
    });

    if (urlInfo && urlInfo.showDate && !metadata.date) metadata.date = urlInfo.showDate;
    if (urlInfo && urlInfo.sourceType && !metadata.source) metadata.source = urlInfo.sourceType;
    return metadata;
  }

  let lastError;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    try {
      return await attempt(i);
    } catch (err) {
      lastError = err;
      const isRetryable = err.message.includes('timed out') || err.message.includes('Timeout') || err.message.includes('empty response');
      console.log(`[flaresolverr] attempt ${i}/${MAX_ATTEMPTS} failed: ${err.message}`);
      if (i < MAX_ATTEMPTS && isRetryable) {
        console.log(`[flaresolverr] retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      } else if (i < MAX_ATTEMPTS) {
        break; // non-retryable errors (malformed JSON etc.) won't be fixed by retrying
      }
    }
  }
  throw lastError;
}

async function fetchTorrentFile(torrentUrl) {
  const res = await fetch(torrentUrl, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Failed to download torrent file: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchArchiveMetadata(identifier) {
  const url = `https://archive.org/download/${identifier}/${identifier}_meta.xml`;

  async function fetchText(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Failed to fetch archive.org metadata: HTTP ${res.status}`);
    return res.text();
  }

  const xml = await fetchText(url);

  const tag = (name) => {
    const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`));
    if (!m) return '';
    return m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
  };

  const coverage = tag('coverage');
  let city = '', state = '', country = '';
  if (coverage) {
    const m = coverage.match(/^(.+?),\s*([A-Z]{2}),\s*([A-Z]{2})$/);
    if (m) { city = m[1].trim(); state = m[2]; country = m[3]; }
    else {
      const m2 = coverage.match(/^(.+?),\s*([A-Z]{2})$/);
      if (m2) { city = m2[1].trim(); state = m2[2]; }
    }
  }

  let source = tag('source') || '';
  if (source.length > 30) {
    const srcMatch = source.match(/^(\w+)/);
    if (srcMatch) source = srcMatch[1];
  }

  return {
    title: tag('title'),
    date: (tag('date') || '').substring(0, 10),
    venue: tag('venue'),
    city,
    state,
    country,
    source,
    lineage: tag('lineage'),
    identifier: tag('identifier') || identifier,
    torrentUrl: `https://archive.org/download/${identifier}/${identifier}_archive.torrent`,
  };
}

async function fetchArchiveTrackTitles(identifier) {
  const url = `https://archive.org/download/${identifier}/${identifier}_files.xml`;
  const AUDIO_EXTS = new Set(['.flac', '.shn', '.ape', '.mp3', '.ogg', '.wav', '.m4a', '.aac', '.opus']);

  async function fetchText(targetUrl) {
    const res = await fetch(targetUrl, {
      headers: { 'User-Agent': 'sp-bootleg-downloader/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Failed to fetch files XML: HTTP ${res.status}`);
    return res.text();
  }

  let xml;
  try {
    xml = await fetchText(url);
  } catch (err) {
    console.log(`[archive-titles] failed to fetch _files.xml for ${identifier}: ${err.message}`);
    return {};
  }

  const trackTitles = {};
  // Only parse source="original" files — skips duplicate derivatives (.mp3, .png, etc.)
  const fileRegex = /<file\s+name="([^"]+)"\s+source="original"[^>]*>([\s\S]*?)<\/file>/g;
  let m;
  while ((m = fileRegex.exec(xml)) !== null) {
    const filename = m[1];
    const inner = m[2];
    const ext = path.extname(filename).toLowerCase();
    if (!AUDIO_EXTS.has(ext)) continue;

    const titleMatch = inner.match(/<title>([^<]*)<\/title>/);
    const trackMatch = inner.match(/<track>([^<]*)<\/track>/);
    if (!titleMatch) continue;
    const title = titleMatch[1]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
    if (!title) continue;

    // Key by original filename for exact lookup
    trackTitles[filename] = title;

    // Key by track number from <track> tag
    if (trackMatch) {
      const n = parseInt(trackMatch[1].trim(), 10);
      if (!isNaN(n)) trackTitles[`track_${n}`] = title;
    }

    // Key by disc+track pattern from filename (e.g. d1t5, t3)
    const dtMatch = filename.match(/[Dd](\d+)[_.\-]?[Tt](\d+)/i);
    if (dtMatch) {
      trackTitles[`d${parseInt(dtMatch[1], 10)}t${parseInt(dtMatch[2], 10)}`] = title;
    } else {
      const tMatch = filename.match(/(?:^|[^a-zA-Z])[Tt](\d+)/) || filename.match(/^(\d{1,3})[._\-\s]/);
      if (tMatch) trackTitles[`t${parseInt(tMatch[1], 10)}`] = title;
    }
  }

  console.log(`[archive-titles] fetched ${Object.keys(trackTitles).length} track title mappings for ${identifier}`);
  return trackTitles;
}

export { lookup, parseUrlTitle, parseHtml, fetchTorrentFile, fetchArchiveMetadata, fetchArchiveTrackTitles };