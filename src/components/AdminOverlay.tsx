'use client';

import { useEffect, useRef, useState } from 'react';
import { LAYER_COLORS, type Layer } from '@/lib/types';

export interface OverlayRater {
  surgeonId: number;
  surgeonName: string;
  status: string;
  goPixels: number;
  nogoPixels: number;
}

interface Props {
  frameId: number;
  width: number;
  height: number;
  raters: OverlayRater[];
}

/**
 * Every surgeon's zones stacked on one frame. Each surgeon contributes the same
 * low opacity, so the brightness of a region is a direct read of how many of
 * them included it.
 */
export default function AdminOverlay({ frameId, width, height, raters }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState<Record<number, boolean>>(
    Object.fromEntries(raters.map((rater) => [rater.surgeonId, true])),
  );
  const [layers, setLayers] = useState<Record<Layer, boolean>>({ go: true, nogo: true });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const load = (src: string) =>
      new Promise<HTMLImageElement | null>((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = src;
      });

    /** Recolours a white-on-black mask into a tinted transparent overlay. */
    const tint = (image: HTMLImageElement, colour: string): HTMLCanvasElement => {
      const scratch = document.createElement('canvas');
      scratch.width = width;
      scratch.height = height;
      const scratchCtx = scratch.getContext('2d', { willReadFrequently: true })!;
      scratchCtx.drawImage(image, 0, 0, width, height);
      const data = scratchCtx.getImageData(0, 0, width, height);
      const r = parseInt(colour.slice(1, 3), 16);
      const g = parseInt(colour.slice(3, 5), 16);
      const b = parseInt(colour.slice(5, 7), 16);
      for (let i = 0; i < data.data.length; i += 4) {
        const on = data.data[i] > 127;
        data.data[i] = r;
        data.data[i + 1] = g;
        data.data[i + 2] = b;
        data.data[i + 3] = on ? 255 : 0;
      }
      scratchCtx.putImageData(data, 0, 0);
      return scratch;
    };

    (async () => {
      setLoading(true);
      const frame = await load(`/api/frames/${frameId}`);
      if (cancelled) return;

      ctx.clearRect(0, 0, width, height);
      if (frame) ctx.drawImage(frame, 0, 0, width, height);
      else {
        ctx.fillStyle = '#18181b';
        ctx.fillRect(0, 0, width, height);
      }

      const shown = raters.filter((rater) => visible[rater.surgeonId]);
      // Equal weight each, so overlap reads as accumulated agreement.
      const perRater = shown.length > 0 ? Math.min(0.45, 1 / shown.length + 0.1) : 0;

      for (const layer of ['go', 'nogo'] as Layer[]) {
        if (!layers[layer]) continue;
        for (const rater of shown) {
          const pixels = layer === 'go' ? rater.goPixels : rater.nogoPixels;
          if (pixels === 0) continue;
          const image = await load(`/api/admin/masks/${frameId}/${rater.surgeonId}/${layer}`);
          if (cancelled) return;
          if (!image) continue;
          ctx.globalAlpha = perRater;
          ctx.drawImage(tint(image, LAYER_COLORS[layer]), 0, 0);
          ctx.globalAlpha = 1;
        }
      }
      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [frameId, width, height, raters, visible, layers]);

  return (
    <div>
      <div className="relative overflow-hidden rounded-lg border border-zinc-800 bg-black">
        <canvas ref={canvasRef} className="block h-auto w-full" />
        {loading && (
          <div className="absolute right-2 top-2 rounded bg-black/70 px-2 py-1 text-xs text-zinc-400">
            compositing…
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {(['nogo', 'go'] as Layer[]).map((layer) => (
          <button
            key={layer}
            type="button"
            onClick={() => setLayers((current) => ({ ...current, [layer]: !current[layer] }))}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              layers[layer]
                ? 'border-zinc-600 bg-zinc-800 text-zinc-100'
                : 'border-zinc-800 text-zinc-600'
            }`}
          >
            <span
              className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle"
              style={{ background: LAYER_COLORS[layer] }}
            />
            {layer === 'go' ? 'Go' : 'No-Go'}
          </button>
        ))}

        <span className="mx-1 h-5 w-px bg-zinc-800" />

        {raters.map((rater) => (
          <button
            key={rater.surgeonId}
            type="button"
            onClick={() =>
              setVisible((current) => ({ ...current, [rater.surgeonId]: !current[rater.surgeonId] }))
            }
            className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
              visible[rater.surgeonId]
                ? 'border-zinc-600 bg-zinc-800 text-zinc-100'
                : 'border-zinc-800 text-zinc-600'
            }`}
            title={rater.status === 'nothing_to_mark' ? 'Marked nothing on this frame' : undefined}
          >
            {rater.surgeonName}
            {rater.status === 'nothing_to_mark' && ' · empty'}
          </button>
        ))}
      </div>
    </div>
  );
}
