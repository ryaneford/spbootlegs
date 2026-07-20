import { createCanvas, loadImage } from 'canvas';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BAND_IMAGES = {
  sp:   path.join(__dirname, '..', 'public', 'sp-heart.jpg'),
  zwan: path.join(__dirname, '..', 'public', 'zwan.jpg'),
  bc:   path.join(__dirname, '..', 'public', 'bc.jpg'),
};

const W = 600;
const H = 600;

const imageCache = {};

async function getBandImage(band) {
  const key = band || 'sp';
  if (imageCache[key]) return imageCache[key];
  const imgPath = BAND_IMAGES[key] || BAND_IMAGES.sp;
  imageCache[key] = await loadImage(imgPath);
  return imageCache[key];
}

async function generateCover(metadata, destDir) {
  const band = metadata.band || 'sp';
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // background
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, W, H);

  // warm glow
  const glow = ctx.createRadialGradient(W / 2, 240, 0, W / 2, 240, 320);
  glow.addColorStop(0, 'rgba(80, 50, 20, 0.12)');
  glow.addColorStop(0.6, 'rgba(40, 20, 10, 0.06)');
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // band image centered, fitted to top portion
  const img = await getBandImage(band);
  const imgMaxW = 340;
  const imgMaxH = 280;
  const imgAspect = img.width / img.height;
  let drawW, drawH;
  if (imgAspect > imgMaxW / imgMaxH) {
    drawW = imgMaxW;
    drawH = imgMaxW / imgAspect;
  } else {
    drawH = imgMaxH;
    drawW = imgMaxH * imgAspect;
  }
  const imgX = (W - drawW) / 2;
  const imgY = 60;
  ctx.drawImage(img, imgX, imgY, drawW, drawH);

  // faint horizontal lines below image
  ctx.strokeStyle = 'rgba(200, 170, 100, 0.06)';
  ctx.lineWidth = 0.5;
  for (let ly = 370; ly < H - 30; ly += 8) {
    ctx.beginPath();
    ctx.moveTo(40, ly);
    ctx.lineTo(W - 40, ly);
    ctx.stroke();
  }

  // text
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';

  let textY = 370;

  if (metadata.date) {
    ctx.fillStyle = '#e8d5b5';
    ctx.font = 'bold 52px sans-serif';
    ctx.fillText(metadata.date, W / 2, textY);
    textY += 64;
  }

  if (metadata.venue) {
    ctx.fillStyle = '#ccc';
    ctx.font = '26px sans-serif';
    textY = wrapTextCenter(ctx, metadata.venue, W / 2, textY, W - 120, 34);
    textY += 6;
  }

  const locParts = [metadata.city, metadata.state, metadata.country].filter(Boolean);
  if (locParts.length > 0) {
    ctx.fillStyle = '#888';
    ctx.font = '20px sans-serif';
    ctx.fillText(locParts.join(', '), W / 2, textY);
    textY += 28;
  }

  if (metadata.source) {
    ctx.fillStyle = 'rgba(200, 170, 100, 0.7)';
    ctx.font = 'bold 17px sans-serif';
    ctx.fillText(`[${metadata.source}]`, W / 2, H - 46);
  }

  // thin bottom line
  ctx.fillStyle = 'rgba(200, 170, 100, 0.2)';
  ctx.fillRect(80, H - 24, W - 160, 1);

  const buffer = canvas.toBuffer('image/png');
  const coverPath = path.join(destDir, 'folder.png');
  fs.writeFileSync(coverPath, buffer);
  return coverPath;
}

function wrapTextCenter(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  let currentY = y;

  for (const word of words) {
    const testLine = line + word + ' ';
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && line !== '') {
      ctx.fillText(line.trim(), x, currentY);
      line = word + ' ';
      currentY += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line.trim(), x, currentY);
  return currentY + lineHeight;
}

export { generateCover };
