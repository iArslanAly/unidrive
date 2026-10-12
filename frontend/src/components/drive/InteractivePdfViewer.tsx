import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'pdfjs-dist/web/pdf_viewer.css'
import { Check, Highlighter, Loader2, Maximize2, Minus, Minimize2, MousePointer2, PenTool, Plus, RotateCcw, RotateCw } from 'lucide-react'
import { cn } from '@/lib/utils'

// Wire the pdf.js worker (Vite resolves the ?url to a bundled asset URL).
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export type PdfTool = 'select' | 'highlight' | 'draw'

export type SaveState = 'idle' | 'saving' | 'saved'

type Pt = { x: number; y: number }

/** Annotations are stored in normalized page space (0..1, origin top-left). */
export type Annotation =
  | { id: string; type: 'highlight'; page: number; x: number; y: number; w: number; h: number; color: string }
  | { id: string; type: 'draw'; page: number; color: string; width: number; points: Pt[] }
  | { id: string; type: 'text'; page: number; x: number; y: number; text: string; color: string; size: number }

export type InteractivePdfViewerProps = {
  /** Raw PDF bytes (used by pdf.js to render and pdf-lib to bake annotations). */
  pdfBytes: ArrayBuffer
  fileName: string
  /** Persist the annotated PDF bytes (already baked). Resolve = saved. */
  onSave: (bytes: Uint8Array) => Promise<void> | void
  /** Fired once page 1 has rendered, so the parent can dismiss its unified loader. */
  onReady?: () => void
  /** @deprecated Loading is now owned by the parent via `onReady`. */
  loading?: boolean
  children?: ReactNode
}

const TOOL_META: Array<{ id: PdfTool; label: string; icon: typeof MousePointer2 }> = [
  { id: 'select', label: 'Select', icon: MousePointer2 },
  { id: 'highlight', label: 'Highlight', icon: Highlighter },
  { id: 'draw', label: 'Draw / Sign', icon: PenTool },
]

// Translucent marker shades for the Highlight tool.
const HIGHLIGHT_COLORS = ['#fef08a', '#bbf7d0', '#bae6fd', '#fbcfe8']
// Opaque ink colors for the Draw / Sign tool.
const INK_COLORS = ['#000000', '#1e3a8a', '#dc2626', '#059669']

/** Returns the palette that applies to a given tool (highlight = markers, else inks). */
const paletteForTool = (t: PdfTool): string[] => (t === 'highlight' ? HIGHLIGHT_COLORS : INK_COLORS)

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace('#', '')
  const v = m.length === 3 ? m.split('').map((c) => c + c).join('') : m
  const n = parseInt(v, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** A raw client rect reduced to left/top/right/bottom numbers. */
type FlatRect = { left: number; top: number; right: number; bottom: number }

/**
 * Merges contiguous selection rects that sit on the same text line into a single
 * continuous strip. Rects whose vertical position (`top`) is within `yTol` px and
 * that are horizontally adjacent (gap ≤ `xTol` px) are combined, so highlighting
 * a sentence yields one clean bar instead of dozens of per-word boxes. Rects on
 * different lines are kept separate (they become one strip each).
 */
function mergeLineRects(rects: FlatRect[], yTol = 4, xTol = 8): FlatRect[] {
  if (rects.length <= 1) return rects.slice()
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left)
  const merged: FlatRect[] = []
  for (const r of sorted) {
    const last = merged[merged.length - 1]
    const sameLine = last && Math.abs(r.top - last.top) <= yTol && Math.abs(r.bottom - last.bottom) <= yTol
    const adjacent = last && r.left - last.right <= xTol
    if (last && sameLine && adjacent) {
      last.right = Math.max(last.right, r.right)
      last.top = Math.min(last.top, r.top)
      last.bottom = Math.max(last.bottom, r.bottom)
    } else {
      merged.push({ ...r })
    }
  }
  return merged
}

/**
 * Builds an SVG path "d" string from normalized (0..1) points, scaled to the
 * page's pixel dimensions for use inside a `viewBox="0 0 w h"` overlay. Using
 * pixel coordinates (not CSS %) is required — SVG path data does not accept
 * percentage units, so `%`-based paths silently fail to render.
 */
const strokeToSvgPath = (points: Pt[], width: number, height: number): string =>
  points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${(p.x * width).toFixed(2)} ${(p.y * height).toFixed(2)}`).join(' ')

/**
 * Bakes annotations into the PDF using pdf-lib and returns the new bytes.
 * Coordinates: normalized (0..1, top-left) → PDF points (bottom-left origin).
 */
async function bakeAnnotations(pdfBytes: ArrayBuffer, annotations: Annotation[]): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true })
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const pages = pdfDoc.getPages()
  for (const ann of annotations) {
    const page = pages[ann.page]
    if (!page) continue
    const { width, height } = page.getSize()
    const [r, g, b] = hexToRgb(ann.color)
    if (ann.type === 'highlight') {
      page.drawRectangle({
        x: ann.x * width,
        y: height - (ann.y + ann.h) * height,
        width: ann.w * width,
        height: ann.h * height,
        color: rgb(r, g, b),
        opacity: 0.35,
      })
    } else if (ann.type === 'draw') {
      for (let i = 1; i < ann.points.length; i += 1) {
        const a = ann.points[i - 1]
        const c = ann.points[i]
        page.drawLine({
          start: { x: a.x * width, y: height - a.y * height },
          end: { x: c.x * width, y: height - c.y * height },
          thickness: ann.width,
          color: rgb(r, g, b),
        })
      }
    } else if (ann.type === 'text' && ann.text.trim()) {
      const size = ann.size * height
      page.drawText(ann.text.slice(0, 120), {
        x: ann.x * width,
        y: height - ann.y * height - size,
        size,
        font,
        color: rgb(r, g, b),
      })
    }
  }
  return pdfDoc.save()
}

/**
 * One rendered page: a <canvas> (pdf.js output), a transparent text layer for
 * native text selection, and an SVG annotation overlay. Behavior by tool:
 *  - highlight → text selection (I-beam): on mouseup, the selected range's line
 *    rects become highlight strips snapped to the text bounds.
 *  - draw      → freehand stroke (crosshair).
 * All annotation coordinates are normalized 0..1 relative to the page box.
 */
function PdfPage({
  pageIndex,
  tool,
  color,
  annotations,
  canvasRef,
  textLayerRef,
  onCommit,
  onDelete,
  selectedId,
  onSelect,
  pageWidth,
  pageHeight,
}: {
  pageIndex: number
  tool: PdfTool
  color: string
  annotations: Annotation[]
  canvasRef: (el: HTMLCanvasElement | null) => void
  textLayerRef: (el: HTMLDivElement | null) => void
  onCommit: (next: Annotation[]) => void
  onDelete: (id: string) => void
  selectedId: string | null
  onSelect: (id: string | null) => void
  pageWidth: number
  pageHeight: number
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  // 60FPS freehand drawing: the in-progress stroke is tracked imperatively (refs +
  // a live <path>) so pointermove paints with zero React reconciliation lag.
  const strokePointsRef = useRef<Pt[]>([])
  const isDrawingRef = useRef(false)
  const activePathRef = useRef<SVGPathElement | null>(null)

  const toNorm = (event: { clientX: number; clientY: number }): Pt => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 }
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
  }

  // Highlight via native text selection: merge contiguous line rects into clean
  // strips, convert to normalized page coords, then clear the selection.
  const captureSelection = () => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return
    const range = selection.getRangeAt(0)
    const pageEl = wrapRef.current
    if (!pageEl) return
    const pageRect = pageEl.getBoundingClientRect()
    if (pageRect.width === 0 || pageRect.height === 0) return
    const raw = Array.from(range.getClientRects())
      .filter((r) => r.width > 1 && r.height > 1)
      .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }))
    const merged = mergeLineRects(raw)
    const stamp = Date.now()
    const newHighlights: Annotation[] = merged.map((r, i) => ({
      id: `${pageIndex}-sel-${stamp}-${i}`,
      type: 'highlight' as const,
      page: pageIndex,
      x: (r.left - pageRect.left) / pageRect.width,
      y: (r.top - pageRect.top) / pageRect.height,
      w: (r.right - r.left) / pageRect.width,
      h: (r.bottom - r.top) / pageRect.height,
      color,
    }))
    selection.removeAllRanges()
    if (newHighlights.length > 0) onCommit([...annotations, ...newHighlights])
  }

  // Build an SVG path "d" from normalized points, scaled to this page's pixel
  // dimensions so it maps exactly inside the viewBox overlay.
  const pointsToPath = (points: Pt[]): string => strokeToSvgPath(points, pageWidth, pageHeight)

  const onPointerDown = (event: React.PointerEvent) => {
    // In Select mode, clicking empty page area clears the active selection.
    if (tool === 'select') { onSelect(null); return }
    if (tool === 'highlight') return
    const p = toNorm(event)
    // tool === 'draw' → begin an imperative freehand stroke (no React re-render
    // until pointerup). Paint directly to the live <path> for 60fps.
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
    isDrawingRef.current = true
    strokePointsRef.current = [p]
    if (activePathRef.current) {
      activePathRef.current.setAttribute('stroke', color)
      activePathRef.current.setAttribute('d', pointsToPath(strokePointsRef.current))
    }
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (!isDrawingRef.current) return
    strokePointsRef.current.push(toNorm(event))
    // Paint the growing stroke imperatively — 0ms latency, no state churn.
    if (activePathRef.current) activePathRef.current.setAttribute('d', pointsToPath(strokePointsRef.current))
  }

  const onPointerUp = () => {
    if (!isDrawingRef.current) return
    isDrawingRef.current = false
    const points = strokePointsRef.current
    strokePointsRef.current = []
    // Commit the finished stroke into history FIRST so React renders the permanent
    // <path> (correct pixel viewBox), THEN clear the temporary live scratch path.
    // This guarantees the stroke stays visible with no gap on release.
    if (points.length > 1) {
      onCommit([...annotations, { id: `${pageIndex}-${Date.now()}`, type: 'draw', page: pageIndex, color, width: 2, points }])
    }
    if (activePathRef.current) activePathRef.current.removeAttribute('d')
  }

  // Backspace / Delete removes the active annotation (Select mode only).
  useEffect(() => {
    if (tool !== 'select' || !selectedId) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault()
        onDelete(selectedId)
        onSelect(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool, selectedId, onDelete, onSelect])

  const pageAnnotations = annotations.filter((a) => a.page === pageIndex)
  const highlights = pageAnnotations.filter((a): a is Extract<Annotation, { type: 'highlight' }> => a.type === 'highlight')
  const strokes = pageAnnotations.filter((a): a is Extract<Annotation, { type: 'draw' }> => a.type === 'draw')
  const cursor = tool === 'highlight' ? 'text' : tool === 'draw' ? 'crosshair' : 'default'
  const interactive = tool === 'select'

  return (
    <div
      ref={wrapRef}
      className="relative mx-auto mb-6 overflow-hidden rounded-sm bg-white shadow-2xl"
      style={{ cursor, width: pageWidth || undefined, height: pageHeight || undefined }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onMouseUp={tool === 'highlight' ? captureSelection : undefined}
    >
      {/* LAYER 0 — pdf.js base canvas */}
      <canvas ref={canvasRef} className="block h-full w-full bg-white" />

      {/* LAYER 1 — transparent pdf.js text layer for native selection/highlighting.
          Explicit z-10 so annotation layers above it always win. */}
      <div
        ref={textLayerRef}
        className={cn('textLayer absolute inset-0 z-10', tool === 'highlight' ? 'select-text' : 'select-none')}
      />

      {/* LAYER 2 — highlights: HTML divs so `mix-blend-multiply` blends against the
          canvas (an inline <svg> would isolate blending to its own transparent
          backdrop). Black PDF text stays crisp through the marker color. */}
      <div className="pointer-events-none absolute inset-0 z-20">
        {highlights.map((hl) => (
          <div
            key={hl.id}
            title={interactive ? 'Click to select, then Delete to remove' : undefined}
            className={cn('absolute rounded-[2px] mix-blend-multiply opacity-80', selectedId === hl.id && 'ring-2 ring-blue-500')}
            style={{
              left: `${hl.x * 100}%`,
              top: `${hl.y * 100}%`,
              width: `${hl.w * 100}%`,
              height: `${hl.h * 100}%`,
              backgroundColor: hl.color || '#fef08a',
              pointerEvents: interactive ? 'auto' : 'none',
              cursor: interactive ? 'pointer' : undefined,
            }}
            onClick={interactive ? (event) => { event.stopPropagation(); onSelect(hl.id) } : undefined}
          />
        ))}
      </div>

      {/* LAYER 3 — persistent SVG overlay for committed strokes + the live in-progress
          path. A pixel viewBox (matching the canvas) makes committed <path d> coords
          exact; percentage path data is invalid SVG and would never render. */}
      <svg
        className={cn('absolute inset-0 z-20 h-full w-full', interactive ? '' : 'pointer-events-none')}
        viewBox={`0 0 ${pageWidth || 1} ${pageHeight || 1}`}
        preserveAspectRatio="none"
      >
        {strokes.map((s) => (
          <path
            key={s.id}
            d={strokeToSvgPath(s.points, pageWidth, pageHeight)}
            fill="none"
            stroke={selectedId === s.id ? '#3b82f6' : s.color}
            strokeWidth={s.width}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            style={{ filter: selectedId === s.id ? 'drop-shadow(0 0 2px rgba(59,130,246,0.9))' : undefined, pointerEvents: interactive ? 'stroke' : 'none', cursor: interactive ? 'pointer' : undefined }}
            onClick={interactive ? (event) => { event.stopPropagation(); onSelect(s.id) } : undefined}
          />
        ))}
        {/* Live in-progress stroke, painted imperatively for 60fps (see pointer handlers). */}
        <path
          ref={activePathRef}
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          className="pointer-events-none"
        />
      </svg>
    </div>
  )
}


/**
 * True interactive PDF annotator. pdf.js renders each page to a <canvas>; an SVG
 * overlay captures Highlight (text selection) and Freehand Draw/Sign (stroke
 * paths). Edits are baked into the PDF with pdf-lib and auto-saved (debounced
 * 1200ms) to Google Drive via the `onSave` callback, with a live status indicator
 * (Saved → Saving changes… → All changes saved to Drive).
 */
export function InteractivePdfViewer({ pdfBytes, onSave, onReady }: InteractivePdfViewerProps) {
  const [tool, setTool] = useState<PdfTool>('select')
  const [color, setColor] = useState(HIGHLIGHT_COLORS[0])
  // The currently selected annotation (Select mode). Lifted here so the toolbar
  // can reveal that annotation's palette and recolor it on the fly.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Undo/redo history stack of annotation snapshots.
  const [history, setHistory] = useState<Annotation[][]>([[]])
  const [historyIndex, setHistoryIndex] = useState(0)
  const annotations = history[historyIndex] ?? []
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [renderError, setRenderError] = useState('')
  const [numPages, setNumPages] = useState(0)
  // Pixel dimensions of each rendered page (captured during pdf.js render) so the
  // annotation SVG can use a matching viewBox and strokes map to exact coordinates.
  const [pageDims, setPageDims] = useState<Array<{ width: number; height: number }>>([])
  const [scale, setScale] = useState(1.2)
  // Fit mode: 'page' = fixed manual zoom (default centered view); 'width' = expand
  // the document edge-to-edge to fill the available container width.
  const [fitMode, setFitMode] = useState<'page' | 'width'>('page')
  // Measured content width of the scroll container, used to derive the fit-width
  // render scale. Kept in state so a ResizeObserver update re-renders the doc.
  const [containerWidth, setContainerWidth] = useState(0)
  // The scale actually applied to the last render (manual zoom or computed fit
  // width), shown in the toolbar zoom readout.
  const [activeScale, setActiveScale] = useState(1.2)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([])
  const textLayerRefs = useRef<Array<HTMLDivElement | null>>([])
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null)
  const debounceRef = useRef<number | null>(null)
  const savedTimerRef = useRef<number | null>(null)
  const saveSeqRef = useRef(0)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

  // Reset per-document.
  useEffect(() => {
    setHistory([[]]); setHistoryIndex(0); setSaveState('idle'); setRenderError(''); setTool('select'); setPageDims([])
  }, [pdfBytes])

  // Render all pages with pdf.js whenever the bytes, scale, fit mode, or the
  // measured container width change. In "Fit to Width" mode the per-page scale is
  // derived from the container width (so pages expand edge-to-edge); otherwise the
  // manual `scale` is used.
  useEffect(() => {
    let cancelled = false
    setRenderError('')
    ;(async () => {
      try {
        const pdf = await pdfjsLib.getDocument({ data: structuredClone(pdfBytes) }).promise
        if (cancelled) return
        setNumPages(pdf.numPages)
        for (let i = 1; i <= pdf.numPages; i += 1) {
          if (cancelled) return
          const page = await pdf.getPage(i)
          // Effective scale: fit-width expands the page to fill the scroll
          // container (minus p-4 gutters); otherwise the manual zoom applies.
          const baseWidth = page.getViewport({ scale: 1 }).width
          const availableWidth = Math.max(240, containerWidth - 32)
          const effectiveScale = fitMode === 'width' && containerWidth > 0
            ? Math.min(3, Math.max(0.5, availableWidth / baseWidth))
            : scale
          if (i === 1) setActiveScale(effectiveScale)
          const viewport = page.getViewport({ scale: effectiveScale })
          const canvas = canvasRefs.current[i - 1]
          if (!canvas || !canvas.getContext('2d')) continue
          canvas.width = viewport.width
          canvas.height = viewport.height
          canvas.style.width = `${viewport.width}px`
          canvas.style.height = `${viewport.height}px`
          setPageDims((prev) => {
            const next = prev.slice()
            next[i - 1] = { width: viewport.width, height: viewport.height }
            return next
          })
          renderTaskRef.current?.cancel()
          const task = page.render({ canvas, viewport })
          renderTaskRef.current = task
          await task.promise
          // Signal readiness to the parent once the FIRST page is on screen so it
          // can dismiss its unified loader (no second/interstitial skeleton).
          if (i === 1) onReadyRef.current?.()
          // Transparent text layer over the canvas so text is selectable (native
          // pdf.js text spans) — required for text-selection highlighting.
          const textLayerDiv = textLayerRefs.current[i - 1]
          if (textLayerDiv && !cancelled) {
            textLayerDiv.replaceChildren()
            const textLayer = new pdfjsLib.TextLayer({
              textContentSource: page.streamTextContent(),
              container: textLayerDiv,
              viewport,
            })
            await textLayer.render()
          }
        }
      } catch (error) {
        if (!cancelled) setRenderError(error instanceof Error ? error.message : 'Failed to render PDF')
      }
    })()
    return () => { cancelled = true; renderTaskRef.current?.cancel() }
  }, [pdfBytes, scale, fitMode, containerWidth])

  // Observe the scroll container's width so "Fit to Width" re-scales live on
  // window/stage resizes without a manual refresh.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setContainerWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Debounced auto-save: bake annotations with pdf-lib, then persist via onSave.
  const runSave = useCallback(async (current: Annotation[]) => {
    if (current.length === 0) return
    const seq = ++saveSeqRef.current
    setSaveState('saving')
    try {
      const bytes = await bakeAnnotations(pdfBytes, current)
      if (seq !== saveSeqRef.current) return // a newer save superseded this one
      await onSave(bytes)
      setSaveState('saved')
      if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current)
      savedTimerRef.current = window.setTimeout(() => setSaveState('idle'), 2200)
    } catch {
      if (seq === saveSeqRef.current) setSaveState('idle')
    }
  }, [pdfBytes, onSave])

  // Debounced auto-save trigger for a given snapshot.
  const triggerAutoSave = useCallback((next: Annotation[]) => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => { void runSave(next) }, 1200)
  }, [runSave])

  // Push a new snapshot onto the history stack (truncating any redo branch).
  const pushState = useCallback((next: Annotation[]) => {
    const trimmed = history.slice(0, historyIndex + 1)
    trimmed.push(next)
    setHistory(trimmed)
    setHistoryIndex(trimmed.length - 1)
    triggerAutoSave(next)
  }, [history, historyIndex, triggerAutoSave])

  const handleUndo = useCallback(() => {
    if (historyIndex <= 0) return
    const prev = history[historyIndex - 1] ?? []
    setHistoryIndex(historyIndex - 1)
    triggerAutoSave(prev)
  }, [history, historyIndex, triggerAutoSave])

  const handleRedo = useCallback(() => {
    if (historyIndex >= history.length - 1) return
    const next = history[historyIndex + 1] ?? []
    setHistoryIndex(historyIndex + 1)
    triggerAutoSave(next)
  }, [history, historyIndex, triggerAutoSave])

  const handleDelete = useCallback((id: string) => {
    pushState(annotations.filter((a) => a.id !== id))
    setSelectedId((cur) => (cur === id ? null : cur))
  }, [annotations, pushState])

  // Switch tools, dropping any stale selection and snapping the active color to a
  // sensible default for the new tool (black ink for Draw/Sign, yellow for Highlight)
  // whenever the current color doesn't belong to the incoming palette.
  const changeTool = useCallback((next: PdfTool) => {
    setTool(next)
    setSelectedId(null)
    setColor((cur) => {
      const pal = paletteForTool(next)
      return pal.includes(cur) ? cur : pal[0]
    })
  }, [])

  // Recolor the active annotation when a swatch is picked in Select mode; otherwise
  // just change the color used for the next annotation.
  const handleColor = useCallback((next: string) => {
    setColor(next)
    if (tool === 'select' && selectedId) {
      pushState(annotations.map((a) => (a.id === selectedId ? { ...a, color: next } : a)) as Annotation[])
    }
  }, [tool, selectedId, annotations, pushState])

  // Undo/redo keyboard shortcuts: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl+Y.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (!mod) return
      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey) { event.preventDefault(); handleUndo() }
      else if ((key === 'z' && event.shiftKey) || key === 'y') { event.preventDefault(); handleRedo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleUndo, handleRedo])

  useEffect(() => () => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current)
  }, [])

  const pages = useMemo(() => Array.from({ length: numPages }, (_, i) => i), [numPages])

  const statusBadge = () => {
    if (saveState === 'saving') {
      return <span className="flex animate-pulse items-center gap-1.5 text-[11px] font-mono text-blue-400"><Loader2 className="h-3 w-3 animate-spin" />Saving...</span>
    }
    if (saveState === 'saved') {
      return <span className="flex items-center gap-1.5 text-[11px] font-mono text-emerald-400"><Check className="h-3 w-3" />Saved to Drive</span>
    }
    return <span className="flex items-center gap-1.5 text-[11px] font-mono text-zinc-500"><Check className="h-3 w-3" />Saved</span>
  }

  // Loading is owned by the parent (via onReady); the viewer renders pages as they
  // arrive. numPages === 0 only until the doc parses — render nothing extra then.
  const ready = numPages > 0

  // Contextual palette for the toolbar: the tool's palette, or — in Select mode
  // with an active selection — the selected annotation's palette (markers for a
  // highlight, inks for draw/text). Empty in Select mode with nothing selected,
  // which hides the swatches to keep the dock clean.
  const selectedAnnotation = tool === 'select' ? annotations.find((a) => a.id === selectedId) : undefined
  const activePalette: string[] = tool === 'select'
    ? (selectedAnnotation ? paletteForTool(selectedAnnotation.type === 'highlight' ? 'highlight' : 'draw') : [])
    : paletteForTool(tool)

  return (
    <div className={cn('relative flex h-[88vh] w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl', fitMode === 'width' ? 'max-w-full' : 'max-w-5xl')}>
      {/* Unified single-row floating glass toolbar dock */}
      <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-3">
        <div className="pointer-events-auto flex select-none items-center gap-2 rounded-2xl border border-white/10 bg-zinc-900/90 px-3 py-2 shadow-2xl backdrop-blur-xl dark:bg-[#0c0d14]/90">
          {/* Segment 1 — History */}
          <div className="flex items-center gap-1">
            <button type="button" onClick={handleUndo} disabled={historyIndex === 0} className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-30" title="Undo (Ctrl+Z)" aria-label="Undo">
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={handleRedo} disabled={historyIndex >= history.length - 1} className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-30" title="Redo (Ctrl+Y)" aria-label="Redo">
              <RotateCw className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="h-4 w-px bg-white/10" />

          {/* Segment 2 — Tools */}
          <div className="flex items-center gap-0.5">
            {TOOL_META.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => changeTool(id)}
                title={label}
                aria-label={label}
                aria-pressed={tool === id}
                className={cn('flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] transition-colors', tool === id ? 'bg-blue-600 font-medium text-white shadow-sm' : 'text-zinc-400 hover:bg-white/5 hover:text-white')}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden md:inline">{label}</span>
              </button>
            ))}
          </div>

          {/* Segment 3 — Color swatches (contextual palette).
              Highlight → translucent markers; Draw/Sign → opaque inks.
              In Select mode, only shown when an annotation is selected so the user
              can recolor it on the fly. */}
          {activePalette.length > 0 ? (
            <>
              <div className="h-4 w-px bg-white/10" />
              <div className="flex items-center gap-1.5">
                {activePalette.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => handleColor(c)}
                    aria-label={`Use color ${c}`}
                    className={cn('h-3.5 w-3.5 rounded-full border transition-transform', color === c ? 'scale-125 border-white ring-1 ring-white/40' : 'border-white/20 hover:scale-110')}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </>
          ) : null}

          {/* Segment 4 — Fit-to-Width toggle + Zoom. In "Fit to Width" mode the
              document fills the container and manual zoom is disabled (the readout
              reflects the auto-computed fit scale). */}
          <div className="h-4 w-px bg-white/10" />
          <button
            type="button"
            onClick={() => setFitMode((prev) => (prev === 'page' ? 'width' : 'page'))}
            aria-pressed={fitMode === 'width'}
            title={fitMode === 'width' ? 'Fit to Screen (page)' : 'Fit to Width (full page)'}
            aria-label="Fit to width"
            className={cn('flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] font-medium transition-colors', fitMode === 'width' ? 'bg-blue-600 text-white shadow-sm' : 'text-zinc-400 hover:bg-white/10 hover:text-white')}
          >
            {fitMode === 'width' ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">{fitMode === 'width' ? 'Fit Page' : 'Fit Width'}</span>
          </button>
          <div className="flex items-center gap-1">
            <button type="button" disabled={fitMode === 'width'} onClick={() => setScale((s) => Math.max(0.5, Number((s - 0.2).toFixed(2))))} aria-label="Zoom out" className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"><Minus className="h-3.5 w-3.5" /></button>
            <span className="w-10 text-center font-mono text-[11px] tabular-nums text-zinc-400">{Math.round(activeScale * 100)}%</span>
            <button type="button" disabled={fitMode === 'width'} onClick={() => setScale((s) => Math.min(2.5, Number((s + 0.2).toFixed(2))))} aria-label="Zoom in" className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"><Plus className="h-3.5 w-3.5" /></button>
          </div>

          {/* Segment 5 — Live cloud status */}
          <div className="h-4 w-px bg-white/10" />
          <div className="flex min-w-[104px] items-center justify-end">{statusBadge()}</div>
        </div>
      </div>

      {/* Document surface */}
      <div ref={containerRef} className="relative flex-1 overflow-auto bg-zinc-950/60">
        {renderError ? <div className="p-8 pt-20 text-center text-sm text-rose-400">{renderError}</div> : null}
        <div className={cn('flex flex-col items-center gap-4 p-4 pt-16', !ready && 'invisible')}>
          {pages.map((pageIndex) => (
            <PdfPage
              key={pageIndex}
              pageIndex={pageIndex}
              tool={tool}
              color={color}
              annotations={annotations}
              canvasRef={(el) => { canvasRefs.current[pageIndex] = el }}
              textLayerRef={(el) => { textLayerRefs.current[pageIndex] = el }}
              onCommit={pushState}
              onDelete={handleDelete}
              selectedId={selectedId}
              onSelect={setSelectedId}
              pageWidth={pageDims[pageIndex]?.width ?? 0}
              pageHeight={pageDims[pageIndex]?.height ?? 0}
            />
          ))}
        </div>
      </div>
    </div>
  )
}


