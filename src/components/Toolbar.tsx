'use client';

import { MAX_BRUSH, MIN_BRUSH, type Layer, type Tool } from '@/lib/types';

interface Props {
  layer: Layer;
  tool: Tool;
  brushSize: number;
  canUndo: boolean;
  onLayerChange: (layer: Layer) => void;
  onToolChange: (tool: Tool) => void;
  onBrushSizeChange: (size: number) => void;
  onUndo: () => void;
  onClear: () => void;
}

const BUTTON =
  'select-none rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-35 ' +
  'disabled:cursor-not-allowed touch-manipulation';

export default function Toolbar({
  layer,
  tool,
  brushSize,
  canUndo,
  onLayerChange,
  onToolChange,
  onBrushSizeChange,
  onUndo,
  onClear,
}: Props) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3 py-2">
      <div className="flex items-center gap-2" role="group" aria-label="Zone class">
        <button
          type="button"
          onClick={() => onLayerChange('go')}
          aria-pressed={layer === 'go'}
          className={`${BUTTON} border-2 ${
            layer === 'go'
              ? 'border-go bg-go/25 text-green-200'
              : 'border-transparent bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
          }`}
        >
          <span className="mr-2 inline-block h-3 w-3 rounded-sm bg-go align-middle" />
          Go
        </button>
        <button
          type="button"
          onClick={() => onLayerChange('nogo')}
          aria-pressed={layer === 'nogo'}
          className={`${BUTTON} border-2 ${
            layer === 'nogo'
              ? 'border-nogo bg-nogo/25 text-red-200'
              : 'border-transparent bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
          }`}
        >
          <span className="mr-2 inline-block h-3 w-3 rounded-sm bg-nogo align-middle" />
          No-Go
        </button>
      </div>

      <div className="mx-1 h-8 w-px bg-zinc-800" aria-hidden />

      <div className="flex items-center gap-2" role="group" aria-label="Tool">
        {(
          [
            ['lasso', 'Lasso'],
            ['brush', 'Brush'],
            ['eraser', 'Eraser'],
          ] as [Tool, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => onToolChange(value)}
            aria-pressed={tool === value}
            className={`${BUTTON} ${
              tool === value ? 'bg-zinc-200 text-zinc-900' : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tool !== 'lasso' && (
        <label className="ml-1 flex items-center gap-2 text-xs text-zinc-400">
          <span className="w-8 tabular-nums">{brushSize}px</span>
          <input
            type="range"
            min={MIN_BRUSH}
            max={MAX_BRUSH}
            step={1}
            value={brushSize}
            onChange={(event) => onBrushSizeChange(Number(event.target.value))}
            className="w-28 cursor-pointer md:w-40"
            aria-label="Brush size"
          />
        </label>
      )}

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          className={`${BUTTON} bg-zinc-900 text-zinc-300 hover:bg-zinc-800`}
        >
          Undo
        </button>
        <button
          type="button"
          onClick={onClear}
          className={`${BUTTON} bg-zinc-900 text-zinc-300 hover:bg-zinc-800`}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
