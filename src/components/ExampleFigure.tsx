'use client';

import { useEffect, useRef } from 'react';
import { LAYER_COLORS, MASK_OPACITY } from '@/lib/types';

interface Props {
  frameUrl: string | null;
  width: number;
  height: number;
}

/**
 * The worked example on the welcome screen: one green region and one red
 * region, drawn at exactly the opacity the real tool uses, over a real practice
 * frame when one has been loaded.
 */
export default function ExampleFigure({ frameUrl, width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const paintOverlay = () => {
      ctx.save();
      ctx.globalAlpha = MASK_OPACITY;

      ctx.fillStyle = LAYER_COLORS.go;
      ctx.beginPath();
      ctx.ellipse(width * 0.3, height * 0.6, width * 0.17, height * 0.19, -0.3, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = LAYER_COLORS.nogo;
      ctx.beginPath();
      ctx.ellipse(width * 0.63, height * 0.38, width * 0.18, height * 0.2, 0.25, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();

      ctx.save();
      ctx.font = `${Math.round(height * 0.055)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 6;
      ctx.fillText('Go', width * 0.3 - 14, height * 0.62);
      ctx.fillText('No-Go', width * 0.63 - 36, height * 0.4);
      ctx.restore();
    };

    const paintFallbackTissue = () => {
      const gradient = ctx.createRadialGradient(
        width * 0.45,
        height * 0.45,
        20,
        width * 0.5,
        height * 0.5,
        width * 0.75,
      );
      gradient.addColorStop(0, '#b4564c');
      gradient.addColorStop(0.6, '#8a3f39');
      gradient.addColorStop(1, '#3d1f1e');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      for (let i = 0; i < 18; i++) {
        ctx.beginPath();
        ctx.fillStyle = `rgba(${190 - (i % 5) * 16}, ${115 + (i % 6) * 8}, ${100 + (i % 4) * 10}, 0.28)`;
        ctx.arc(
          (Math.sin(i * 12.9898) * 0.5 + 0.5) * width,
          (Math.sin(i * 78.233) * 0.5 + 0.5) * height,
          20 + ((i * 29) % 70),
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    };

    canvas.width = width;
    canvas.height = height;

    if (!frameUrl) {
      paintFallbackTissue();
      paintOverlay();
      return;
    }

    const image = new Image();
    image.onload = () => {
      ctx.drawImage(image, 0, 0, width, height);
      paintOverlay();
    };
    image.onerror = () => {
      paintFallbackTissue();
      paintOverlay();
    };
    image.src = frameUrl;
  }, [frameUrl, width, height]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full rounded-lg border border-zinc-800"
      style={{ aspectRatio: `${width} / ${height}` }}
      aria-label="Example frame with one green Go region and one red No-Go region"
    />
  );
}
