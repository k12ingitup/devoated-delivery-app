import { useState, useRef, useCallback, useEffect } from 'react'
import Webcam from 'react-webcam'
import { QRCodeSVG } from 'qrcode.react'
import { supabase } from '../lib/supabaseClient'

// ─── Customise these for the wedding ────────────────────────────────────────
const COUPLE_NAMES = process.env.NEXT_PUBLIC_COUPLE_NAMES || 'Sarah & James'
const WEDDING_DATE = process.env.NEXT_PUBLIC_WEDDING_DATE || 'May 2, 2026'
// ────────────────────────────────────────────────────────────────────────────

const PHOTO_COUNT = 4
const COUNTDOWN_FROM = 3
const AUTO_RESET_MS = 30_000

// Strip canvas dimensions
const STRIP_W = 360
const PHOTO_H = 270   // each photo: 360×270 (4:3)
const GAP = 8
const HEADER_H = 76
const FOOTER_H = 56

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Canvas helpers ────────────────────────────────────────────────────────────

function drawCover(ctx, img, x, y, w, h) {
  const ir = img.width / img.height
  const tr = w / h
  let sx, sy, sw, sh
  if (ir > tr) {
    sh = img.height; sw = sh * tr
    sx = (img.width - sw) / 2; sy = 0
  } else {
    sw = img.width; sh = sw / tr
    sx = 0; sy = (img.height - sh) / 2
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

async function buildStripCanvas(photos) {
  const totalH = HEADER_H + PHOTO_COUNT * PHOTO_H + (PHOTO_COUNT - 1) * GAP + FOOTER_H
  const canvas = document.createElement('canvas')
  canvas.width = STRIP_W
  canvas.height = totalH
  const ctx = canvas.getContext('2d')

  // White background
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, STRIP_W, totalH)

  // Header
  ctx.fillStyle = '#1a1a2e'
  ctx.fillRect(0, 0, STRIP_W, HEADER_H)

  ctx.textAlign = 'center'
  ctx.fillStyle = '#d4af37'
  ctx.font = 'italic 600 22px "Playfair Display", Georgia, serif'
  ctx.fillText(COUPLE_NAMES, STRIP_W / 2, 32)

  ctx.fillStyle = '#a89060'
  ctx.font = '400 13px Georgia, serif'
  ctx.fillText(WEDDING_DATE, STRIP_W / 2, 54)

  // Decorative rule
  ctx.strokeStyle = '#d4af3755'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(24, 64); ctx.lineTo(STRIP_W - 24, 64)
  ctx.stroke()

  // Photos
  for (let i = 0; i < photos.length; i++) {
    const y = HEADER_H + i * (PHOTO_H + GAP)
    try {
      const img = await loadImage(photos[i])
      drawCover(ctx, img, 0, y, STRIP_W, PHOTO_H)
    } catch {
      ctx.fillStyle = '#222'
      ctx.fillRect(0, y, STRIP_W, PHOTO_H)
    }
  }

  // Footer
  const fy = HEADER_H + PHOTO_COUNT * (PHOTO_H + GAP) - GAP
  ctx.fillStyle = '#1a1a2e'
  ctx.fillRect(0, fy, STRIP_W, FOOTER_H)

  ctx.textAlign = 'center'
  ctx.fillStyle = '#d4af37'
  ctx.font = 'italic 400 16px "Playfair Display", Georgia, serif'
  ctx.fillText('♥  with love  ♥', STRIP_W / 2, fy + 34)

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

// iPadOS 13+ reports as "Macintosh" in the UA — check maxTouchPoints to detect it
function isiOS() {
  if (typeof navigator === 'undefined') return false
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PhotoBooth() {
  // phase: idle | shooting | building | review
  const [phase, setPhase] = useState('idle')
  const [countdown, setCountdown] = useState(null)
  const [shotNum, setShotNum] = useState(0)
  const [photos, setPhotos] = useState([])
  const [flash, setFlash] = useState(false)
  const [stripUrl, setStripUrl] = useState(null)
  const [qrUrl, setQrUrl] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [camError, setCamError] = useState(false)

  const webcamRef = useRef(null)
  const capturedRef = useRef([])
  const cancelRef = useRef(false)
  const resetTimerRef = useRef(null)

  const clearResetTimer = () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    resetTimerRef.current = null
  }

  const resetToIdle = useCallback(() => {
    cancelRef.current = true
    clearResetTimer()
    capturedRef.current = []
    setPhotos([])
    setStripUrl(null)
    setQrUrl(null)
    setFlash(false)
    setCountdown(null)
    setShotNum(0)
    setUploading(false)
    setCamError(false)
    setPhase('idle')
  }, [])

  const scheduleAutoReset = useCallback(() => {
    clearResetTimer()
    resetTimerRef.current = setTimeout(resetToIdle, AUTO_RESET_MS)
  }, [resetToIdle])

  const runSequence = useCallback(async () => {
    for (let i = 0; i < PHOTO_COUNT; i++) {
      if (cancelRef.current) return

      setShotNum(i + 1)

      // Countdown 3 → 1
      for (let n = COUNTDOWN_FROM; n >= 1; n--) {
        if (cancelRef.current) return
        setCountdown(n)
        await sleep(1000)
      }

      // "Smile!" beat then capture
      if (cancelRef.current) return
      setCountdown(0)
      await sleep(200)

      // Flash + screenshot
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

    // Build strip
    setCountdown(null)
    setPhase('building')

    const canvas = await buildStripCanvas(capturedRef.current)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92)

    if (cancelRef.current) return
    setStripUrl(dataUrl)
    setPhase('review')
    scheduleAutoReset()

    // Upload for QR code (optional — needs Supabase)
    if (supabase) {
      setUploading(true)
      const url = await uploadStrip(dataUrl)
      if (!cancelRef.current) {
        setQrUrl(url)
        setUploading(false)
      }
    }
  }, [scheduleAutoReset])

  const handleStart = useCallback(() => {
    cancelRef.current = false
    capturedRef.current = []
    setPhotos([])
    setStripUrl(null)
    setQrUrl(null)
    setFlash(false)
    setCountdown(null)
    setShotNum(0)
    setPhase('shooting')
    setTimeout(() => runSequence(), 600)
  }, [runSequence])

  const handlePrint = useCallback(() => window.print(), [])

  const handleDownload = useCallback(() => {
    if (!stripUrl) return
    if (isiOS()) {
      // iOS Safari silently ignores <a download> on data URLs.
      // Open in a new tab so the user can long-press → Save to Photos.
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

  // ── Idle screen ──────────────────────────────────────────────────────────────
  if (phase === 'idle') {
    return (
      <div className="screen" onClick={handleStart} style={{ cursor: 'pointer' }}>
        <div className="idle-content">
          <div className="hearts">♥</div>
          <h1 className="names">{COUPLE_NAMES}</h1>
          <p className="date">{WEDDING_DATE}</p>
          <p className="tap-hint">Tap anywhere to start</p>
        </div>

        <style jsx>{`
          .screen {
            width: 100vw; height: 100vh;
            display: flex; align-items: center; justify-content: center;
            background: #0a0a0a;
          }
          .idle-content { text-align: center; padding: 24px; }
          .hearts { font-size: 52px; color: #d4af37; margin-bottom: 16px; }
          .names {
            font-family: 'Playfair Display', Georgia, serif;
            font-size: clamp(28px, 6vw, 48px);
            font-weight: 400;
            color: #f5f0e8;
            letter-spacing: 2px;
            margin-bottom: 10px;
          }
          .date {
            font-family: 'Playfair Display', Georgia, serif;
            font-style: italic;
            font-size: clamp(14px, 3vw, 20px);
            color: #d4af37;
            margin-bottom: 56px;
          }
          .tap-hint {
            font-size: 12px;
            color: #555;
            letter-spacing: 4px;
            text-transform: uppercase;
            animation: pulse 2.4s ease-in-out infinite;
          }
          @keyframes pulse {
            0%, 100% { opacity: 0.4 }
            50% { opacity: 1 }
          }
        `}</style>
      </div>
    )
  }

  // ── Shooting / building screen ───────────────────────────────────────────────
  if (phase === 'shooting' || phase === 'building') {
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
            playsInline   // required on iOS to prevent the video hijacking fullscreen
            videoConstraints={{
              facingMode: 'user',
              // Use ideal (not exact) — iOS Safari rejects exact constraints and errors out
              width: { ideal: 1280 },
              height: { ideal: 960 },
            }}
            onUserMediaError={() => setCamError(true)}
            style={{
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0, // inset:0 shorthand not on iOS <14
              width: '100%', height: '100%',
              objectFit: 'cover',
            }}
          />
        )}

        {/* White flash overlay */}
        {flash && <div className="flash" />}

        {/* HUD */}
        <div className="hud">
          {phase === 'building' && (
            <div className="building-msg">Creating your strip…</div>
          )}

          {phase === 'shooting' && countdown !== null && countdown > 0 && (
            <div className="countdown">{countdown}</div>
          )}

          {phase === 'shooting' && countdown === 0 && (
            <div className="smile">smile!</div>
          )}
        </div>

        {/* Progress dots */}
        {phase === 'shooting' && (
          <div className="dots">
            {Array.from({ length: PHOTO_COUNT }, (_, i) => (
              <span key={i} className={`dot${i < photos.length ? ' filled' : ''}`} />
            ))}
          </div>
        )}

        {/* Shot label */}
        {phase === 'shooting' && (
          <div className="shot-label">Photo {shotNum} of {PHOTO_COUNT}</div>
        )}

        <button className="cancel-btn" onClick={resetToIdle}>✕</button>

        <style jsx>{`
          .screen {
            position: relative; width: 100vw; height: 100vh;
            overflow: hidden; background: #000;
          }
          .flash {
            position: absolute;
            top: 0; right: 0; bottom: 0; left: 0;
            background: white; z-index: 20; pointer-events: none;
          }
          .hud {
            position: absolute;
            top: 0; right: 0; bottom: 0; left: 0;
            display: flex; align-items: center; justify-content: center;
            z-index: 10; pointer-events: none;
          }
          .countdown {
            font-family: 'Playfair Display', Georgia, serif;
            font-size: min(40vw, 200px);
            font-weight: 400;
            color: white;
            text-shadow: 0 0 40px rgba(0,0,0,0.9), 0 0 80px rgba(0,0,0,0.5);
            line-height: 1;
            animation: pop 0.25s ease-out;
          }
          .smile {
            font-family: 'Playfair Display', Georgia, serif;
            font-style: italic;
            font-size: clamp(32px, 8vw, 56px);
            color: #d4af37;
            text-shadow: 0 0 30px rgba(0,0,0,0.9);
            animation: pop 0.2s ease-out;
          }
          .building-msg {
            font-family: 'Playfair Display', Georgia, serif;
            font-style: italic;
            font-size: clamp(22px, 5vw, 36px);
            color: white;
            text-shadow: 0 0 30px rgba(0,0,0,0.9);
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
            border: 2px solid rgba(255,255,255,0.7);
            background: transparent;
            transition: background 0.2s, border-color 0.2s;
          }
          .dot.filled { background: #d4af37; border-color: #d4af37; }
          .shot-label {
            position: absolute; top: 20px; left: 50%;
            transform: translateX(-50%);
            font-size: 12px; color: rgba(255,255,255,0.7);
            letter-spacing: 3px; text-transform: uppercase;
            z-index: 10;
          }
          .cancel-btn {
            position: absolute; top: 16px; right: 16px;
            background: rgba(0,0,0,0.45); border: 1px solid rgba(255,255,255,0.2);
            color: rgba(255,255,255,0.7); font-size: 18px;
            width: 40px; height: 40px; border-radius: 50%;
            cursor: pointer; z-index: 15;
            display: flex; align-items: center; justify-content: center;
          }
          .cam-error {
            position: absolute;
            top: 0; right: 0; bottom: 0; left: 0;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            gap: 16px; color: #f5f0e8;
          }
          .cam-error button {
            padding: 10px 24px; background: #d4af37; border: none;
            border-radius: 4px; cursor: pointer; font-size: 16px;
          }
        `}</style>
      </div>
    )
  }

  // ── Review screen ────────────────────────────────────────────────────────────
  if (phase === 'review') {
    return (
      <div className="screen">
        <div className="layout">
          {/* Strip preview */}
          <div className="strip-wrap">
            {stripUrl && (
              <img src={stripUrl} alt="Your photo strip" className="strip-img" />
            )}
          </div>

          {/* Actions */}
          <div className="actions">
            <h2 className="title">Your strip!</h2>

            <button className="btn primary" onClick={handlePrint}>
              Print
            </button>

            <button className="btn secondary" onClick={handleDownload}>
              Download
            </button>

            {qrUrl && (
              <div className="qr-block">
                <span className="qr-label">Scan to save</span>
                <QRCodeSVG
                  value={qrUrl}
                  size={128}
                  bgColor="#111827"
                  fgColor="#d4af37"
                  level="M"
                />
              </div>
            )}

            {uploading && !qrUrl && (
              <p className="uploading">Uploading…</p>
            )}

            <button className="btn ghost" onClick={resetToIdle}>
              Take Again
            </button>
          </div>
        </div>

        {/* ── Print target: only visible during window.print() ── */}
        <div id="print-strip">
          {stripUrl && <img src={stripUrl} alt="photo strip" />}
        </div>

        <style jsx>{`
          .screen {
            width: 100vw; height: 100vh; overflow: hidden;
            background: #0a0a0a;
            display: flex; align-items: center; justify-content: center;
          }
          .layout {
            display: flex;
            flex-direction: row;
            align-items: center;
            gap: 40px;
            padding: 24px;
            max-width: 100vw;
            max-height: 100vh;
          }
          .strip-wrap {
            flex-shrink: 0;
            display: flex; align-items: center; justify-content: center;
            max-height: calc(100vh - 48px);
          }
          .strip-img {
            max-height: calc(100vh - 48px);
            max-width: 50vw;
            width: auto;
            border-radius: 3px;
            box-shadow: 0 8px 48px rgba(0,0,0,0.85), 0 0 0 1px rgba(255,255,255,0.05);
          }
          .actions {
            display: flex; flex-direction: column;
            gap: 14px; min-width: 180px;
          }
          .title {
            font-family: 'Playfair Display', Georgia, serif;
            font-size: clamp(24px, 4vw, 36px);
            font-weight: 400;
            color: #f5f0e8;
            margin-bottom: 6px;
          }
          .btn {
            padding: 14px 24px;
            border-radius: 4px;
            font-family: 'Inter', sans-serif;
            font-size: 15px;
            cursor: pointer;
            border: none;
            letter-spacing: 0.5px;
            transition: transform 0.1s, opacity 0.15s;
            -webkit-tap-highlight-color: transparent;
          }
          .btn:active { transform: scale(0.96); }
          .btn.primary  { background: #d4af37; color: #0a0a0a; font-weight: 600; }
          .btn.secondary {
            background: transparent; color: #d4af37;
            border: 1.5px solid #d4af37;
          }
          .btn.ghost {
            background: transparent; color: #555;
            border: 1px solid #2a2a2a; margin-top: 6px;
          }
          .qr-block {
            display: flex; flex-direction: column; align-items: center;
            gap: 8px; margin-top: 6px;
            padding: 14px; background: #111827; border-radius: 6px;
          }
          .qr-label {
            font-size: 11px; color: #888;
            letter-spacing: 2.5px; text-transform: uppercase;
          }
          .uploading { font-size: 12px; color: #666; font-style: italic; }

          /* Portrait: stack vertically */
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
