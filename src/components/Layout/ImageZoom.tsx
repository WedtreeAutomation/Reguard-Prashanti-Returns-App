import React, { useEffect, useRef, useState, MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { X, ZoomIn, ImageOff } from 'lucide-react';

interface ImageZoomProps {
  src: string;
  alt: string;
  zoomSize?: number;      // Magnifier lens size (px)
  zoomScale?: number;     // Magnifier background size (%)
  className?: string;
}

/**
 * Product / customer image with:
 *  - a hover magnifier on devices with a fine pointer (desktop), and
 *  - a click / tap / Enter full-screen viewer (Esc or the close button to exit).
 */
export const ImageZoom: React.FC<ImageZoomProps> = ({
  src,
  alt,
  zoomSize = 240,
  zoomScale = 350,
  className = '',
}) => {
  const [showMagnifier, setShowMagnifier] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [cursorPosition, setCursorPosition] = useState({ x: 0, y: 0 });
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const label = alt?.trim() || 'Image';
  const LENS_OFFSET = zoomSize / 2;

  useEffect(() => {
    setFailed(false);
  }, [src]);

  // Lightbox: Esc closes, focus moves to close button and back to the trigger.
  useEffect(() => {
    if (!lightboxOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const t = window.setTimeout(() => closeRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setLightboxOpen(false);
      }
      if (e.key === 'Tab') {
        // Only one focusable control inside the viewer.
        e.preventDefault();
        closeRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const trigger = triggerRef.current;
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      trigger?.focus();
    };
  }, [lightboxOpen]);

  const hasFinePointer = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(hover: hover) and (pointer: fine)').matches
      : true;

  const handleMouseEnter = () => {
    if (hasFinePointer()) setShowMagnifier(true);
  };
  const handleMouseLeave = () => setShowMagnifier(false);

  const handleMouseMove = (e: MouseEvent<HTMLButtonElement>) => {
    if (!imgRef.current) return;
    const { left, top, width, height } = imgRef.current.getBoundingClientRect();
    const x = e.clientX - left;
    const y = e.clientY - top;
    setCursorPosition({ x, y });
    if (x < 0 || y < 0 || x > width || y > height) {
      setShowMagnifier(false);
      return;
    }
    if (!showMagnifier && hasFinePointer()) setShowMagnifier(true);
    setPosition({ x: (x / width) * 100, y: (y / height) * 100 });
  };

  const getLensStyle = (): React.CSSProperties => {
    if (!imgRef.current) return {};
    const { width, height } = imgRef.current.getBoundingClientRect();
    let left = cursorPosition.x - LENS_OFFSET;
    let top = cursorPosition.y - LENS_OFFSET;
    left = Math.max(0, Math.min(left, width - zoomSize));
    top = Math.max(0, Math.min(top, height - zoomSize));
    return { left: `${left}px`, top: `${top}px` };
  };

  if (!src || failed) {
    return (
      <div
        className={`relative w-full h-full min-h-[10rem] rounded-lg border border-slate-200 bg-slate-50 flex flex-col items-center justify-center text-slate-400 ${className}`}
        role="img"
        aria-label={`${label} (not available)`}
      >
        <ImageOff className="w-6 h-6 mb-1" aria-hidden="true" />
        <span className="text-xs">Image unavailable</span>
      </div>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setShowMagnifier(false);
          setLightboxOpen(true);
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onMouseMove={handleMouseMove}
        aria-label={`View larger: ${label}`}
        className={`relative block w-full h-full min-h-[10rem] rounded-lg overflow-hidden border border-slate-200 bg-white cursor-zoom-in group focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${className}`}
      >
        <img
          ref={imgRef}
          src={src}
          alt={label}
          className="w-full h-full object-contain"
          draggable={false}
          loading="lazy"
          onError={() => setFailed(true)}
        />

        <span className="absolute top-2 left-2 flex items-center gap-1 rounded-md bg-black/50 px-1.5 py-1 text-[10px] font-medium text-white opacity-80 sm:opacity-0 sm:group-hover:opacity-80 sm:group-focus-visible:opacity-80 transition-opacity pointer-events-none">
          <ZoomIn className="w-3 h-3" aria-hidden="true" /> Zoom
        </span>

        {showMagnifier && (
          <>
            <span
              aria-hidden="true"
              className="absolute rounded-full pointer-events-none z-40 bg-black/5 backdrop-blur-[2px]"
              style={{
                width: `${zoomSize}px`,
                height: `${zoomSize}px`,
                ...getLensStyle(),
                border: '2px solid rgba(255,255,255,0.8)',
                boxShadow: '0 0 0 1px rgba(0,0,0,0.1), 0 8px 30px rgba(0,0,0,0.2)',
              }}
            />
            <span
              aria-hidden="true"
              className="absolute rounded-full pointer-events-none z-50 bg-no-repeat"
              style={{
                width: `${zoomSize}px`,
                height: `${zoomSize}px`,
                ...getLensStyle(),
                backgroundImage: `url("${src.replace(/"/g, '%22')}")`,
                backgroundPosition: `${position.x}% ${position.y}%`,
                backgroundSize: `${zoomScale}%`,
                border: '3px solid white',
                boxShadow: '0 0 0 1px rgba(0,0,0,0.1), 0 8px 30px rgba(0,0,0,0.3)',
              }}
            />
          </>
        )}
      </button>

      {lightboxOpen &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={label}
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/90 p-3 sm:p-8"
            onClick={() => setLightboxOpen(false)}
          >
            <button
              ref={closeRef}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setLightboxOpen(false);
              }}
              aria-label="Close image viewer"
              className="absolute right-3 top-3 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <X className="h-6 w-6" />
            </button>
            <img
              src={src}
              alt={label}
              className="max-h-full max-w-full object-contain select-none"
              onClick={(e) => e.stopPropagation()}
              draggable={false}
            />
          </div>,
          document.body
        )}
    </>
  );
};
