'use client';

/**
 * Standalone harness for the drawing surface. No database, no session, no
 * queue: just the canvas, so it can be opened on an iPad and hammered on
 * before anything else depends on it.
 *
 *   npm run dev  ->  http://localhost:3000/canvas-lab
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AnnotationCanvas, { type AnnotationCanvasHandle } from '@/components/AnnotationCanvas';
import Toolbar from '@/components/Toolbar';
import { DEFAULT_BRUSH, type Layer, type Tool } from '@/lib/types';

const NATIVE_WIDTH = 1280;
const NATIVE_HEIGHT = 720;

/** A synthetic tissue-like frame, so the harness needs no seeded data. */
function makeTestFrame(width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const gradient = ctx.createRadialGradient(width * 0.45, height * 0.4, 40, width * 0.5, height * 0.5, width * 0.8);
  gradient.addColorStop(0, '#b8544a');
  gradient.addColorStop(0.55, '#8d3f39');
  gradient.addColorStop(1, '#40201f');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  for (let i = 0; i < 26; i++) {
    ctx.beginPath();
    const cx = (Math.sin(i * 12.9898) * 0.5 + 0.5) * width;
    const cy = (Math.sin(i * 78.233) * 0.5 + 0.5) * height;
    const r = 30 + ((i * 37) % 90);
    ctx.fillStyle = `rgba(${200 - (i % 5) * 18}, ${120 + (i % 7) * 9}, ${105 + (i % 4) * 12}, 0.25)`;
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // A fine grid, to make it obvious if strokes land off by a scale factor.
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += 80) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += 80) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '20px system-ui, sans-serif';
  ctx.fillText(`test frame · native ${width} × ${height}`, 24, 40);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, width - 3, height - 3);

  return canvas.toDataURL('image/png');
}

export default function CanvasLabPage() {
  const canvasRef = useRef<AnnotationCanvasHandle>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [layer, setLayer] = useState<Layer>('nogo');
  const [tool, setTool] = useState<Tool>('lasso');
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH);
  const [canUndo, setCanUndo] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const [exported, setExported] = useState<string | null>(null);
  const [pointerInfo, setPointerInfo] = useState('—');

  useEffect(() => {
    setFrameUrl(makeTestFrame(NATIVE_WIDTH, NATIVE_HEIGHT));
  }, []);

  useEffect(() => {
    const report = (event: PointerEvent) => {
      setPointerInfo(
        `${event.pointerType}` +
          (event.pressure ? ` · pressure ${event.pressure.toFixed(2)}` : '') +
          ` · ${Math.round(event.clientX)},${Math.round(event.clientY)}`,
      );
    };
    window.addEventListener('pointerdown', report);
    window.addEventListener('pointermove', report);
    return () => {
      window.removeEventListener('pointerdown', report);
      window.removeEventListener('pointermove', report);
    };
  }, []);

  const handleUndo = useCallback(() => canvasRef.current?.undo(), []);
  const handleClear = useCallback(() => {
    canvasRef.current?.clear();
    setExported(null);
  }, []);

  // Same key map as the real annotation screen.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'g') setLayer('go');
      else if (key === 'n') setLayer('nogo');
      else if (key === 'l') setTool('lasso');
      else if (key === 'b') setTool('brush');
      else if (key === 'e') setTool('eraser');
      else if (key === 'u') handleUndo();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleUndo]);

  const exportBoth = useCallback(async () => {
    const go = await canvasRef.current?.exportLayer('go');
    const nogo = await canvasRef.current?.exportLayer('nogo');
    const describe = async (blob: Blob | null | undefined, name: string) => {
      if (!blob) return `${name}: empty`;
      const bitmap = await createImageBitmap(blob);
      const probe = document.createElement('canvas');
      probe.width = bitmap.width;
      probe.height = bitmap.height;
      const ctx = probe.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      let painted = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 127) painted++;
      return `${name}: ${bitmap.width}×${bitmap.height}, ${painted.toLocaleString()} px painted, ${(
        blob.size / 1024
      ).toFixed(1)} KB`;
    };
    setExported([await describe(go, 'go'), await describe(nogo, 'nogo')].join('\n'));
  }, []);

  const info = useMemo(
    () => [
      `native ${NATIVE_WIDTH} × ${NATIVE_HEIGHT}`,
      `layer ${layer} · tool ${tool}${tool === 'lasso' ? '' : ` · ${brushSize}px`}`,
      `content ${hasContent ? 'yes' : 'no'} · undos ${undoCount}`,
      `pointer ${pointerInfo}`,
    ],
    [layer, tool, brushSize, hasContent, undoCount, pointerInfo],
  );

  return (
    <main className="viewport-fill flex flex-col bg-zinc-950">
      <Toolbar
        layer={layer}
        tool={tool}
        brushSize={brushSize}
        canUndo={canUndo}
        onLayerChange={setLayer}
        onToolChange={setTool}
        onBrushSizeChange={setBrushSize}
        onUndo={handleUndo}
        onClear={handleClear}
      />

      <div className="relative min-h-0 flex-1 bg-black">
        {frameUrl && (
          <AnnotationCanvas
            ref={canvasRef}
            frameUrl={frameUrl}
            nativeWidth={NATIVE_WIDTH}
            nativeHeight={NATIVE_HEIGHT}
            layer={layer}
            tool={tool}
            brushSize={brushSize}
            onContentChange={setHasContent}
            onUndoAvailable={setCanUndo}
            onUndoUsed={() => setUndoCount((n) => n + 1)}
          />
        )}
        <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-black/70 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-300">
          {info.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      </div>

      <div className="shrink-0 border-t border-zinc-800 bg-zinc-950 px-3 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={exportBoth}
            className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-zinc-900"
          >
            Export both layers
          </button>
          <span className="text-xs text-zinc-500">
            Keys: G / N class · L / B / E tools · U undo. Both layers export at native resolution.
          </span>
        </div>
        {exported && (
          <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-zinc-400">{exported}</pre>
        )}
      </div>
    </main>
  );
}
