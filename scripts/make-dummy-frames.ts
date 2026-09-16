/**
 * Generates synthetic frames so the whole pipeline can be exercised before any
 * real operative stills exist. Not used in production.
 *
 *   npm run make:dummy -- <out-dir> [count]
 */
import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';

function drawFrame(width: number, height: number, seed: number): Buffer {
  const png = new PNG({ width, height });
  const blobs = Array.from({ length: 5 }, (_, i) => ({
    cx: ((seed * 37 + i * 91) % 100) / 100 * width,
    cy: ((seed * 53 + i * 67) % 100) / 100 * height,
    r: (0.08 + (((seed * 13 + i * 29) % 100) / 100) * 0.16) * Math.min(width, height),
    tint: [((seed * 7 + i * 41) % 60) + 40, ((seed * 11 + i * 23) % 40) + 20, ((seed * 17 + i * 13) % 40) + 20],
  }));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      // Tissue-ish base: warm red-brown with a soft vignette.
      const nx = x / width - 0.5;
      const ny = y / height - 0.5;
      const vignette = 1 - Math.min(1, (nx * nx + ny * ny) * 1.6);
      let r = 150 * vignette + 40;
      let g = 70 * vignette + 25;
      let b = 65 * vignette + 25;
      for (const blob of blobs) {
        const d = Math.hypot(x - blob.cx, y - blob.cy);
        if (d < blob.r) {
          const w = 1 - d / blob.r;
          r += blob.tint[0] * w;
          g += blob.tint[1] * w;
          b += blob.tint[2] * w;
        }
      }
      const speckle = ((x * 31 + y * 17 + seed * 7) % 23) - 11;
      png.data[idx] = Math.max(0, Math.min(255, r + speckle));
      png.data[idx + 1] = Math.max(0, Math.min(255, g + speckle));
      png.data[idx + 2] = Math.max(0, Math.min(255, b + speckle));
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function main() {
  const outDir = path.resolve(process.argv[2] || './data/dummy-frames');
  const count = Number(process.argv[3] || 60);
  const practiceDir = path.join(outDir, 'practice');
  fs.mkdirSync(practiceDir, { recursive: true });

  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(path.join(practiceDir, `practice_${String(i).padStart(3, '0')}.png`), drawFrame(960, 540, 900 + i));
  }
  for (let i = 1; i <= count; i++) {
    const video = `case${String(((i - 1) % 4) + 1).padStart(2, '0')}`;
    const dir = path.join(outDir, video);
    fs.mkdirSync(dir, { recursive: true });
    // Mixed resolutions, to prove letterboxing and native-resolution masks.
    const [w, h] = i % 3 === 0 ? [1280, 720] : i % 3 === 1 ? [960, 540] : [1024, 768];
    fs.writeFileSync(path.join(dir, `frame_${String(i).padStart(4, '0')}.png`), drawFrame(w, h, i));
  }
  console.log(`Wrote 5 practice frames and ${count} frames to ${outDir}`);
}

main();
