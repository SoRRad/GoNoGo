'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { LAYER_COLORS, MASK_OPACITY, type Layer, type Tool } from '@/lib/types';

interface Point {
  x: number;
  y: number;
}

/**
 * A committed stroke, in the frame's native pixel coordinates.
 *
 * Strokes are kept as commands rather than as pixel snapshots: undo replays the
 * affected layer from its base, which costs a few milliseconds and a few
 * hundred bytes instead of an 8 MB ImageData per step.
 */
interface Stroke {
  layer: Layer;
  tool: Tool;
  size: number;
  points: Point[];
}

/**
 * Clear is a command rather than a reset, so undo brings the frame back. On an
 * iPad a mis-tap on Clear would otherwise destroy minutes of work with no way
 * back. Replay starts from the most recent clear, ignoring the base under it.
 */
type Command = { kind: 'stroke'; stroke: Stroke } | { kind: 'clear' };

export interface AnnotationCanvasHandle {
  undo: () => void;
  clear: () => void;
  /** PNG blob of one layer at native resolution, or null when that layer is empty. */
  exportLayer: (layer: Layer) => Promise<Blob | null>;
  hasContent: (layer: Layer) => boolean;
  hasAnyContent: () => boolean;
}

interface Props {
  frameUrl: string;
  nativeWidth: number;
  nativeHeight: number;
  layer: Layer;
  tool: Tool;
  brushSize: number;
  goMaskUrl?: string | null;
  nogoMaskUrl?: string | null;
  onContentChange?: (hasContent: boolean) => void;
  /** Fires only for edits the surgeon made: a committed stroke, an undo, a clear. */
  onEdit?: () => void;
  onUndoAvailable?: (canUndo: boolean) => void;
  onUndoUsed?: () => void;
  onReady?: () => void;
}

const MAX_DPR = 2;
/** Points closer than this in native pixels are dropped as jitter. */
const MIN_POINT_DISTANCE = 1.5;
/** Emptiness is judged on a downscale; a full-resolution alpha scan is too slow to run per stroke. */
const OCCUPANCY_PROBE = 128;

function createLayerCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Paints one stroke into a layer's native-resolution context. */
function paintStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  const { points } = stroke;
  if (points.length === 0) return;

  ctx.save();
  if (stroke.tool === 'eraser') {
    // Erasing only ever touches the layer it is applied to, never the other class.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.fillStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = LAYER_COLORS[stroke.layer];
    ctx.fillStyle = LAYER_COLORS[stroke.layer];
  }

  if (stroke.tool === 'lasso') {
    if (points.length < 3) {
      ctx.restore();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    // A rough loop closes itself; the surgeon never has to land back on the start.
    ctx.closePath();
    ctx.fill('nonzero');
    ctx.restore();
    return;
  }

  ctx.lineWidth = stroke.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, stroke.size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // Quadratic segments through midpoints: smooth under a fast pencil stroke.
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
  }
  ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
  ctx.stroke();
  ctx.restore();
}

const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, Props>(function AnnotationCanvas(
  {
    frameUrl,
    nativeWidth,
    nativeHeight,
    layer,
    tool,
    brushSize,
    goMaskUrl,
    nogoMaskUrl,
    onContentChange,
    onEdit,
    onUndoAvailable,
    onUndoUsed,
    onReady,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const displayRef = useRef<HTMLCanvasElement | null>(null);

  const imageRef = useRef<HTMLImageElement | null>(null);
  const layerCanvases = useRef<Record<Layer, HTMLCanvasElement> | null>(null);
  /** Resumed work: strokes replay on top of this, so undo cannot erase it. */
  const baseCanvases = useRef<Record<Layer, HTMLCanvasElement | null>>({ go: null, nogo: null });
  const historyRef = useRef<Command[]>([]);

  const activePointerRef = useRef<number | null>(null);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const lassoPreviewRef = useRef<Point[] | null>(null);
  /** Once a pencil touches the glass, the palm resting on it is ignored. */
  const penSeenRef = useRef(false);
  const frameRequestRef = useRef<number | null>(null);
  const hasContentRef = useRef<Record<Layer, boolean>>({ go: false, nogo: false });

  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });
  const [loaded, setLoaded] = useState(false);

  const layerRef = useRef(layer);
  const toolRef = useRef(tool);
  const brushRef = useRef(brushSize);
  layerRef.current = layer;
  toolRef.current = tool;
  brushRef.current = brushSize;

  // ---------------------------------------------------------------- rendering

  const draw = useCallback(() => {
    frameRequestRef.current = null;
    const canvas = displayRef.current;
    const image = imageRef.current;
    const layers = layerCanvases.current;
    if (!canvas || !image || !layers) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cssWidth = canvas.width / (canvas.dataset.dpr ? Number(canvas.dataset.dpr) : 1);
    const cssHeight = canvas.height / (canvas.dataset.dpr ? Number(canvas.dataset.dpr) : 1);

    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.drawImage(image, 0, 0, cssWidth, cssHeight);

    // Fixed order: what the surgeon sees never shifts when they switch class.
    ctx.globalAlpha = MASK_OPACITY;
    ctx.drawImage(layers.go, 0, 0, cssWidth, cssHeight);
    ctx.drawImage(layers.nogo, 0, 0, cssWidth, cssHeight);
    ctx.globalAlpha = 1;

    const preview = lassoPreviewRef.current;
    if (preview && preview.length > 1) {
      const scaleX = cssWidth / nativeWidth;
      const scaleY = cssHeight / nativeHeight;
      ctx.save();
      ctx.strokeStyle = LAYER_COLORS[layerRef.current];
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(preview[0].x * scaleX, preview[0].y * scaleY);
      for (let i = 1; i < preview.length; i++) {
        ctx.lineTo(preview[i].x * scaleX, preview[i].y * scaleY);
      }
      ctx.stroke();
      // The closing edge is dashed, so the loop reads as not-yet-committed.
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(preview[preview.length - 1].x * scaleX, preview[preview.length - 1].y * scaleY);
      ctx.lineTo(preview[0].x * scaleX, preview[0].y * scaleY);
      ctx.stroke();
      ctx.restore();
    }
  }, [nativeWidth, nativeHeight]);

  const scheduleDraw = useCallback(() => {
    if (frameRequestRef.current !== null) return;
    frameRequestRef.current = requestAnimationFrame(draw);
  }, [draw]);

  // ------------------------------------------------------------- layer state

  const refreshContent = useCallback(
    (which: Layer) => {
      const layers = layerCanvases.current;
      if (!layers) return;
      const probe = createLayerCanvas(OCCUPANCY_PROBE, OCCUPANCY_PROBE);
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(layers[which], 0, 0, OCCUPANCY_PROBE, OCCUPANCY_PROBE);
      const { data } = ctx.getImageData(0, 0, OCCUPANCY_PROBE, OCCUPANCY_PROBE);
      let found = false;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) {
          found = true;
          break;
        }
      }
      hasContentRef.current[which] = found;
      onContentChange?.(hasContentRef.current.go || hasContentRef.current.nogo);
    },
    [onContentChange],
  );

  const replayLayer = useCallback(
    (which: Layer) => {
      const layers = layerCanvases.current;
      if (!layers) return;
      const ctx = layers[which].getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, nativeWidth, nativeHeight);

      const history = historyRef.current;
      let lastClear = -1;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].kind === 'clear') {
          lastClear = i;
          break;
        }
      }

      // Anything saved in an earlier sitting sits below the strokes, unless a
      // clear has since wiped it.
      const base = baseCanvases.current[which];
      if (lastClear === -1 && base) ctx.drawImage(base, 0, 0);

      for (let i = lastClear + 1; i < history.length; i++) {
        const command = history[i];
        if (command.kind === 'stroke' && command.stroke.layer === which) paintStroke(ctx, command.stroke);
      }
      refreshContent(which);
      scheduleDraw();
    },
    [nativeWidth, nativeHeight, refreshContent, scheduleDraw],
  );

  // --------------------------------------------------------------- lifecycle

  // Frame and any previously saved masks. Re-runs when the frame changes.
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    historyRef.current = [];
    lassoPreviewRef.current = null;
    currentStrokeRef.current = null;
    activePointerRef.current = null;
    hasContentRef.current = { go: false, nogo: false };
    baseCanvases.current = { go: null, nogo: null };
    layerCanvases.current = {
      go: createLayerCanvas(nativeWidth, nativeHeight),
      nogo: createLayerCanvas(nativeWidth, nativeHeight),
    };
    onUndoAvailable?.(false);

    /**
     * A saved mask is white-on-black at native resolution. It is recoloured to
     * the layer colour with transparency so it composites exactly like fresh work.
     */
    const loadMask = (url: string, which: Layer) =>
      new Promise<void>((resolve) => {
        const maskImage = new Image();
        maskImage.onload = () => {
          if (cancelled) return resolve();
          const scratch = createLayerCanvas(nativeWidth, nativeHeight);
          const scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
          if (!scratchCtx) return resolve();
          scratchCtx.drawImage(maskImage, 0, 0, nativeWidth, nativeHeight);
          const imageData = scratchCtx.getImageData(0, 0, nativeWidth, nativeHeight);
          const colour = LAYER_COLORS[which];
          const r = parseInt(colour.slice(1, 3), 16);
          const g = parseInt(colour.slice(3, 5), 16);
          const b = parseInt(colour.slice(5, 7), 16);
          const pixels = imageData.data;
          for (let i = 0; i < pixels.length; i += 4) {
            const on = pixels[i] > 127 && pixels[i + 3] > 0;
            pixels[i] = r;
            pixels[i + 1] = g;
            pixels[i + 2] = b;
            pixels[i + 3] = on ? 255 : 0;
          }
          scratchCtx.putImageData(imageData, 0, 0);
          baseCanvases.current[which] = scratch;
          const layers = layerCanvases.current;
          if (layers) {
            const ctx = layers[which].getContext('2d');
            ctx?.drawImage(scratch, 0, 0);
          }
          resolve();
        };
        maskImage.onerror = () => resolve();
        maskImage.src = url;
      });

    const image = new Image();
    image.decoding = 'async';
    image.onload = async () => {
      if (cancelled) return;
      imageRef.current = image;
      const pending: Promise<void>[] = [];
      if (goMaskUrl) pending.push(loadMask(goMaskUrl, 'go'));
      if (nogoMaskUrl) pending.push(loadMask(nogoMaskUrl, 'nogo'));
      await Promise.all(pending);
      if (cancelled) return;
      refreshContent('go');
      refreshContent('nogo');
      setLoaded(true);
      scheduleDraw();
      onReady?.();
    };
    image.src = frameUrl;

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameUrl, nativeWidth, nativeHeight, goMaskUrl, nogoMaskUrl]);

  // Letterbox: fit the native aspect ratio inside the available box, never crop.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const { width, height } = container.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      const scale = Math.min(width / nativeWidth, height / nativeHeight);
      setDisplaySize({
        width: Math.max(1, Math.floor(nativeWidth * scale)),
        height: Math.max(1, Math.floor(nativeHeight * scale)),
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    window.addEventListener('orientationchange', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('orientationchange', measure);
    };
  }, [nativeWidth, nativeHeight]);

  // Backing store follows the device pixel ratio so strokes are not soft.
  useLayoutEffect(() => {
    const canvas = displayRef.current;
    if (!canvas || displaySize.width === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    canvas.width = Math.round(displaySize.width * dpr);
    canvas.height = Math.round(displaySize.height * dpr);
    canvas.dataset.dpr = String(dpr);
    canvas.style.width = `${displaySize.width}px`;
    canvas.style.height = `${displaySize.height}px`;
    const ctx = canvas.getContext('2d');
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    scheduleDraw();
  }, [displaySize, scheduleDraw]);

  // iOS still pinch-zooms a page that asked it not to; the gesture events are
  // the only reliable way to refuse while a drawing surface is on screen.
  useEffect(() => {
    const blockGesture = (event: Event) => event.preventDefault();
    document.addEventListener('gesturestart', blockGesture);
    document.addEventListener('gesturechange', blockGesture);
    document.addEventListener('gestureend', blockGesture);
    return () => {
      document.removeEventListener('gesturestart', blockGesture);
      document.removeEventListener('gesturechange', blockGesture);
      document.removeEventListener('gestureend', blockGesture);
    };
  }, []);

  // touch-action alone does not stop Safari scroll-chaining mid-stroke.
  useEffect(() => {
    const canvas = displayRef.current;
    if (!canvas) return;
    const swallow = (event: TouchEvent) => event.preventDefault();
    canvas.addEventListener('touchstart', swallow, { passive: false });
    canvas.addEventListener('touchmove', swallow, { passive: false });
    canvas.addEventListener('touchend', swallow, { passive: false });
    return () => {
      canvas.removeEventListener('touchstart', swallow);
      canvas.removeEventListener('touchmove', swallow);
      canvas.removeEventListener('touchend', swallow);
    };
  }, [loaded]);

  useEffect(
    () => () => {
      if (frameRequestRef.current !== null) cancelAnimationFrame(frameRequestRef.current);
    },
    [],
  );

  // ------------------------------------------------------------------- input

  const toNative = useCallback(
    (clientX: number, clientY: number): Point => {
      const canvas = displayRef.current!;
      const rect = canvas.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * nativeWidth;
      const y = ((clientY - rect.top) / rect.height) * nativeHeight;
      return {
        x: Math.max(0, Math.min(nativeWidth, x)),
        y: Math.max(0, Math.min(nativeHeight, y)),
      };
    },
    [nativeWidth, nativeHeight],
  );

  const shouldIgnore = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'pen') {
      penSeenRef.current = true;
      return false;
    }
    // Palm rejection: after a pencil has been used, touch stops drawing.
    if (event.pointerType === 'touch' && penSeenRef.current) return true;
    // Right button / eraser end of a stylus should not paint.
    if (event.pointerType === 'mouse' && event.buttons > 1) return true;
    return false;
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!loaded) return;
      if (activePointerRef.current !== null) return; // one pointer at a time
      if (shouldIgnore(event)) return;
      event.preventDefault();

      activePointerRef.current = event.pointerId;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* capture is best effort */
      }

      const point = toNative(event.clientX, event.clientY);
      const stroke: Stroke = {
        layer: layerRef.current,
        tool: toolRef.current,
        size: brushRef.current,
        points: [point],
      };
      currentStrokeRef.current = stroke;

      if (stroke.tool === 'lasso') {
        lassoPreviewRef.current = [point];
      } else {
        const layers = layerCanvases.current;
        const ctx = layers?.[stroke.layer].getContext('2d');
        if (ctx) paintStroke(ctx, stroke);
      }
      scheduleDraw();
    },
    [loaded, shouldIgnore, toNative, scheduleDraw],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (activePointerRef.current !== event.pointerId) return;
      const stroke = currentStrokeRef.current;
      if (!stroke) return;
      event.preventDefault();

      // Coalesced events carry every sample the pencil produced between frames.
      const native = event.nativeEvent;
      const samples =
        typeof native.getCoalescedEvents === 'function' && native.getCoalescedEvents().length > 0
          ? native.getCoalescedEvents()
          : [native];

      let added = false;
      for (const sample of samples) {
        const point = toNative(sample.clientX, sample.clientY);
        const last = stroke.points[stroke.points.length - 1];
        if (Math.hypot(point.x - last.x, point.y - last.y) < MIN_POINT_DISTANCE) continue;
        stroke.points.push(point);
        added = true;
      }
      if (!added) return;

      if (stroke.tool === 'lasso') {
        lassoPreviewRef.current = stroke.points;
      } else {
        // Paint the new tail only; the whole stroke is replayed on commit.
        const layers = layerCanvases.current;
        const ctx = layers?.[stroke.layer].getContext('2d');
        if (ctx) {
          const tail = stroke.points.slice(Math.max(0, stroke.points.length - 3));
          paintStroke(ctx, { ...stroke, points: tail });
        }
      }
      scheduleDraw();
    },
    [toNative, scheduleDraw],
  );

  const finishStroke = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
      if (activePointerRef.current !== event.pointerId) return;
      activePointerRef.current = null;
      const stroke = currentStrokeRef.current;
      currentStrokeRef.current = null;
      lassoPreviewRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      if (!stroke) return;

      if (cancelled || (stroke.tool === 'lasso' && stroke.points.length < 3)) {
        // Nothing committed: repaint from history to drop any live preview.
        replayLayer(stroke.layer);
        return;
      }

      historyRef.current.push({ kind: 'stroke', stroke });
      onEdit?.();
      // Replaying makes the committed pixels identical to what undo would redraw.
      replayLayer(stroke.layer);
      onUndoAvailable?.(historyRef.current.length > 0);
    },
    [replayLayer, onUndoAvailable, onEdit],
  );

  // ------------------------------------------------------------- public API

  useImperativeHandle(
    ref,
    () => ({
      undo() {
        const history = historyRef.current;
        if (history.length === 0) return;
        const removed = history.pop()!;
        if (removed.kind === 'clear') {
          // Undoing a clear brings both layers, and the saved base, back.
          replayLayer('go');
          replayLayer('nogo');
        } else {
          replayLayer(removed.stroke.layer);
        }
        onUndoAvailable?.(history.length > 0);
        onUndoUsed?.();
        onEdit?.();
      },
      clear() {
        historyRef.current.push({ kind: 'clear' });
        replayLayer('go');
        replayLayer('nogo');
        onUndoAvailable?.(true);
        onEdit?.();
      },
      hasContent(which: Layer) {
        return hasContentRef.current[which];
      },
      hasAnyContent() {
        return hasContentRef.current.go || hasContentRef.current.nogo;
      },
      exportLayer(which: Layer) {
        return new Promise<Blob | null>((resolve) => {
          const layers = layerCanvases.current;
          if (!layers || !hasContentRef.current[which]) return resolve(null);
          layers[which].toBlob((blob) => resolve(blob), 'image/png');
        });
      },
    }),
    [replayLayer, onUndoAvailable, onUndoUsed, onEdit],
  );

  return (
    <div ref={containerRef} className="flex h-full w-full items-center justify-center overflow-hidden">
      <canvas
        ref={displayRef}
        className="drawing-surface touch-none select-none"
        style={{ width: displaySize.width, height: displaySize.height, opacity: loaded ? 1 : 0 }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishStroke(event, false)}
        onPointerCancel={(event) => finishStroke(event, true)}
        onContextMenu={(event) => event.preventDefault()}
      />
    </div>
  );
});

export default AnnotationCanvas;
