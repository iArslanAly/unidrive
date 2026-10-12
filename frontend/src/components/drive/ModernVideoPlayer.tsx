import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { Maximize, Minimize, Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react'
import { cn } from '@/lib/utils'

const SPEEDS = [1, 1.25, 1.5, 2]

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export type ModernVideoPlayerProps = {
  src: string
  poster?: string
  mimeType?: string
  autoPlay?: boolean
  onEnded?: () => void
  onError?: () => void
  children?: ReactNode
}

/**
 * Cinematic floating-glass video player. Native controls are hidden; a minimal
 * control bar fades in on hover / movement and auto-hides during playback. Ships
 * a thin expanding scrubber with accent glow, play/pause, time, volume popover,
 * playback-speed switcher, and fullscreen — plus Space / ←→ / F / M shortcuts.
 */
export function ModernVideoPlayer({ src, poster, mimeType, autoPlay = true, onEnded, onError, children }: ModernVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const hideTimer = useRef<number | null>(null)

  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [fullscreen, setFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [scrubbing, setScrubbing] = useState(false)

  // Reset per-source state when the stream URL changes.
  useEffect(() => {
    setCurrent(0); setDuration(0); setBuffered(0); setPlaying(false)
  }, [src])

  const showControls = useCallback(() => {
    setControlsVisible(true)
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), 2600)
  }, [])

  useEffect(() => {
    return () => { if (hideTimer.current) window.clearTimeout(hideTimer.current) }
  }, [])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) { void video.play().catch(() => undefined) } else { video.pause() }
  }, [])

  const seekBy = useCallback((delta: number) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = Math.min(Math.max(0, video.currentTime + delta), video.duration || 0)
  }, [])

  const toggleFullscreen = useCallback(() => {
    const shell = shellRef.current
    if (!shell) return
    if (document.fullscreenElement) { void document.exitFullscreen().catch(() => undefined) }
    else { void shell.requestFullscreen?.().catch(() => undefined) }
  }, [])

  const cycleSpeed = useCallback(() => {
    setSpeed((prev) => {
      const next = SPEEDS[(SPEEDS.indexOf(prev) + 1) % SPEEDS.length]
      if (videoRef.current) videoRef.current.playbackRate = next
      return next
    })
  }, [])

  // Keyboard shortcuts: Space/K, ←/→ 5s seek, ↑/↓ volume, F fullscreen, M mute.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      // Let range/text inputs handle their own keys.
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      switch (event.key) {
        case ' ':
        case 'k':
          event.preventDefault(); togglePlay(); showControls(); break
        case 'ArrowRight':
          event.preventDefault(); seekBy(5); showControls(); break
        case 'ArrowLeft':
          event.preventDefault(); seekBy(-5); showControls(); break
        case 'ArrowUp':
          event.preventDefault(); setVolume((v) => { const nv = Math.min(1, Number((v + 0.1).toFixed(2))); if (videoRef.current) videoRef.current.volume = nv; setMuted(false); return nv }); showControls(); break
        case 'ArrowDown':
          event.preventDefault(); setVolume((v) => { const nv = Math.max(0, Number((v - 0.1).toFixed(2))); if (videoRef.current) videoRef.current.volume = nv; return nv }); break
        case 'f':
        case 'F':
          event.preventDefault(); toggleFullscreen(); break
        case 'm':
        case 'M':
          event.preventDefault(); setMuted((m) => { if (videoRef.current) videoRef.current.muted = !m; return !m }); break
        default: break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [togglePlay, seekBy, toggleFullscreen, showControls])

  useEffect(() => {
    const onFsChange = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  const onTimeUpdate = () => {
    const video = videoRef.current
    if (!video || scrubbing) return
    setCurrent(video.currentTime)
    if (video.buffered.length > 0) setBuffered(video.buffered.end(video.buffered.length - 1))
  }

  const onScrub = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value)
    setCurrent(value)
    if (videoRef.current) videoRef.current.currentTime = value
  }

  const progressPercent = duration > 0 ? (current / duration) * 100 : 0
  const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0

  return (
    <div
      ref={shellRef}
      className="group relative flex h-full w-full items-center justify-center overflow-hidden bg-black"
      onMouseMove={showControls}
      onMouseLeave={() => { if (playing) setControlsVisible(false) }}
    >
      <video
        ref={videoRef}
        poster={poster}
        autoPlay={autoPlay}
        playsInline
        preload="metadata"
        className="h-full w-full object-contain"
        onPlay={() => { setPlaying(true); showControls() }}
        onPause={() => { setPlaying(false); setControlsVisible(true); if (hideTimer.current) window.clearTimeout(hideTimer.current) }}
        onTimeUpdate={onTimeUpdate}
        onDurationChange={() => setDuration(videoRef.current?.duration || 0)}
        onProgress={onTimeUpdate}
        onEnded={() => { setPlaying(false); onEnded?.() }}
        onError={onError}
      >
        <source src={src} type={mimeType} />
        {children}
      </video>

      {/* Center play affordance when paused */}
      {!playing ? (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Play"
          className={cn(
            'absolute z-10 flex h-16 w-16 items-center justify-center rounded-full border border-white/20 bg-black/50 text-white shadow-2xl backdrop-blur-md transition-all hover:scale-105 hover:bg-blue-600',
            controlsVisible ? 'opacity-100' : 'opacity-0'
          )}
        >
          <Play className="ml-1 h-7 w-7 fill-white" />
        </button>
      ) : null}

      {/* Floating glass controls bar */}
      <div
        className={cn(
          'absolute bottom-6 left-1/2 z-20 flex w-[92%] max-w-4xl -translate-x-1/2 flex-col gap-2 rounded-2xl border border-white/10 bg-black/60 p-3 shadow-2xl backdrop-blur-xl transition-opacity duration-300',
          controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
      >
        {/* Scrubber: thin 4px, expands to 6px on hover, accent glow */}
        <div className="group/scrub relative flex h-4 items-center">
          <div className="relative h-1 w-full rounded-full bg-white/15 transition-all group-hover/scrub:h-1.5">
            <div className="absolute inset-y-0 left-0 rounded-full bg-white/25" style={{ width: `${bufferedPercent}%` }} />
            <div className="absolute inset-y-0 left-0 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.6)]" style={{ width: `${progressPercent}%` }} />
            <div className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-400 opacity-0 shadow transition-opacity group-hover/scrub:opacity-100" style={{ left: `${progressPercent}%` }} />
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={current}
              onChange={onScrub}
              onMouseDown={() => setScrubbing(true)}
              onMouseUp={() => setScrubbing(false)}
              onTouchStart={() => setScrubbing(true)}
              onTouchEnd={() => setScrubbing(false)}
              aria-label="Seek"
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </div>
        </div>
        {/* Controls row */}
        <div className="flex items-center gap-3 text-zinc-200">
          <button type="button" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} className="flex h-8 w-8 items-center justify-center rounded-lg text-white transition hover:bg-white/10">
            {playing ? <Pause className="h-5 w-5 fill-white" /> : <Play className="ml-0.5 h-5 w-5 fill-white" />}
          </button>

          <button type="button" onClick={() => seekBy(-5)} aria-label="Back 5 seconds" className="flex h-8 w-8 items-center justify-center rounded-lg transition hover:bg-white/10">
            <RotateCcw className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => seekBy(5)} aria-label="Forward 5 seconds" className="flex h-8 w-8 items-center justify-center rounded-lg transition hover:bg-white/10 [transform:scaleX(-1)]">
            <RotateCcw className="h-4 w-4" />
          </button>

          {/* Volume: slider expands on hover */}
          <div className="group/vol flex items-center gap-2">
            <button
              type="button"
              onClick={() => { const next = !muted; setMuted(next); if (videoRef.current) videoRef.current.muted = next }}
              aria-label={muted ? 'Unmute' : 'Mute'}
              className="flex h-8 w-8 items-center justify-center rounded-lg transition hover:bg-white/10"
            >
              {muted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(event) => { const v = Number(event.target.value); setVolume(v); setMuted(v === 0); if (videoRef.current) { videoRef.current.volume = v; videoRef.current.muted = v === 0 } }}
              aria-label="Volume"
              className="h-1 w-0 cursor-pointer appearance-none rounded-full bg-white/20 accent-blue-500 transition-all duration-200 group-hover/vol:w-20 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-400"
            />
          </div>

          <span className="font-mono text-xs tabular-nums text-zinc-300">{formatTime(current)} / {formatTime(duration)}</span>

          <div className="flex-1" />

          <button type="button" onClick={cycleSpeed} aria-label="Playback speed" className="flex h-8 items-center rounded-lg px-2 font-mono text-xs font-semibold transition hover:bg-white/10">
            {speed}x
          </button>

          <button type="button" onClick={toggleFullscreen} aria-label="Fullscreen" className="flex h-8 w-8 items-center justify-center rounded-lg transition hover:bg-white/10">
            {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  )
}

