import { useState, useRef, useCallback, useEffect } from 'react'
import Webcam from 'react-webcam'
import { QRCodeSVG } from 'qrcode.react'
import { supabase } from '../lib/supabaseClient'

const COUPLE_NAMES = process.env.NEXT_PUBLIC_COUPLE_NAMES || 'Demi & Adam'
const WEDDING_DATE  = process.env.NEXT_PUBLIC_WEDDING_DATE  || 'Nov 2, 2027'

const PHOTO_COUNT    = 4
const COUNTDOWN_FROM = 3
const AUTO_RESET_MS  = 30_000

// Strip canvas dimensions
const STRIP_W  = 360
const PHOTO_H  = 270
const GAP      = 8
const HEADER_H = 124
const FOOTER_H = 60

const FILTERS = [
  { id: 'none',    label: 'Original', css: 'none' },
  { id: 'bw',      label: 'B&W',      css: 'grayscale(100%)' },
  { id: 'warm',    label: 'Warm',     css: 'sepia(20%) saturate(140%) brightness(105%)' },
  { id: 'cool',    label: 'Cool',     css: 'saturate(70%) hue-rotate(20deg) brightness(97%)' },
  { id: 'vintage', label: 'Vintage',  css: 'sepia(45%) contrast(88%) brightness(93%)' },
  { id: 'fade',    label: 'Fade',     css: 'brightness(115%) contrast(80%) saturate(70%)' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Canvas helpers ─────────────────────────────────────────────────────────────

function drawCover(ctx, img, x, y, w, h) {
  const ir = img.width / img.height
  const tr = w / h
  let sx, sy, sw, sh
  if (ir > tr) {
    sh = img.height; sw = sh * tr; sx = (img.width - sw) / 2; sy = 0
  } else {
    sw = img.width; sh = sw / tr; sx = 0; sy = (img.height - sh) / 2
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h)
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

async function buildStripCanvas(photos, filterCss = 'none') {
  const totalH = HEADER_H + PHOTO_COUNT * PHOTO_H + (PHOTO_COUNT - 1) * GAP + FOOTER_H
  const canvas = document.createElement('canvas')
  canvas.width  = STRIP_W
  canvas.height = totalH
  const ctx = canvas.getContext('2d')

  // White base
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, STRIP_W, totalH)

  // Header
  ctx.fillStyle = '#4f1e57'
  ctx.fillRect(0, 0, STRIP_W, HEADER_H)

  // Logo — skipped gracefully if file is missing
  let logoBottom = 8
  try {
    const logo = await loadImage('/logo.png')
    const maxH = 52, maxW = STRIP_W - 48
    const scale = Math.min(maxW / logo.width, maxH / logo.height)
    const lw = logo.width * scale
    const lh = logo.height * scale
    ctx.drawImage(logo, (STRIP_W - lw) / 2, 8, lw, lh)
    logoBottom = 8 + lh + 6
  } catch { logoBottom = 14 }

  ctx.textAlign = 'center'
  ctx.fillStyle = '#f8f1d6'
  ctx.font = 'italic 600 20px "Playfair Display", Georgia, serif'
  ctx.fillText(COUPLE_NAMES, STRIP_W / 2, logoBottom + 20)

  ctx.fillStyle = 'rgba(248,241,214,0.65)'
  ctx.font = '400 12px Georgia, serif'
  ctx.fillText(WEDDING_DATE, STRIP_W / 2, logoBottom + 38)

  ctx.strokeStyle = 'rgba(248,241,214,0.2)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(24, HEADER_H - 10); ctx.lineTo(STRIP_W - 24, HEADER_H - 10)
  ctx.stroke()

  // Photos with optional canvas filter (Chrome 76+ / Safari 18+)
  for (let i = 0; i < photos.length; i++) {
    const y = HEADER_H + i * (PHOTO_H + GAP)
    try {
      const img = await loadImage(photos[i])
      if (filterCss !== 'none') ctx.filter = filterCss
      drawCover(ctx, img, 0, y, STRIP_W, PHOTO_H)
      ctx.filter = 'none'
    } catch {
      ctx.filter = 'none'
      ctx.fillStyle = '#2a0f30'
      ctx.fillRect(0, y, STRIP_W, PHOTO_H)
    }
  }

  // Footer
  const fy = HEADER_H + PHOTO_COUNT * (PHOTO_H + GAP) - GAP
  ctx.fillStyle = '#4f1e57'
  ctx.fillRect(0, fy, STRIP_W, FOOTER_H)
  ctx.textAlign = 'center'
  ctx.fillStyle = '#f8f1d6'
  ctx.font = 'italic 400 15px "Playfair Display", Georgia, serif'
  ctx.fillText('♥  with love  ♥', STRIP_W / 2, fy + 36)

  return canvas
}

async function uploadStrip(dataUrl) {
  if (!supabase) return null
  try {
    const blob = await (await fetch(dataUrl)).blob()
    const filename = `strip-${Date.now()}.jpg`
    const { error } = await supabase.storage
      .from('photo-strips')
      .upload(filename, blob, { contentType: 'image/jpeg', upsert: false })
    if (error) return null
    const { data } = supabase.storage.from('photo-strips').getPublicUrl(filename)
    return data?.publicUrl ?? null
  } catch {
    return null
  }
}

// iPadOS 13+ reports as MacIntel — check maxTouchPoints to distinguish it from a real Mac
function isiOS() {
  if (typeof navigator === 'undefined') return false
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function PhotoBooth() {
  // phase: idle | filter-select | shooting | building | review
  const [phase, setPhase]               = useState('idle')
  const [selectedFilter, setSelectedFilter] = useState(FILTERS[0])
  const [countdown, setCountdown]       = useState(null)
  const [shotNum, setShotNum]           = useState(0)
  const [photos, setPhotos]             = useState([])
  const [flash, setFlash]               = useState(false)
  const [stripUrl, setStripUrl]         = useState(null)
  const [qrUrl, setQrUrl]               = useState(null)
  const [uploading, setUploading]       = useState(false)
  const [camError, setCamError]         = useState(false)

  const webcamRef     = useRef(null)
  const capturedRef   = useRef([])
  const cancelRef     = useRef(false)
  const resetTimerRef = useRef(null)

  const clearResetTimer = () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    resetTimerRef.current = null
  }

  const resetToIdle = useCallback(() => {
    cancelRef.current = true
    clearResetTimer()
    capturedRef.current = []
    setPhotos([]); setStripUrl(null); setQrUrl(null)
    setFlash(false); setCountdown(null); setShotNum(0)
    setUploading(false); setCamError(false)
    setSelectedFilter(FILTERS[0])
    setPhase('idle')
  }, [])

  const scheduleAutoReset = useCallback(() => {
    clearResetTimer()
    resetTimerRef.current = setTimeout(resetToIdle, AUTO_RESET_MS)
  }, [resetToIdle])

  const runSequence = useCallback(async (filter) => {
    for (let i = 0; i < PHOTO_COUNT; i++) {
      if (cancelRef.current) return
      setShotNum(i + 1)
      for (let n = COUNTDOWN_FROM; n >= 1; n--) {
        if (cancelRef.current) return
        setCountdown(n)
        await sleep(1000)
      }
      if (cancelRef.current) return
      setCountdown(0)
      await sleep(200)
      setFlash(true)
      const src = webcamRef.current?.getScreenshot({ width: 1280, height: 960 }) ?? null
      await sleep(220)
      setFlash(false)
      const updated = [...capturedRef.current, src]
      capturedRef.current = updated
      setPhotos([...updated])
      if (i < PHOTO_COUNT - 1) await sleep(900)
    }
    if (cancelRef.current) return
    setCountdown(null)
    setPhase('building')
    const canvas = await buildStripCanvas(capturedRef.current, filter.css)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
    if (cancelRef.current) return
    setStripUrl(dataUrl)
    setPhase('review')
    scheduleAutoReset()
    if (supabase) {
      setUploading(true)
      const url = await uploadStrip(dataUrl)
      if (!cancelRef.current) { setQrUrl(url); setUploading(false) }
    }
  }, [scheduleAutoReset])

  const handleIdleTap = useCallback(() => {
    cancelRef.current = false
    capturedRef.current = []
    setPhotos([]); setStripUrl(null); setQrUrl(null)
    setFlash(false); setCountdown(null); setShotNum(0)
    setCamError(false)
    setPhase('filter-select')
  }, [])

  // Camera is already live on filter-select — shoot immediately with no delay
  const handleShoot = useCallback(() => {
    setPhase('shooting')
    runSequence(selectedFilter)
  }, [runSequence, selectedFilter])

  const handlePrint    = useCallback(() => window.print(), [])

  const handleDownload = useCallback(() => {
    if (!stripUrl) return
    if (isiOS()) {
      const w = window.open('', '_blank')
      w.document.write(
        `<html><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh">` +
        `<img src="${stripUrl}" style="max-width:100%;max-height:100vh">` +
        `</body></html>`
      )
      w.document.close()
    } else {
      const a = document.createElement('a')
      a.href = stripUrl
      a.download = `photo-strip-${Date.now()}.jpg`
      a.click()
    }
  }, [stripUrl])

  useEffect(() => () => clearResetTimer(), [])

  // ── Idle ────────────────────────────────────────────────────────────────────
  if (phase === 'idle') {
    return (
      <div className="screen" onClick={handleIdleTap} style={{ cursor: 'pointer' }}>
        <div className="content">
          {/* Hide broken-image icon if logo.png isn't present */}
          <img
            src="/logo.png"
            alt=""
            className="logo"
            onError={(e) => { e.target.style.display = 'none' }}
          />
          <h1 className="names">{COUPLE_NAMES}</h1>
          <p className="date">{WEDDING_DATE}</p>
          <p className="tap-hint">Tap anywhere to start</p>
        </div>

        <style jsx>{`
          .screen {
            width: 100vw; height: 100vh;
            display: flex; align-items: center; justify-content: center;
            background: #4f1e57;
          }
          .content { text-align: center; padding: 24px; }
          .logo {
            display: block; margin: 0 auto 28px;
            max-width: 220px; max-height: 130px;
            width: auto; height: auto; object-fit: contain;
          }
          .names {
            font-family: 'Playfair Display', Georgia, serif;
            font-size: clamp(28px, 6vw, 48px);
            font-weight: 400; color: #f8f1d6;
            letter-spacing: 2px; margin-bottom: 10px;
          }
          .date {
            font-family: 'Playfair Display', Georgia, serif;
            font-style: italic;
            font-size: clamp(14px, 3vw, 20px);
            color: rgba(248,241,214,0.7);
            margin-bottom: 56px;
          }
          .tap-hint {
            font-size: 12px; letter-spacing: 4px; text-transform: uppercase;
            color: rgba(248,241,214,0.45);
            animation: pulse 2.4s ease-in-out infinite;
          }
          @keyframes pulse {
            0%, 100% { opacity: 0.4 } 50% { opacity: 1 }
          }
        `}</style>
      </div>
    )
  }

  // ── Camera screen (filter-select + shooting + building share one Webcam) ────
  if (phase === 'filter-select' || phase === 'shooting' || phase === 'building') {
    const isFilterSelect = phase === 'filter-select'
    const isShooting     = phase === 'shooting'
    const isBuilding     = phase === 'building'

    return (
      <div className="screen">
        {camError ? (
          <div className="cam-error">
            <p>Camera unavailable</p>
            <button onClick={resetToIdle}>Go back</button>
          </div>
        ) : (
          <Webcam
            ref={webcamRef}
            audio={false}
            screenshotFormat="image/jpeg"
            mirrored
            playsInline
            videoConstraints={{ facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }}
            onUserMediaError={() => setCamError(true)}
            style={{
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0,
              width: '100%', height: '100%',
              objectFit: 'cover',
              filter: selectedFilter.css,
              transition: 'filter 0.25s ease',
            }}
          />
        )}

        {/* Flash */}
        {flash && <div className="flash" />}

        {/* ── Filter-select overlay ── */}
        {isFilterSelect && (
          <>
            {/* Tappable area above the filter bar */}
            <div className="shoot-zone" onClick={handleShoot} />
            <p className="start-prompt">Tap to shoot</p>
            <div className="filter-bar" onClick={(e) => e.stopPropagation()}>
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  className={`pill${selectedFilter.id === f.id ? ' active' : ''}`}
                  onClick={() => setSelectedFilter(f)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </>
        )}

        {/* ── Shooting / building overlay ── */}
        {(isShooting || isBuilding) && (
          <div className="hud">
            {isBuilding && <p className="building-msg">Creating your strip…</p>}
            {isShooting && countdown !== null && countdown > 0 && (
              <div className="countdown">{countdown}</div>
            )}
            {isShooting && countdown === 0 && <div className="smile">smile!</div>}
          </div>
        )}

        {isShooting && (
          <>
            <div className="dots">
              {Array.from({ length: PHOTO_COUNT }, (_, i) => (
                <span key={i} className={`dot${i < photos.length ? ' filled' : ''}`} />
              ))}
            </div>
            <div className="shot-label">Photo {shotNum} of {PHOTO_COUNT}</div>
          </>
        )}

        <button className="cancel-btn" onClick={resetToIdle}>✕</button>

        <style jsx>{`
          .screen {
            position: relative; width: 100vw; height: 100vh;
            overflow: hidden; background: #000;
          }
          .flash {
            position: absolute; top: 0; right: 0; bottom: 0; left: 0;
            background: white; z-index: 20; pointer-events: none;
          }

          /* Filter-select */
          .shoot-zone {
            position: absolute; top: 0; left: 0; right: 0; bottom: 108px;
            z-index: 5; cursor: pointer;
          }
          .start-prompt {
            position: absolute; top: 50%; left: 50%;
            transform: translate(-50%, -50%);
            font-family: 'Playfair Display', Georgia, serif;
            font-style: italic; font-size: clamp(22px, 5vw, 36px);
            color: white; text-shadow: 0 2px 24px rgba(0,0,0,0.85);
            z-index: 6; pointer-events: none;
            animation: pulse 2s ease-in-out infinite;
          }
          @keyframes pulse { 0%,100%{opacity:0.6} 50%{opacity:1} }
          .filter-bar {
            position: absolute; bottom: 0; left: 0; right: 0;
            height: 108px;
            display: flex; align-items: center;
            gap: 10px; padding: 0 16px;
            background: linear-gradient(transparent, rgba(79,30,87,0.9));
            z-index: 10; overflow-x: auto;
            -webkit-overflow-scrolling: touch;
            scrollbar-width: none;
          }
          .filter-bar::-webkit-scrollbar { display: none; }
          .pill {
            flex-shrink: 0; padding: 8px 18px; border-radius: 22px;
            border: 1.5px solid rgba(248,241,214,0.45);
            background: transparent; color: rgba(248,241,214,0.8);
            font-family: 'Inter', sans-serif; font-size: 13px;
            cursor: pointer; transition: background 0.2s, color 0.2s, border-color 0.2s;
            -webkit-tap-highlight-color: transparent;
          }
          .pill.active {
            background: #f8f1d6; color: #4f1e57;
            border-color: #f8f1d6; font-weight: 600;
          }

          /* Shooting */
          .hud {
            position: absolute; top: 0; right: 0; bottom: 0; left: 0;
            display: flex; align-items: center; justify-content: center;
            z-index: 10; pointer-events: none;
          }
          .countdown {
            font-family: 'Playfair Display', Georgia, serif;
            font-size: min(40vw, 200px); font-weight: 400; color: white;
            text-shadow: 0 0 40px rgba(0,0,0,0.9), 0 0 80px rgba(0,0,0,0.5);
            line-height: 1; animation: pop 0.25s ease-out;
          }
          .smile {
            font-family: 'Playfair Display', Georgia, serif;
            font-style: italic; font-size: clamp(32px, 8vw, 56px);
            color: #f8f1d6; text-shadow: 0 0 30px rgba(0,0,0,0.9);
            animation: pop 0.2s ease-out;
          }
          .building-msg {
            font-family: 'Playfair Display', Georgia, serif;
            font-style: italic; font-size: clamp(22px, 5vw, 36px);
            color: white; text-shadow: 0 0 30px rgba(0,0,0,0.9);
          }
          @keyframes pop {
            from { transform: scale(1.3); opacity: 0 }
            to   { transform: scale(1);   opacity: 1 }
          }
          .dots {
            position: absolute; bottom: 28px; left: 50%;
            transform: translateX(-50%);
            display: flex; gap: 14px; z-index: 10;
          }
          .dot {
            width: 13px; height: 13px; border-radius: 50%;
            border: 2px solid rgba(255,255,255,0.7); background: transparent;
            transition: background 0.2s, border-color 0.2s;
          }
          .dot.filled { background: #f8f1d6; border-color: #f8f1d6; }
          .shot-label {
            position: absolute; top: 20px; left: 50%;
            transform: translateX(-50%);
            font-size: 12px; color: rgba(255,255,255,0.7);
            letter-spacing: 3px; text-transform: uppercase; z-index: 10;
          }

          /* Shared */
          .cancel-btn {
            position: absolute; top: 16px; right: 16px;
            background: rgba(0,0,0,0.45); border: 1px solid rgba(255,255,255,0.2);
            color: rgba(255,255,255,0.7); font-size: 18px;
            width: 40px; height: 40px; border-radius: 50%;
            cursor: pointer; z-index: 15;
            display: flex; align-items: center; justify-content: center;
          }
          .cam-error {
            position: absolute; top: 0; right: 0; bottom: 0; left: 0;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            gap: 16px; color: #f8f1d6;
          }
          .cam-error button {
            padding: 10px 24px; background: #f8f1d6; color: #4f1e57;
            border: none; border-radius: 4px; cursor: pointer; font-size: 16px;
          }
        `}</style>
      </div>
    )
  }

  // ── Review ──────────────────────────────────────────────────────────────────
  if (phase === 'review') {
    return (
      <div className="screen">
        <div className="layout">
          <div className="strip-wrap">
            {stripUrl && <img src={stripUrl} alt="Your photo strip" className="strip-img" />}
          </div>
          <div className="actions">
            <h2 className="title">Your strip!</h2>
            <button className="btn primary" onClick={handlePrint}>Print</button>
            <button className="btn secondary" onClick={handleDownload}>Download</button>
            {qrUrl && (
              <div className="qr-block">
                <span className="qr-label">Scan to save</span>
                <QRCodeSVG value={qrUrl} size={128} bgColor="#3a1540" fgColor="#f8f1d6" level="M" />
              </div>
            )}
            {uploading && !qrUrl && <p className="uploading">Uploading…</p>}
            <button className="btn ghost" onClick={resetToIdle}>Take Again</button>
          </div>
        </div>

        <div id="print-strip">
          {stripUrl && <img src={stripUrl} alt="photo strip" />}
        </div>

        <style jsx>{`
          .screen {
            width: 100vw; height: 100vh; overflow: hidden;
            background: #4f1e57;
            display: flex; align-items: center; justify-content: center;
          }
          .layout {
            display: flex; flex-direction: row;
            align-items: center; gap: 40px;
            padding: 24px; max-width: 100vw; max-height: 100vh;
          }
          .strip-wrap {
            flex-shrink: 0;
            display: flex; align-items: center; justify-content: center;
            max-height: calc(100vh - 48px);
          }
          .strip-img {
            max-height: calc(100vh - 48px); max-width: 50vw;
            width: auto; border-radius: 3px;
            box-shadow: 0 8px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(248,241,214,0.1);
          }
          .actions { display: flex; flex-direction: column; gap: 14px; min-width: 180px; }
          .title {
            font-family: 'Playfair Display', Georgia, serif;
            font-size: clamp(24px, 4vw, 36px);
            font-weight: 400; color: #f8f1d6; margin-bottom: 6px;
          }
          .btn {
            padding: 14px 24px; border-radius: 4px;
            font-family: 'Inter', sans-serif; font-size: 15px;
            cursor: pointer; border: none; letter-spacing: 0.5px;
            transition: transform 0.1s, opacity 0.15s;
            -webkit-tap-highlight-color: transparent;
          }
          .btn:active { transform: scale(0.96); }
          .btn.primary  { background: #f8f1d6; color: #4f1e57; font-weight: 600; }
          .btn.secondary {
            background: transparent; color: #f8f1d6;
            border: 1.5px solid rgba(248,241,214,0.7);
          }
          .btn.ghost {
            background: transparent; color: rgba(248,241,214,0.45);
            border: 1px solid rgba(248,241,214,0.2); margin-top: 6px;
          }
          .qr-block {
            display: flex; flex-direction: column; align-items: center;
            gap: 8px; margin-top: 6px;
            padding: 14px; background: rgba(0,0,0,0.25); border-radius: 6px;
          }
          .qr-label {
            font-size: 11px; color: rgba(248,241,214,0.55);
            letter-spacing: 2.5px; text-transform: uppercase;
          }
          .uploading { font-size: 12px; color: rgba(248,241,214,0.45); font-style: italic; }
          @media (max-aspect-ratio: 1/1) {
            .layout { flex-direction: column; gap: 24px; }
            .strip-img { max-height: 55vh; max-width: 90vw; }
            .actions { flex-direction: row; flex-wrap: wrap; justify-content: center; }
            .title { display: none; }
            .qr-block { display: none; }
          }
        `}</style>
      </div>
    )
  }

  return null
}
