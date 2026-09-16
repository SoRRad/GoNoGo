'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AnnotationCanvas, { type AnnotationCanvasHandle } from './AnnotationCanvas';
import Toolbar from './Toolbar';
import ActionBar from './ActionBar';
import {
  DEFAULT_BRUSH,
  type AnnotationStatus,
  type Confidence,
  type Layer,
  type QueueItemPayload,
  type Tool,
} from '@/lib/types';

interface QueueState {
  total: number;
  currentIndex: number;
  completed: number;
  practiceTotal: number;
  finished: boolean;
}

interface QueueWindow {
  state: QueueState;
  items: QueueItemPayload[];
}

const AUTOSAVE_MS = 5000;

/**
 * Wall-clock time on a frame, paused whenever the tab is not in front. The
 * surgeon never sees it.
 */
class FrameTimer {
  private accumulatedMs = 0;
  private runningSince: number | null = null;

  reset(seedSeconds: number) {
    this.accumulatedMs = Math.max(0, seedSeconds) * 1000;
    this.runningSince = null;
  }

  start() {
    if (this.runningSince === null) this.runningSince = Date.now();
  }

  pause() {
    if (this.runningSince !== null) {
      this.accumulatedMs += Date.now() - this.runningSince;
      this.runningSince = null;
    }
  }

  seconds(): number {
    const live = this.runningSince === null ? 0 : Date.now() - this.runningSince;
    return Math.round((this.accumulatedMs + live) / 1000);
  }
}

export default function Annotator({ initial }: { initial: QueueWindow }) {
  const canvasRef = useRef<AnnotationCanvasHandle>(null);
  const timerRef = useRef(new FrameTimer());

  const [queue, setQueue] = useState<QueueWindow>(initial);
  const [activeIndex, setActiveIndex] = useState(initial.state.currentIndex);
  /** Where to return to after stepping back one frame to fix something. */
  const [returnIndex, setReturnIndex] = useState<number | null>(null);

  const [layer, setLayer] = useState<Layer>('nogo');
  const [tool, setTool] = useState<Tool>('lasso');
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH);

  const [confidence, setConfidence] = useState<Confidence | null>(null);
  const [hasContent, setHasContent] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const undoCountRef = useRef(0);
  const dirtyRef = useRef(false);
  const busyRef = useRef(false);
  busyRef.current = busy;

  const item = useMemo(
    () => queue.items.find((candidate) => candidate.index === activeIndex) ?? null,
    [queue.items, activeIndex],
  );
  const itemRef = useRef<QueueItemPayload | null>(item);
  itemRef.current = item;

  // ------------------------------------------------------------ frame change

  useEffect(() => {
    if (!item) return;
    setConfidence(item.confidence);
    setHasContent(Boolean(item.goMaskUrl || item.nogoMaskUrl));
    setCanUndo(false);
    undoCountRef.current = item.undoCount;
    dirtyRef.current = false;
    timerRef.current.reset(item.secondsSpent);
    // The clock starts when the frame is on screen, not when it was requested.
    timerRef.current.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.assignmentId]);

  // Keep the next few frames warm so advancing never shows a spinner.
  useEffect(() => {
    for (const candidate of queue.items) {
      if (candidate.index <= activeIndex) continue;
      const preloaded = new Image();
      preloaded.decoding = 'async';
      preloaded.src = candidate.frameUrl;
    }
  }, [queue.items, activeIndex]);

  // ------------------------------------------------------------------ saving

  const buildForm = useCallback(
    async (options: { submit: boolean; status: AnnotationStatus | null; includeMasks: boolean }) => {
      const current = itemRef.current;
      if (!current) return null;
      const form = new FormData();
      form.set('assignmentId', String(current.assignmentId));
      form.set('secondsSpent', String(timerRef.current.seconds()));
      form.set('undoCount', String(undoCountRef.current));
      form.set('submit', options.submit ? '1' : '0');
      if (options.status) form.set('status', options.status);
      if (confidence) form.set('confidence', confidence);

      if (options.includeMasks) {
        const [go, nogo] = await Promise.all([
          canvasRef.current?.exportLayer('go') ?? Promise.resolve(null),
          canvasRef.current?.exportLayer('nogo') ?? Promise.resolve(null),
        ]);
        if (go) form.set('go', go, 'go.png');
        if (nogo) form.set('nogo', nogo, 'nogo.png');
      }
      return form;
    },
    [confidence],
  );

  const autosave = useCallback(async () => {
    if (busyRef.current || !dirtyRef.current || !itemRef.current) return;
    // Nothing drawn, nothing chosen, nothing stored before: no row to create.
    const canvas = canvasRef.current;
    const blank = !confidence && !canvas?.hasAnyContent() && !itemRef.current.status;
    if (blank) {
      dirtyRef.current = false;
      return;
    }
    const form = await buildForm({ submit: false, status: null, includeMasks: true });
    if (!form) return;
    dirtyRef.current = false;
    try {
      const response = await fetch('/api/annotations', { method: 'POST', body: form });
      if (!response.ok) throw new Error(String(response.status));
      setSaveError(null);
    } catch {
      // Put the work back on the queue so the next tick tries again.
      dirtyRef.current = true;
      setSaveError('Not saved yet — retrying.');
    }
  }, [buildForm, confidence]);

  useEffect(() => {
    const interval = setInterval(() => {
      void autosave();
    }, AUTOSAVE_MS);
    return () => clearInterval(interval);
  }, [autosave]);

  // Tab blur: stop the clock and flush, so closing the tab loses nothing.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        timerRef.current.pause();
        void autosave();
      } else {
        timerRef.current.start();
      }
    };
    const onPageHide = () => {
      timerRef.current.pause();
      void autosave();
    };
    const onBlur = () => timerRef.current.pause();
    const onFocus = () => timerRef.current.start();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, [autosave]);

  // -------------------------------------------------------------- navigation

  const goToWindow = useCallback((next: QueueWindow, preferredIndex: number | null) => {
    setQueue(next);
    const target = preferredIndex ?? next.state.currentIndex;
    setActiveIndex(Math.min(target, next.state.total));
  }, []);

  const submitFrame = useCallback(
    async (status: AnnotationStatus) => {
      if (busyRef.current || !itemRef.current) return;
      setBusy(true);
      timerRef.current.pause();
      try {
        const form = await buildForm({
          submit: true,
          status,
          // A status button is a deliberate statement that there is nothing to
          // mark, so any strokes on the frame are dropped with it.
          includeMasks: status === 'drawn',
        });
        if (!form) return;
        const response = await fetch('/api/annotations', { method: 'POST', body: form });
        if (!response.ok) throw new Error(String(response.status));
        const next = (await response.json()) as QueueWindow & { ok: boolean };
        dirtyRef.current = false;
        setSaveError(null);
        // After fixing an earlier frame, jump forward to where they left off.
        const target = returnIndex !== null ? returnIndex : null;
        setReturnIndex(null);
        goToWindow({ state: next.state, items: next.items }, target);
      } catch {
        setSaveError('Could not save. Check the connection and try again.');
        timerRef.current.start();
      } finally {
        setBusy(false);
      }
    },
    [buildForm, goToWindow, returnIndex],
  );

  const stepBack = useCallback(async () => {
    if (busyRef.current || activeIndex <= 0 || returnIndex !== null) return;
    setBusy(true);
    try {
      await autosave();
      const target = activeIndex - 1;
      const response = await fetch(`/api/queue?index=${target}`);
      if (!response.ok) throw new Error(String(response.status));
      const payload = (await response.json()) as QueueWindow;
      setQueue((previous) => ({
        state: payload.state,
        items: [
          ...previous.items.filter((candidate) => candidate.index !== target),
          ...payload.items,
        ].sort((a, b) => a.index - b.index),
      }));
      setReturnIndex(activeIndex);
      setActiveIndex(target);
    } catch {
      setSaveError('Could not step back.');
    } finally {
      setBusy(false);
    }
  }, [activeIndex, returnIndex, autosave]);

  // ------------------------------------------------------------------- tools

  const handleUndo = useCallback(() => canvasRef.current?.undo(), []);
  const handleClear = useCallback(() => canvasRef.current?.clear(), []);

  const canAdvance = hasContent && confidence !== null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;

      switch (event.key.toLowerCase()) {
        case 'g':
          setLayer('go');
          break;
        case 'n':
          setLayer('nogo');
          break;
        case 'l':
          setTool('lasso');
          break;
        case 'b':
          setTool('brush');
          break;
        case 'e':
          setTool('eraser');
          break;
        case 'u':
          handleUndo();
          break;
        case '1':
          setConfidence('low');
          dirtyRef.current = true;
          break;
        case '2':
          setConfidence('medium');
          dirtyRef.current = true;
          break;
        case '3':
          setConfidence('high');
          dirtyRef.current = true;
          break;
        case 'enter':
          if (canAdvance) void submitFrame('drawn');
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleUndo, submitFrame, canAdvance]);

  // ------------------------------------------------------------------ render

  if (queue.state.total === 0) {
    return (
      <main className="viewport-fill grid place-items-center px-6 text-center">
        <div className="max-w-md">
          <h1 className="text-lg font-semibold">No frames assigned yet</h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            Your queue has not been prepared. Please let the study coordinator know.
          </p>
        </div>
      </main>
    );
  }

  if (queue.state.finished || !item) {
    return (
      <main className="viewport-fill grid place-items-center px-6 text-center">
        <div className="max-w-md">
          <h1 className="text-xl font-semibold">All done — thank you.</h1>
          <p className="mt-3 text-sm leading-relaxed text-zinc-400">
            You have reviewed all {queue.state.total} frames. You can close this tab.
          </p>
        </div>
      </main>
    );
  }

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
        <AnnotationCanvas
          key={item.assignmentId}
          ref={canvasRef}
          frameUrl={item.frameUrl}
          nativeWidth={item.width}
          nativeHeight={item.height}
          layer={layer}
          tool={tool}
          brushSize={brushSize}
          goMaskUrl={item.goMaskUrl}
          nogoMaskUrl={item.nogoMaskUrl}
          onContentChange={setHasContent}
          onEdit={() => {
            dirtyRef.current = true;
          }}
          onUndoAvailable={setCanUndo}
          onUndoUsed={() => {
            undoCountRef.current += 1;
          }}
        />

        <div className="pointer-events-none absolute right-3 top-3 rounded-md bg-black/60 px-3 py-1.5 text-sm tabular-nums text-zinc-300">
          {activeIndex + 1} of {queue.state.total}
        </div>

        {saveError && (
          <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-amber-950/80 px-3 py-1.5 text-xs text-amber-200">
            {saveError}
          </div>
        )}
      </div>

      <ActionBar
        confidence={confidence}
        canAdvance={canAdvance}
        busy={busy}
        canGoBack={activeIndex > 0 && returnIndex === null}
        onConfidenceChange={(value) => {
          setConfidence(value);
          dirtyRef.current = true;
        }}
        onNext={() => void submitFrame('drawn')}
        onBack={() => void stepBack()}
        onNothingToMark={() => void submitFrame('nothing_to_mark')}
        onCannotAssess={() => void submitFrame('cannot_assess')}
      />
    </main>
  );
}
