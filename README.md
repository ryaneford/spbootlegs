# spbootlegs

A self-hosted web app that finds, downloads, renames, and tags live-show
bootleg recordings of **The Smashing Pumpkins, Zwan, and Billy Corgan solo**
shows from [archive.org](https://archive.org), using
[SPLRA](https://www.splra.org) (the Smashing Pumpkins Live Recording
Association) as its metadata/setlist source.

## What it does

1. **Paste a SPLRA or archive.org URL** — a release page, a tour page (lists
   all surfaced recordings), or a direct archive.org details page
2. **Pick a recording** — video sources/formats are automatically filtered
   out; the app checks torrent seeder count before letting you start
3. **Download** — via WebTorrent, with automatic fallback to direct HTTP
   from archive.org's CDN if a torrent stalls (common for old, sparsely
   seeded torrents)
4. **Automatic pipeline** — track titles resolved from `_files.xml` / NFO /
   SPLRA setlist, directory + files renamed to a consistent scheme, SHN
   converted to FLAC, non-audio/duplicate files filtered, tags written,
   cover art generated
5. **Transfer** — SCP the finished bootleg to a NAS/server over SSH, with
   post-transfer verification and remote FLAC tagging
6. **Navidrome integration** — shows recently-added albums from a Navidrome
   library and generates share links

## Prerequisites

- Docker + Docker Compose
- A NAS/server reachable over SSH, and/or a Navidrome instance (both
  optional — leave `SP_SSH_PASS`/`ND_PASS` unset to skip either)

## Quick start

```bash
git clone https://github.com/ryaneford/spbootlegs.git
cd spbootlegs
cp .env.example .env
# Edit .env — set SP_SSH_PASS / ND_PASS, and any hosts that differ from the defaults
docker compose up -d
```

Open `http://localhost:3999`.

The image is published at
[`ryaneford/spbootlegs`](https://hub.docker.com/r/ryaneford/spbootlegs) —
`docker compose up -d` pulls it directly, no build required. (A local build
takes several minutes due to native dependencies — `canvas` for cover art
generation and `webtorrent`'s native modules.)

`compose.yaml` also starts a
[FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) sidecar, which
SPLRA page fetches are routed through to get past Cloudflare.

```yaml
services:
  spbootlegs:
    image: ryaneford/spbootlegs:latest
    container_name: spbootlegs
    restart: unless-stopped
    ports:
      - '3999:3999'
    volumes:
      - ./downloads:/ten/streaming/downloads
      - ./cache:/ten/streaming/cache
    environment:
      - PORT=3999
      # SSH-transfer finished bootlegs to a NAS/server (leave SP_SSH_PASS unset to skip)
      - SP_SSH_HOST=${SP_SSH_HOST:-192.168.0.101}
      - SP_SSH_USER=${SP_SSH_USER:-admin}
      - SP_SSH_PASS=${SP_SSH_PASS:-}
      - SP_SSH_REMOTE_DIR=${SP_SSH_REMOTE_DIR:-/ten/streaming/downloads}
      # Recently-added widget + share links from a Navidrome instance (leave ND_PASS unset to skip)
      - ND_BASE=${ND_BASE:-https://pumpkins.buis2.net/rest}
      - ND_USER=${ND_USER:-admin}
      - ND_PASS=${ND_PASS:-}
      # Identifies requests to the MusicBrainz API per their usage policy
      - CONTACT_EMAIL=${CONTACT_EMAIL:-}
      - FLARESOLVERR_URL=http://flaresolverr:8191/v1
    dns:
      - 8.8.8.8
      - 8.8.4.4

  flaresolverr:
    image: ghcr.io/flaresolverr/flaresolverr:latest
    container_name: flaresolverr
    restart: unless-stopped
    tmpfs:
      - /tmp:size=2g
    environment:
      - LOG_LEVEL=info
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3999` | HTTP port to listen on. |
| `SP_SSH_HOST` | `192.168.0.101` | NAS/server hostname for SCP transfer. |
| `SP_SSH_USER` | `admin` | SSH username for transfer. |
| `SP_SSH_PASS` | *(required)* | SSH password for transfer. |
| `SP_SSH_REMOTE_DIR` | `/ten/streaming/downloads` | Remote directory bootlegs are copied into. |
| `ND_BASE` | `https://pumpkins.buis2.net/rest` | Navidrome Subsonic API base URL, including `/rest`. |
| `ND_USER` | `admin` | Navidrome admin username. |
| `ND_PASS` | *(required)* | Navidrome admin password. |
| `CONTACT_EMAIL` | *(unset)* | Included in the User-Agent sent to the MusicBrainz API, per [their usage policy](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting). Optional but polite. |
| `FLARESOLVERR_URL` | `http://flaresolverr:8191/v1` | FlareSolverr endpoint, matches the sidecar service name in `compose.yaml`. |

Downloads are staged in `/ten/streaming/downloads` and raw cache in
`/ten/streaming/cache` inside the container — mount these as volumes to
persist across restarts (already done in `compose.yaml`).

## Bands

| Code | Band | Detected from |
|---|---|---|
| `sp` | The Smashing Pumpkins | default |
| `zwan` | Zwan | `zwan` archive.org identifier prefix |
| `bc` | Billy Corgan (solo) | `bc` archive.org identifier prefix |

## Security notes

`SP_SSH_PASS` and `ND_PASS` are secrets — set them in `.env`, which is
gitignored, never commit them. Don't expose this container directly to the
internet; it has no authentication of its own.

## License

MIT
