/*
 * Flipbook.tsx — the React component that drives and renders the 3D page-curl viewer.
 *
 * Ported from flipbook-vue (https://github.com/ts1/flipbook-vue),
 * original src/Flipbook.vue — Copyright (c) Takeshi Sone, MIT License.
 *
 * ============================================================================
 * WHAT THIS FILE DOES
 * ============================================================================
 *
 * This is the orchestration layer. The actual curl MATH lives in the pure, testable
 * modules geometry.ts / lighting.ts / matrix.ts. This component's jobs are:
 *
 *   • measure the viewport and decide single-page vs two-page spread (ResizeObserver)
 *   • hold the current page position and the transient "flip in progress" state
 *   • run the flip ANIMATION (a requestAnimationFrame loop over `progress` 0→1)
 *   • translate pointer / wheel / click gestures into flips, drags and zooms
 *   • every frame, call computePolygons() and paint the resulting strips as <div>s
 *   • expose an imperative handle + onStateChange callback so a toolbar can drive it
 *
 * ---------------------------------------------------------------------------
 * THE FLIP STATE MACHINE
 * ---------------------------------------------------------------------------
 *
 *      idle ──flipStart()──▶ flipping ──progress 0→1──▶ flipAuto commits page ──▶ idle
 *        ▲                      │
 *        │                      └── user releases early ──▶ flipRevert (progress→0) ──▶ idle
 *        │
 *      a flip is REJECTED while one is already running (canFlipLeft/Right return false),
 *      matching the reference — no queueing, no interruption.
 *
 *   `flipStart(dir, auto)`  chooses the front/back images, sets flip.direction, and (after
 *                           two rAFs so the resting page paints first) either begins the
 *                           auto animation or waits for the drag to drive `progress`.
 *   `flipAuto(ease)`        animates progress → 1 with an easeInOut curve, then advances
 *                           currentPage and fires onFlip*End.
 *   `flipRevert()`          animates progress → 0 and cancels the flip (drag released early).
 *   dragging                `swipeMove` sets progress = dragDistance / pageWidth directly,
 *                           so the page tracks your finger 1:1; `swipeEnd` decides commit
 *                           (progress > ¼) vs revert.
 *
 * ---------------------------------------------------------------------------
 * WHY A MUTABLE REF INSTEAD OF useState FOR EVERYTHING
 * ---------------------------------------------------------------------------
 *
 * The Vue original mutates a reactive `this` object. Straight useState would create stale
 * closures inside the rAF loops (each frame's callback would capture an old snapshot). So
 * all animation-coupled state lives in ONE mutable ref `s` (a direct analogue of Vue's
 * `data`), and `forceRender()` bumps a tick to repaint. Handlers and render read `s.current`
 * live. This is the pragmatic way to port fine-grained reactive mutation to React.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE YOU MUST NOT BREAK
 * ---------------------------------------------------------------------------
 *
 * Strip matrices are recomputed in JS on EVERY animation frame (see the render section).
 * Do NOT try to CSS-transition the matrix3d transforms: CSS interpolates matrices
 * component-wise, which does NOT reproduce a rotation about the cylinder — the curl would
 * collapse into a wrong, sheared tween. The animation must be driven by re-rendering the
 * strips each frame with freshly computed matrices.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  type SyntheticEvent,
} from 'react'
import { computePolygons } from './geometry'
import './flipbook.css'

export interface FlipbookProps {
  /**
   * Page image URLs, in order. A `null` element renders as a blank page — the convention
   * `pages[0] = null` gives a single right-hand cover (nothing to its left). Here we feed
   * it PDF pages rendered to data-URLs (see pdf/renderPdf.ts), but any URL works.
   */
  pages: (string | null)[]
  /** Optional higher-resolution URLs, swapped in when zoomed (> 1×). Falls back to `pages`. */
  pagesHiRes?: (string | null)[]
  /** Auto-flip duration in ms (button/keyboard flips). Default 1000. */
  flipDuration?: number
  /** Zoom animation duration in ms. Default 500. */
  zoomDuration?: number
  /** Zoom ladder cycled by click/buttons. Default [1, 2, 4]. */
  zooms?: number[]
  /** CSS perspective distance in px — smaller = stronger 3D. Default 2400. */
  perspective?: number
  /** Strips per page: more = smoother curl, more DOM nodes. Default 10. */
  nPolygons?: number
  /** Ambient light 0..1 (lower = darker curl shadow). Default 0.4. See lighting.ts. */
  ambient?: number
  /** Gloss highlight 0..1 (the sweeping sheen). Default 0.6. See lighting.ts. */
  gloss?: number
  /** Minimum pointer travel in px before a drag counts as a swipe (vs a click). Default 3. */
  swipeMin?: number
  /** Force single-page mode regardless of viewport aspect ratio. Default false. */
  singlePage?: boolean
  /** Reading direction — which side is "next". Default 'right' (left-to-right books). */
  forwardDirection?: 'right' | 'left'
  /** Slide the book so the visible spread stays centred as pages turn. Default true. */
  centering?: boolean
  /** Jump to this page on mount / when it changes (1-based). */
  startPage?: number | null
  /** Tap/click cycles the zoom ladder. Default true. */
  clickToZoom?: boolean
  /** Drag horizontally to turn pages. Default true. */
  dragToFlip?: boolean
  /** Mouse-wheel behaviour when zoomed: pan ('scroll') or zoom ('zoom'). Default 'scroll'. */
  wheel?: 'scroll' | 'zoom'
  /** Fired when a leftward flip begins / ends; receives the resulting page number. */
  onFlipLeftStart?: (page: number) => void
  onFlipLeftEnd?: (page: number) => void
  /** Fired when a rightward flip begins / ends; receives the resulting page number. */
  onFlipRightStart?: (page: number) => void
  onFlipRightEnd?: (page: number) => void
  /** Fired when a zoom animation begins / ends; receives the target zoom factor. */
  onZoomStart?: (zoom: number) => void
  onZoomEnd?: (zoom: number) => void
  /**
   * Reactive push of the slot-scope values (page indicator, can-flip / can-zoom flags).
   * React's equivalent of Vue's `v-slot` scope — subscribe to keep an external toolbar in
   * sync, since these values change during animations without the parent re-rendering.
   */
  onStateChange?: (state: FlipbookSlot) => void
}

export interface FlipbookSlot {
  page: number
  numPages: number
  canFlipLeft: boolean
  canFlipRight: boolean
  canZoomIn: boolean
  canZoomOut: boolean
}

/**
 * Imperative API exposed via `ref` (forwardRef + useImperativeHandle). Drive the viewer
 * from a parent toolbar or keyboard handler. The `can*` / `page` getters are live — they
 * read current state each access, so they are correct even mid-animation.
 */
export interface FlipbookHandle {
  /** Turn one page toward the left (no-op if `canFlipLeft` is false). */
  flipLeft: () => void
  /** Turn one page toward the right (no-op if `canFlipRight` is false). */
  flipRight: () => void
  /** Step up the zoom ladder (no-op at max). */
  zoomIn: () => void
  /** Step down the zoom ladder (no-op at 1×). */
  zoomOut: () => void
  readonly canFlipLeft: boolean
  readonly canFlipRight: boolean
  readonly canZoomIn: boolean
  readonly canZoomOut: boolean
  /** Current page number (1-based; accounts for the `null` cover convention). */
  readonly page: number
  /** Total page count (excludes a `null` cover slot). */
  readonly numPages: number
}

interface FlipState {
  progress: number
  direction: 'left' | 'right' | null
  frontImage: string | null
  backImage: string | null
  opacity: number
}

interface MutableState {
  viewWidth: number
  viewHeight: number
  imageWidth: number | null
  imageHeight: number | null
  displayedPages: 1 | 2
  currentPage: number
  firstPage: number
  secondPage: number
  zoomIndex: number
  zoom: number
  zooming: boolean
  touchStartX: number | null
  touchStartY: number | null
  maxMove: number
  activeCursor: string | null
  flip: FlipState
  currentCenterOffset: number | null
  scrollLeft: number
  scrollTop: number
  startScrollLeft: number
  startScrollTop: number
}

const easeIn = (x: number) => x * x
const easeOut = (x: number) => 1 - easeIn(1 - x)
const easeInOut = (x: number) =>
  x < 0.5 ? easeIn(x * 2) / 2 : 0.5 + easeOut((x - 0.5) * 2) / 2

const Flipbook = forwardRef<FlipbookHandle, FlipbookProps>(function Flipbook(props, ref) {
  const {
    pages,
    pagesHiRes = [],
    flipDuration = 1000,
    zoomDuration = 500,
    zooms = [1, 2, 4],
    perspective = 2400,
    nPolygons = 10,
    ambient = 0.4,
    gloss = 0.6,
    swipeMin = 3,
    singlePage = false,
    forwardDirection = 'right',
    centering = true,
    startPage = null,
    clickToZoom = true,
    dragToFlip = true,
    wheel = 'scroll',
    onFlipLeftStart,
    onFlipLeftEnd,
    onFlipRightStart,
    onFlipRightEnd,
    onZoomStart,
    onZoomEnd,
    onStateChange,
  } = props

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef<number[]>([])
  const centerRafRef = useRef<number | null>(null)

  const s = useRef<MutableState>({
    viewWidth: 0,
    viewHeight: 0,
    imageWidth: null,
    imageHeight: null,
    displayedPages: 1,
    currentPage: 0,
    firstPage: 0,
    secondPage: 1,
    zoomIndex: 0,
    zoom: zooms[0] ?? 1,
    zooming: false,
    touchStartX: null,
    touchStartY: null,
    maxMove: 0,
    activeCursor: null,
    flip: { progress: 0, direction: null, frontImage: null, backImage: null, opacity: 1 },
    currentCenterOffset: null,
    scrollLeft: 0,
    scrollTop: 0,
    startScrollLeft: 0,
    startScrollTop: 0,
  })

  const [, setTick] = useState(0)
  const forceRender = useCallback(() => setTick((t) => (t + 1) & 0xffff), [])

  // ---- derived getters (Vue `computed`), all read the live mutable ref ----
  const zooms_ = () => (zooms && zooms.length ? zooms : [1])
  const numPages = () => (pages[0] === null ? pages.length - 1 : pages.length)
  const page = () => {
    const c = s.current.currentPage
    return pages[0] !== null ? c + 1 : Math.max(1, c)
  }
  const pageUrl = (p: number, hiRes = false): string | null => {
    if (hiRes && s.current.zoom > 1 && !s.current.zooming) {
      const u = pagesHiRes[p]
      if (u) return u
    }
    return pages[p] || null
  }
  const canGoForward = () =>
    !s.current.flip.direction &&
    s.current.currentPage < pages.length - s.current.displayedPages
  const canGoBack = () =>
    !s.current.flip.direction &&
    s.current.currentPage >= s.current.displayedPages &&
    !(s.current.displayedPages === 1 && !pageUrl(s.current.firstPage - 1))
  const canFlipLeft = () =>
    forwardDirection === 'left' ? canGoForward() : canGoBack()
  const canFlipRight = () =>
    forwardDirection === 'right' ? canGoForward() : canGoBack()
  const canZoomIn = () => !s.current.zooming && s.current.zoomIndex < zooms_().length - 1
  const canZoomOut = () => !s.current.zooming && s.current.zoomIndex > 0

  const leftPage = () =>
    forwardDirection === 'right' || s.current.displayedPages === 1
      ? s.current.firstPage
      : s.current.secondPage
  const rightPage = () =>
    forwardDirection === 'left' ? s.current.firstPage : s.current.secondPage
  const showLeftPage = () => !!pageUrl(leftPage())
  const showRightPage = () => !!pageUrl(rightPage()) && s.current.displayedPages === 2

  const pageScale = () => {
    const { viewWidth, viewHeight, displayedPages, imageWidth, imageHeight } = s.current
    if (!imageWidth || !imageHeight) return 1
    const vw = viewWidth / displayedPages
    const xScale = vw / imageWidth
    const yScale = viewHeight / imageHeight
    const scale = xScale < yScale ? xScale : yScale
    return scale < 1 ? scale : 1
  }
  const pageWidth = () => Math.round((s.current.imageWidth ?? 0) * pageScale())
  const pageHeight = () => Math.round((s.current.imageHeight ?? 0) * pageScale())
  const xMargin = () => (s.current.viewWidth - pageWidth() * s.current.displayedPages) / 2
  const yMargin = () => (s.current.viewHeight - pageHeight()) / 2

  // ---- resize / display-mode detection (Vue onResize) ----
  const onResize = useCallback(() => {
    const vp = viewportRef.current
    if (!vp) return
    s.current.viewWidth = vp.clientWidth
    s.current.viewHeight = vp.clientHeight
    s.current.displayedPages =
      s.current.viewWidth > s.current.viewHeight && !singlePage ? 2 : 1
    if (s.current.displayedPages === 2) s.current.currentPage &= ~1
    fixFirstPage()
    forceRender()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singlePage, forceRender])

  const fixFirstPage = () => {
    if (
      s.current.displayedPages === 1 &&
      s.current.currentPage === 0 &&
      pages.length &&
      !pageUrl(0)
    ) {
      s.current.currentPage++
    }
  }

  const goToPage = useCallback(
    (p: number | null) => {
      if (p == null || p === page()) return
      if (pages[0] === null) {
        if (s.current.displayedPages === 2 && p === 1) s.current.currentPage = 0
        else s.current.currentPage = p
      } else {
        s.current.currentPage = p - 1
      }
      s.current.firstPage = s.current.currentPage
      s.current.secondPage = s.current.currentPage + 1
      s.current.currentCenterOffset = null
      forceRender()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [forceRender],
  )

  // mount: observe size, jump to startPage
  useLayoutEffect(() => {
    onResize()
    const vp = viewportRef.current
    let ro: ResizeObserver | null = null
    if (vp && 'ResizeObserver' in window) {
      ro = new ResizeObserver(() => onResize())
      ro.observe(vp)
    }
    window.addEventListener('resize', onResize, { passive: true })
    s.current.zoom = zooms_()[0]
    if (startPage != null) goToPage(startPage)
    return () => {
      window.removeEventListener('resize', onResize)
      ro?.disconnect()
      rafRef.current.forEach(cancelAnimationFrame)
      if (centerRafRef.current) cancelAnimationFrame(centerRafRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // react to startPage prop changes
  useEffect(() => {
    if (startPage != null) goToPage(startPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startPage])

  const didLoadImage = (ev: SyntheticEvent<HTMLImageElement>) => {
    if (s.current.imageWidth == null) {
      const img = ev.currentTarget
      s.current.imageWidth = img.naturalWidth
      s.current.imageHeight = img.naturalHeight
      preloadImages()
      forceRender()
    }
  }

  const preloadImages = (hiRes = false) => {
    const c = s.current.currentPage
    for (let i = c - 3; i <= c + 3; i++) {
      const u = pages[i]
      if (u) new Image().src = u
    }
    if (hiRes) {
      for (let i = c; i < c + s.current.displayedPages; i++) {
        const src = pagesHiRes[i]
        if (src) new Image().src = src
      }
    }
  }

  // ---- flip state machine (Vue flipStart / flipAuto / flipRevert) ----
  const flipStart = (direction: 'left' | 'right', auto: boolean) => {
    const st = s.current
    if (direction !== forwardDirection) {
      if (st.displayedPages === 1) {
        st.flip.frontImage = pageUrl(st.currentPage - 1)
        st.flip.backImage = null
      } else {
        st.flip.frontImage = pageUrl(st.firstPage)
        st.flip.backImage = pageUrl(st.currentPage - st.displayedPages + 1)
      }
    } else {
      if (st.displayedPages === 1) {
        st.flip.frontImage = pageUrl(st.currentPage)
        st.flip.backImage = null
      } else {
        st.flip.frontImage = pageUrl(st.secondPage)
        st.flip.backImage = pageUrl(st.currentPage + st.displayedPages)
      }
    }
    st.flip.direction = direction
    st.flip.progress = 0
    forceRender()

    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const s2 = s.current
        if (s2.flip.direction !== forwardDirection) {
          if (s2.displayedPages === 2) s2.firstPage = s2.currentPage - s2.displayedPages
        } else {
          if (s2.displayedPages === 1) s2.firstPage = s2.currentPage + s2.displayedPages
          else s2.secondPage = s2.currentPage + 1 + s2.displayedPages
        }
        forceRender()
        if (auto) flipAuto(true)
      }),
    )
    rafRef.current.push(id)
  }

  const flipAuto = (ease: boolean) => {
    const st = s.current
    isAutoFlipping.current = true
    const t0 = Date.now()
    const duration = flipDuration * (1 - st.flip.progress)
    const startRatio = st.flip.progress
    const dir = st.flip.direction
    if (dir === 'left') onFlipLeftStart?.(page())
    else if (dir === 'right') onFlipRightStart?.(page())

    const animate = () => {
      const id = requestAnimationFrame(() => {
        const t = Date.now() - t0
        let ratio = startRatio + t / duration
        if (ratio > 1) ratio = 1
        s.current.flip.progress = ease ? easeInOut(ratio) : ratio
        forceRender()
        if (ratio < 1) {
          animate()
        } else {
          const s2 = s.current
          if (s2.flip.direction !== forwardDirection) s2.currentPage -= s2.displayedPages
          else s2.currentPage += s2.displayedPages
          s2.firstPage = s2.currentPage
          s2.secondPage = s2.currentPage + 1
          const endedDir = s2.flip.direction
          if (endedDir === 'left') onFlipLeftEnd?.(page())
          else if (endedDir === 'right') onFlipRightEnd?.(page())
          s2.flip.direction = null
          isAutoFlipping.current = false
          preloadImages()
          forceRender()
        }
      })
      rafRef.current.push(id)
    }
    animate()
  }

  const flipRevert = () => {
    const st = s.current
    isAutoFlipping.current = true
    const t0 = Date.now()
    const duration = flipDuration * st.flip.progress
    const startRatio = st.flip.progress
    const animate = () => {
      const id = requestAnimationFrame(() => {
        const t = Date.now() - t0
        let ratio = startRatio - (startRatio * t) / duration
        if (ratio < 0) ratio = 0
        s.current.flip.progress = ratio
        forceRender()
        if (ratio > 0) {
          animate()
        } else {
          const s2 = s.current
          s2.firstPage = s2.currentPage
          s2.secondPage = s2.currentPage + 1
          s2.flip.direction = null
          isAutoFlipping.current = false
          forceRender()
        }
      })
      rafRef.current.push(id)
    }
    animate()
  }

  const flipLeft = () => {
    if (!canFlipLeft()) return
    flipStart('left', true)
  }
  const flipRight = () => {
    if (!canFlipRight()) return
    flipStart('right', true)
  }

  // ---- zoom (Vue zoomTo / zoomIn / zoomOut / zoomAt) ----
  const zoomTo = (zoom: number, zoomAtPt: { x: number; y: number } | null) => {
    const vp = viewportRef.current
    if (!vp) return
    const fixedX = zoomAtPt ? zoomAtPt.x : vp.clientWidth / 2
    const fixedY = zoomAtPt ? zoomAtPt.y : vp.clientHeight / 2
    const start = s.current.zoom
    const end = zoom
    const startX = vp.scrollLeft
    const startY = vp.scrollTop
    const containerFixedX = fixedX + startX
    const containerFixedY = fixedY + startY
    const endX = (containerFixedX / start) * end - fixedX
    const endY = (containerFixedY / start) * end - fixedY

    const t0 = Date.now()
    s.current.zooming = true
    onZoomStart?.(zoom)
    const animate = () => {
      const id = requestAnimationFrame(() => {
        const t = Date.now() - t0
        let ratio = t / zoomDuration
        if (ratio > 1) ratio = 1
        ratio = easeInOut(ratio)
        s.current.zoom = start + (end - start) * ratio
        s.current.scrollLeft = startX + (endX - startX) * ratio
        s.current.scrollTop = startY + (endY - startY) * ratio
        applyScroll()
        forceRender()
        if (t < zoomDuration) {
          animate()
        } else {
          onZoomEnd?.(zoom)
          s.current.zooming = false
          s.current.zoom = zoom
          s.current.scrollLeft = endX
          s.current.scrollTop = endY
          applyScroll()
          forceRender()
        }
      })
      rafRef.current.push(id)
    }
    animate()
    if (end > 1) preloadImages(true)
  }

  const zoomIn = (zoomAtPt: { x: number; y: number } | null = null) => {
    if (!canZoomIn()) return
    s.current.zoomIndex += 1
    zoomTo(zooms_()[s.current.zoomIndex], zoomAtPt)
  }
  const zoomOut = (zoomAtPt: { x: number; y: number } | null = null) => {
    if (!canZoomOut()) return
    s.current.zoomIndex -= 1
    zoomTo(zooms_()[s.current.zoomIndex], zoomAtPt)
  }
  const zoomAt = (pt: { x: number; y: number }) => {
    s.current.zoomIndex = (s.current.zoomIndex + 1) % zooms_().length
    zoomTo(zooms_()[s.current.zoomIndex], pt)
  }

  const applyScroll = () => {
    const vp = viewportRef.current
    if (!vp) return
    // clamp handled by browser; just push the animated values
    vp.scrollLeft = s.current.scrollLeft
    vp.scrollTop = s.current.scrollTop
  }

  // ---- pointer / swipe (Vue swipeStart / swipeMove / swipeEnd) ----
  const dragToScroll = () => true

  const swipeStart = (x: number, y: number) => {
    s.current.touchStartX = x
    s.current.touchStartY = y
    s.current.maxMove = 0
    if (s.current.zoom <= 1) {
      if (dragToFlip) s.current.activeCursor = 'grab'
    } else {
      const vp = viewportRef.current
      s.current.scrollLeft = vp ? vp.scrollLeft : 0
      s.current.scrollTop = vp ? vp.scrollTop : 0
      s.current.startScrollLeft = s.current.scrollLeft
      s.current.startScrollTop = s.current.scrollTop
      s.current.activeCursor = 'all-scroll'
    }
    forceRender()
  }

  const swipeMove = (x: number, y: number): boolean => {
    const st = s.current
    if (st.touchStartX == null || st.touchStartY == null) return false
    const dx = x - st.touchStartX
    const dy = y - st.touchStartY
    st.maxMove = Math.max(st.maxMove, Math.abs(dx))
    st.maxMove = Math.max(st.maxMove, Math.abs(dy))
    if (st.zoom > 1) {
      if (dragToScroll()) {
        st.scrollLeft = st.startScrollLeft - dx
        st.scrollTop = st.startScrollTop - dy
        applyScroll()
      }
      return true
    }
    if (!dragToFlip) return false
    if (Math.abs(dy) > Math.abs(dx)) return false
    st.activeCursor = 'grabbing'
    if (dx > 0) {
      if (st.flip.direction === null && canFlipLeft() && dx >= swipeMin)
        flipStart('left', false)
      if (st.flip.direction === 'left') {
        st.flip.progress = Math.min(1, dx / pageWidth())
      }
    } else {
      if (st.flip.direction === null && canFlipRight() && dx <= -swipeMin)
        flipStart('right', false)
      if (st.flip.direction === 'right') {
        st.flip.progress = Math.min(1, -dx / pageWidth())
      }
    }
    forceRender()
    return true
  }

  const swipeEnd = (x: number, y: number) => {
    const st = s.current
    if (st.touchStartX == null) return
    if (clickToZoom && st.maxMove < swipeMin) {
      zoomAt({ x, y })
    }
    if (st.flip.direction !== null && !isAutoFlipping.current) {
      if (st.flip.progress > 1 / 4) flipAuto(false)
      else flipRevert()
    }
    st.touchStartX = null
    st.activeCursor = null
    forceRender()
  }

  const isAutoFlipping = useRef(false)

  // pointer handlers on the viewport / bounding box
  const onPointerDownBox = (ev: ReactPointerEvent) => {
    if (ev.button && ev.button !== 0) return
    swipeStart(ev.pageX, ev.pageY)
    try {
      ;(ev.target as Element).setPointerCapture(ev.pointerId)
    } catch {
      /* noop */
    }
  }
  const onPointerMove = (ev: ReactPointerEvent) => {
    swipeMove(ev.pageX, ev.pageY)
  }
  const onPointerUp = (ev: ReactPointerEvent) => {
    swipeEnd(ev.pageX, ev.pageY)
    try {
      ;(ev.target as Element).releasePointerCapture(ev.pointerId)
    } catch {
      /* noop */
    }
  }
  const onWheel = (ev: ReactWheelEvent) => {
    const vp = viewportRef.current
    if (!vp) return
    if (wheel === 'scroll' && s.current.zoom > 1) {
      s.current.scrollLeft = vp.scrollLeft + ev.deltaX
      s.current.scrollTop = vp.scrollTop + ev.deltaY
      applyScroll()
    }
    if (wheel === 'zoom') {
      const pt = { x: ev.nativeEvent.offsetX, y: ev.nativeEvent.offsetY }
      if (ev.deltaY >= 100) zoomOut(pt)
      else if (ev.deltaY <= -100) zoomIn(pt)
    }
  }

  // ---- imperative handle (Vue v-slot bindings) ----
  useImperativeHandle(
    ref,
    () => ({
      flipLeft,
      flipRight,
      zoomIn: () => zoomIn(),
      zoomOut: () => zoomOut(),
      get canFlipLeft() {
        return canFlipLeft()
      },
      get canFlipRight() {
        return canFlipRight()
      },
      get canZoomIn() {
        return canZoomIn()
      },
      get canZoomOut() {
        return canZoomOut()
      },
      get page() {
        return page()
      },
      get numPages() {
        return numPages()
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // ========================================================================
  // RENDER — runs on every re-render, i.e. every animation frame during a flip.
  // Pipeline: derive page dimensions → (if flipping) compute front + back strips via
  // computePolygons → derive the bounding box, centering offset and slot state → paint
  // the two resting pages, the flipping strips, and the drag hit-box. The strips carry
  // freshly computed matrix3d transforms; there are NO CSS transitions on them.
  // ========================================================================
  const st = s.current
  const pw = pageWidth()
  const ph = pageHeight()
  const xm = xMargin()
  const ym = yMargin()

  let polygons: ReturnType<typeof computePolygons>['polygons'] = []
  let minX = Infinity
  let maxX = -Infinity
  let flipOpacity = 1
  if (st.flip.direction && st.imageWidth) {
    const common = {
      progress: st.flip.progress,
      direction: st.flip.direction,
      displayedPages: st.displayedPages,
      forwardDirection,
      pageWidth: pw,
      pageHeight: ph,
      viewWidth: st.viewWidth,
      xMargin: xm,
      yMargin: ym,
      nPolygons,
      perspective,
      ambient,
      gloss,
      frontImage: st.flip.frontImage,
      backImage: st.flip.backImage,
    } as const
    const front = computePolygons({ ...common, face: 'front' })
    const back = computePolygons({ ...common, face: 'back' })
    polygons = [...front.polygons, ...back.polygons]
    minX = Math.min(front.minX, back.minX)
    maxX = Math.max(front.maxX, back.maxX)
    flipOpacity = front.opacity
  }

  // bounding box (Vue boundingLeft / boundingRight)
  let boundingLeft: number
  let boundingRight: number
  if (st.displayedPages === 1) {
    boundingLeft = xm
    boundingRight = st.viewWidth - xm
  } else {
    const xl = pageUrl(leftPage()) ? xm : st.viewWidth / 2
    boundingLeft = Math.min(xl, minX)
    const xr = pageUrl(rightPage()) ? st.viewWidth - xm : st.viewWidth / 2
    boundingRight = Math.max(xr, maxX)
  }

  // centering (Vue centerOffset + smoothing)
  const centerOffset = useMemo(() => {
    if (!centering) return 0
    return Math.round(st.viewWidth / 2 - (boundingLeft + boundingRight) / 2)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centering, st.viewWidth, boundingLeft, boundingRight])

  if (st.currentCenterOffset == null && st.imageWidth != null) {
    st.currentCenterOffset = centerOffset
  }

  // smooth the center offset toward its target
  useEffect(() => {
    if (st.currentCenterOffset == null) return
    if (centerRafRef.current) cancelAnimationFrame(centerRafRef.current)
    const step = () => {
      const diff = centerOffset - (s.current.currentCenterOffset ?? centerOffset)
      if (Math.abs(diff) < 0.5) {
        s.current.currentCenterOffset = centerOffset
        forceRender()
        return
      }
      s.current.currentCenterOffset = (s.current.currentCenterOffset ?? 0) + diff * 0.1
      forceRender()
      centerRafRef.current = requestAnimationFrame(step)
    }
    centerRafRef.current = requestAnimationFrame(step)
    return () => {
      if (centerRafRef.current) cancelAnimationFrame(centerRafRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerOffset])

  const centerOffsetSmoothed = Math.round(st.currentCenterOffset ?? centerOffset)

  // push slot state to parent when it changes
  const slot: FlipbookSlot = {
    page: page(),
    numPages: numPages(),
    canFlipLeft: canFlipLeft(),
    canFlipRight: canFlipRight(),
    canZoomIn: canZoomIn(),
    canZoomOut: canZoomOut(),
  }
  const slotKey = `${slot.page}/${slot.numPages}/${+slot.canFlipLeft}${+slot.canFlipRight}${+slot.canZoomIn}${+slot.canZoomOut}`
  const prevSlotKey = useRef('')
  useEffect(() => {
    if (prevSlotKey.current !== slotKey) {
      prevSlotKey.current = slotKey
      onStateChange?.(slot)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotKey])

  const polygonWidthPx = Math.ceil(pw / nPolygons + 1 / st.zoom) + 'px'
  const polygonHeightPx = ph + 'px'
  const polygonBgSize = `${pw}px ${ph}px`

  const viewportStyle: CSSProperties = {
    perspective: `${perspective}px`,
    cursor: st.activeCursor === 'grabbing' ? 'grabbing' : 'auto',
    touchAction: st.zoom > 1 ? 'auto' : 'none',
  }

  const zoomed = st.zooming || st.zoom > 1

  return (
    <div
      ref={viewportRef}
      className={'fb-viewport' + (zoomed ? ' fb-zoom fb-drag-to-scroll' : '')}
      style={viewportStyle}
      onPointerMove={onPointerMove}
      onWheel={onWheel}
    >
      <div className="fb-container" style={{ transform: `scale(${st.zoom})` }}>
        <div
          className="fb-click-to-flip left"
          style={{ cursor: canFlipLeft() ? 'pointer' : 'auto' }}
          onClick={flipLeft}
        />
        <div
          className="fb-click-to-flip right"
          style={{ cursor: canFlipRight() ? 'pointer' : 'auto' }}
          onClick={flipRight}
        />
        <div style={{ transform: `translateX(${centerOffsetSmoothed}px)` }}>
          {showLeftPage() && (
            <img
              className="fb-page"
              style={{ width: pw, height: ph, left: xm, top: ym, position: 'absolute' }}
              src={pageUrl(leftPage(), true) ?? undefined}
              onLoad={didLoadImage}
              draggable={false}
              alt=""
            />
          )}
          {showRightPage() && (
            <img
              className="fb-page"
              style={{
                width: pw,
                height: ph,
                left: st.viewWidth / 2,
                top: ym,
                position: 'absolute',
              }}
              src={pageUrl(rightPage(), true) ?? undefined}
              onLoad={didLoadImage}
              draggable={false}
              alt=""
            />
          )}

          <div style={{ opacity: flipOpacity }}>
            {polygons.map((p) => (
              <div
                key={p.key}
                className={'fb-polygon' + (p.image ? '' : ' blank')}
                style={{
                  backgroundImage: p.image ? `url(${p.image})` : undefined,
                  backgroundSize: polygonBgSize,
                  backgroundPosition: p.bgPos,
                  width: polygonWidthPx,
                  height: polygonHeightPx,
                  transform: p.transform,
                  zIndex: p.zIndex,
                }}
              >
                {p.lighting.length > 0 && (
                  <div className="fb-lighting" style={{ backgroundImage: p.lighting }} />
                )}
              </div>
            ))}
          </div>

          <div
            className="fb-bounding-box"
            style={{
              left: boundingLeft,
              top: ym,
              width: boundingRight - boundingLeft,
              height: ph,
              cursor: st.activeCursor ?? 'grab',
            }}
            onPointerDown={onPointerDownBox}
            onPointerUp={onPointerUp}
          />
        </div>
      </div>
    </div>
  )
})

export default Flipbook
