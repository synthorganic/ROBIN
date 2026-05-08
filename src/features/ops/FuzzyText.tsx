import React, { useEffect, useRef } from 'react';

type FuzzyTextProps = {
  children: React.ReactNode;
  fontSize?: number | string;
  fontWeight?: string | number;
  fontFamily?: string;
  color?: string;
  enableHover?: boolean;
  baseIntensity?: number;
  hoverIntensity?: number;
  className?: string;
  style?: React.CSSProperties;
};

export default function FuzzyText({
  children,
  fontSize = 'clamp(2rem, 6vw, 4.3rem)',
  fontWeight = 800,
  fontFamily = 'inherit',
  color = '#3dff65',
  enableHover = true,
  baseIntensity = 0.15,
  hoverIntensity = 0.42,
  className,
  style,
}: FuzzyTextProps) {
  const canvasRef = useRef<(HTMLCanvasElement & { cleanupFuzzyText?: () => void }) | null>(null);

  useEffect(() => {
    let animationFrameId = 0;
    let isCancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const init = async () => {
      if (document.fonts?.ready) {
        await document.fonts.ready;
      }
      if (isCancelled) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const computedStyle = window.getComputedStyle(canvas);
      const computedFontFamily =
        fontFamily === 'inherit' ? computedStyle.fontFamily || 'sans-serif' : fontFamily;

      const resolvedFontSize =
        typeof fontSize === 'number'
          ? `${fontSize}px`
          : computedStyle.fontSize || '48px';
      const text = React.Children.toArray(children).join('');
      const offscreen = document.createElement('canvas');
      const offCtx = offscreen.getContext('2d');
      if (!offCtx) return;

      offCtx.font = `${fontWeight} ${resolvedFontSize} ${computedFontFamily}`;
      offCtx.textBaseline = 'alphabetic';
      const metrics = offCtx.measureText(text);
      const actualLeft = metrics.actualBoundingBoxLeft ?? 0;
      const actualRight = metrics.actualBoundingBoxRight ?? metrics.width;
      const actualAscent = metrics.actualBoundingBoxAscent ?? 64;
      const actualDescent = metrics.actualBoundingBoxDescent ?? 10;
      const textWidth = Math.ceil(actualLeft + actualRight);
      const textHeight = Math.ceil(actualAscent + actualDescent);

      offscreen.width = textWidth + 12;
      offscreen.height = textHeight;
      offCtx.font = `${fontWeight} ${resolvedFontSize} ${computedFontFamily}`;
      offCtx.textBaseline = 'alphabetic';
      offCtx.fillStyle = color;
      offCtx.fillText(text, 6 - actualLeft, actualAscent);

      const margin = 28;
      canvas.width = offscreen.width + margin * 2;
      canvas.height = offscreen.height + margin;
      ctx.setTransform(1, 0, 0, 1, margin, 0);

      let isHovering = false;
      const fuzzRange = 28;

      const run = () => {
        if (isCancelled) return;
        ctx.clearRect(-fuzzRange, -fuzzRange, offscreen.width + fuzzRange * 2, offscreen.height + fuzzRange * 2);
        const intensity = isHovering ? hoverIntensity : baseIntensity;
        for (let row = 0; row < offscreen.height; row += 1) {
          const dx = Math.floor(intensity * (Math.random() - 0.5) * fuzzRange);
          ctx.drawImage(offscreen, 0, row, offscreen.width, 1, dx, row, offscreen.width, 1);
        }
        animationFrameId = window.requestAnimationFrame(run);
      };

      run();

      const handleMove = (clientX: number, clientY: number) => {
        const rect = canvas.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        isHovering = x >= margin && x <= margin + textWidth && y >= 0 && y <= textHeight;
      };

      const handleMouseMove = (event: MouseEvent) => {
        if (!enableHover) return;
        handleMove(event.clientX, event.clientY);
      };

      const handleMouseLeave = () => {
        isHovering = false;
      };

      if (enableHover) {
        canvas.addEventListener('mousemove', handleMouseMove);
        canvas.addEventListener('mouseleave', handleMouseLeave);
      }

      canvas.cleanupFuzzyText = () => {
        window.cancelAnimationFrame(animationFrameId);
        if (enableHover) {
          canvas.removeEventListener('mousemove', handleMouseMove);
          canvas.removeEventListener('mouseleave', handleMouseLeave);
        }
      };
    };

    void init();

    return () => {
      isCancelled = true;
      window.cancelAnimationFrame(animationFrameId);
      canvas?.cleanupFuzzyText?.();
    };
  }, [children, fontSize, fontWeight, fontFamily, color, enableHover, baseIntensity, hoverIntensity]);

  return (
    <canvas
      ref={canvasRef}
      className={['ops-fuzzy-text', className].filter(Boolean).join(' ')}
      aria-label={String(children)}
      style={{
        ...style,
        fontSize: typeof fontSize === 'number' ? `${fontSize}px` : fontSize,
        fontFamily: fontFamily === 'inherit' ? undefined : fontFamily,
      }}
    />
  );
}
