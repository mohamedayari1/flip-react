import { useCallback, useEffect, useRef, useState } from 'react'
import { Flipbook, type FlipbookHandle, type FlipbookSlot } from './flipbook'
import { renderPdf, type RenderProgress } from './pdf/renderPdf'
import './App.css'

/** Crisp chevron glyph for the edge navigation arrows. */
function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
      <path
        d={dir === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default function App() {
  const [pages, setPages] = useState<(string | null)[]>([])
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<RenderProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [slot, setSlot] = useState<FlipbookSlot>({
    page: 0,
    numPages: 0,
    canFlipLeft: false,
    canFlipRight: false,
    canZoomIn: false,
    canZoomOut: false,
  })

  const fb = useRef<FlipbookHandle>(null)

  const onFile = useCallback(async (file: File) => {
    setError(null)
    setLoading(true)
    setProgress(null)
    setPages([])
    try {
      const buf = await file.arrayBuffer()
      const imgs = await renderPdf(buf, 2, setProgress)
      setPages(imgs)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  // keyboard navigation
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!fb.current) return
      if (ev.key === 'ArrowLeft' && fb.current.canFlipLeft) fb.current.flipLeft()
      if (ev.key === 'ArrowRight' && fb.current.canFlipRight) fb.current.flipRight()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const hasPages = pages.length > 0

  return (
    <div className="app">
      <header className="topbar">
        <label className="file-btn">
          {hasPages ? 'Open another PDF' : 'Choose a PDF'}
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onFile(f)
              e.target.value = ''
            }}
          />
        </label>
        {hasPages && (
          <div className="action-bar">
            <button
              className="btn"
              disabled={!slot.canFlipLeft}
              onClick={() => fb.current?.flipLeft()}
              aria-label="Previous page"
            >
              ◀
            </button>
            <button
              className="btn"
              disabled={!slot.canZoomOut}
              onClick={() => fb.current?.zoomOut()}
              aria-label="Zoom out"
            >
              －
            </button>
            <span className="page-num">
              Page {slot.page} of {slot.numPages}
            </span>
            <button
              className="btn"
              disabled={!slot.canZoomIn}
              onClick={() => fb.current?.zoomIn()}
              aria-label="Zoom in"
            >
              ＋
            </button>
            <button
              className="btn"
              disabled={!slot.canFlipRight}
              onClick={() => fb.current?.flipRight()}
              aria-label="Next page"
            >
              ▶
            </button>
          </div>
        )}
      </header>

      <main className="stage">
        {loading && (
          <div className="status">
            <div className="spinner" />
            <p>
              Rendering PDF
              {progress ? ` — page ${progress.page} of ${progress.total}` : '…'}
            </p>
          </div>
        )}

        {error && <div className="status error">Failed: {error}</div>}

        {!loading && !error && !hasPages && (
          <div className="status hint">
            <p>Upload a PDF to see it as a 3D flipbook.</p>
            <p className="sub">Drag or click page edges to flip · click to zoom · arrow keys navigate.</p>
          </div>
        )}

        {hasPages && (
          <div className="flipbook-wrap">
            <Flipbook
              ref={fb}
              pages={pages}
              onStateChange={setSlot}
              onFlipLeftEnd={(p) => (window.location.hash = '#' + p)}
              onFlipRightEnd={(p) => (window.location.hash = '#' + p)}
            />

            {/* Flipsnack-style edge arrows: overlay the left/right edges of the flip
                area, fade in on hover, dim when there's nowhere left to go. They sit
                above the viewport so a click flips the page (never triggers zoom). The
                flip effect itself is untouched — these just call the imperative handle. */}
            <button
              className="edge-nav left"
              disabled={!slot.canFlipLeft}
              onClick={() => fb.current?.flipLeft()}
              aria-label="Previous page"
            >
              <Chevron dir="left" />
            </button>
            <button
              className="edge-nav right"
              disabled={!slot.canFlipRight}
              onClick={() => fb.current?.flipRight()}
              aria-label="Next page"
            >
              <Chevron dir="right" />
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
