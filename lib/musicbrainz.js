// MusicBrainz API integration for upload zone metadata enrichment.
// Rate limit: 1 request per second per MB policy.

const MB_BASE = 'https://musicbrainz.org/ws/2';
const USER_AGENT = `sp-bootleg-downloader/1.0 (${process.env.CONTACT_EMAIL || 'set-CONTACT_EMAIL-env-var@example.com'})`;

// Verified MBIDs
const ARTIST_MBIDS = {
  sp: 'ba0d6274-db14-4ef5-b28d-657ebde1a396',   // The Smashing Pumpkins
  zwan: '5af2629b-36de-486c-ad50-a89a28ff050f',  // Zwan
  bc: '3cbfd3e3-6d9b-4327-84ba-42cf646c98f9',    // Billy Corgan
};

let lastMbRequest = 0;

async function mbFetch(path) {
  const now = Date.now();
  const wait = Math.max(0, 1100 - (now - lastMbRequest));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastMbRequest = Date.now();
  const resp = await fetch(`${MB_BASE}${path}`, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
  });
  if (resp.status === 503) throw new Error('MusicBrainz rate limited');
  if (!resp.ok) throw new Error(`MusicBrainz HTTP ${resp.status}`);
  return resp.json();
}

// Search for a live/bootleg release by artist MBID and date.
// Returns the best match or null.
async function findRelease(band, date) {
  const mbid = ARTIST_MBIDS[band];
  if (!mbid || !date) return null;

  try {
    const q = encodeURIComponent(`arid:${mbid} AND date:${date}`);
    const data = await mbFetch(`/release?query=${q}&fmt=json&limit=10`);
    if (!data.releases?.length) return null;

    // Only accept an exact full-date match (YYYY-MM-DD) to avoid false positives
    const best = data.releases.find(r => r.date === date);
    if (!best) return null;

    return {
      mbid: best.id,
      title: best.title,
      date: best.date || date,
      status: best.status || '',
      url: `https://musicbrainz.org/release/${best.id}`,
    };
  } catch (e) {
    console.log(`[musicbrainz] findRelease error: ${e.message}`);
    return null;
  }
}

// Get the track list for a release, keyed as { t1: "Title", t2: "Title", ... }.
async function getReleaseTrackList(releaseMbid) {
  try {
    const data = await mbFetch(`/release/${releaseMbid}?inc=recordings&fmt=json`);
    const titles = {};
    let globalPos = 0;
    for (const medium of data.media || []) {
      for (const track of medium.tracks || []) {
        globalPos++;
        const title = track.recording?.title || track.title;
        if (title) titles[`t${globalPos}`] = title;
      }
    }
    return titles;
  } catch (e) {
    console.log(`[musicbrainz] getReleaseTrackList error: ${e.message}`);
    return {};
  }
}

// Look up canonical recording titles for an array of song titles.
// Returns { [lowercaseInput]: canonicalTitle } for high-confidence matches.
// Rate-limited, so only call for a small number of titles.
async function lookupSongTitles(band, titles) {
  const mbid = ARTIST_MBIDS[band];
  if (!mbid || !titles?.length) return {};

  const result = {};
  for (const title of titles) {
    try {
      const q = encodeURIComponent(`arid:${mbid} AND recording:"${title}"`);
      const data = await mbFetch(`/recording?query=${q}&fmt=json&limit=3`);
      const best = data.recordings?.[0];
      if (best && (best.score ?? 0) >= 88) {
        result[title.toLowerCase()] = best.title;
      }
    } catch { /* skip individual misses */ }
  }
  return result;
}

// Main entry: find a release and get its track titles as a pipeline-compatible map.
// Returns null if nothing found in MusicBrainz.
// Returns { release, trackTitles: { t1: "...", t2: "...", ... } } on success.
export async function matchUpload(band, date) {
  const release = await findRelease(band, date);
  if (!release) return null;

  console.log(`[musicbrainz] matched release: "${release.title}" (${release.mbid})`);

  const trackTitles = await getReleaseTrackList(release.mbid);
  const trackCount = Object.keys(trackTitles).length;

  return { release, trackTitles, trackCount };
}

// Enrich a set of known track titles with canonical MusicBrainz names.
// Titles should be a plain array of strings (the track titles to normalise).
// Returns updated array.
export async function normaliseTitles(band, titles) {
  const lookup = await lookupSongTitles(band, titles);
  return titles.map(t => lookup[t.toLowerCase()] || t);
}

export { ARTIST_MBIDS };
