/**
 * EsnafAjan Backend
 * Pipeline 1: Google Yorum → Claude → ElevenLabs → Seedance → FFmpeg → MP4
 * Pipeline 2: Fotoğraf → Seedance → FFmpeg → MP4 (Reels)
 */

import express from 'express'
import multer  from 'multer'
import crypto  from 'crypto'
import { createClient } from 'redis'
import fetch   from 'node-fetch'
import ffmpeg  from 'fluent-ffmpeg'
import fs      from 'fs'

// ─── Config ───────────────────────────────────────────────────────────────────

const C = {
  port:       parseInt(process.env.PORT || '3000'),
  backendUrl: process.env.BACKEND_URL || 'https://esnafajan-backend-production.up.railway.app',
  anthropic:  { apiKey: process.env.ANTHROPIC_API_KEY },
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY,
    voices: {
      kadin:      'SAz9YHcvj6GT2YYXdXww',
      gencErkek:  'FYPltOzsM2n1UbqzX19d',
      yasliErkek: 'WRjHw9UKGmcRAoOgyIzT',
    },
  },
  evolink: {
    apiKey:  process.env.EVOLINK_API_KEY,
    baseUrl: 'https://api.evolink.ai',
  },
  ls: {
    secret:      process.env.LS_WEBHOOK_SECRET,
    checkoutBase: process.env.LS_CHECKOUT_BASE,
    variants: {
      // Google Yorum paketleri
      yorum_tek: process.env.LS_YORUM_TEK,   // 150 ₺
      yorum_uc:  process.env.LS_YORUM_UC,    // 399 ₺
      yorum_on:  process.env.LS_YORUM_ON,    // 999 ₺
      // Reels paketleri
      reels_15s: process.env.LS_REELS_15S,   // 499 ₺
      reels_30s: process.env.LS_REELS_30S,   // 799 ₺
    },
  },
  redis: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
}

// ─── Redis ────────────────────────────────────────────────────────────────────

const redis = createClient({ url: C.redis.url })
await redis.connect()
console.log('[Redis] ✓')

async function saveSession(id, data) {
  await redis.setEx(`sess:${id}`, 7200, JSON.stringify(data))
}
async function getSession(id) {
  const r = await redis.get(`sess:${id}`)
  return r ? JSON.parse(r) : null
}
async function patch(id, data) {
  const s = await getSession(id)
  if (s) await saveSession(id, { ...s, ...data })
}

// ─── Lemon Squeezy ────────────────────────────────────────────────────────────

function checkoutUrl(variant, sessionId, tip) {
  const vid = C.ls.variants[variant]
  if (!vid) throw new Error(`LS variant eksik: ${variant}`)
  const p = new URLSearchParams({
    'checkout[custom][session_id]': sessionId,
    'checkout[custom][tip]': tip,
  })
  return `${C.ls.checkoutBase}/${vid}?${p}`
}

function verifySig(body, sig) {
  const exp = crypto.createHmac('sha256', C.ls.secret).update(body).digest('hex')
  return crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(sig))
}

// ─── Claude: Yorum Temizle ────────────────────────────────────────────────────

async function temizleYorum(yorum, isletme) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': C.anthropic.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Google yorumunu işletme sahibi ağzından, videoda okunacak şekilde düzenle.
Kurallar: emoji yok, max 3 cümle, işletme sahipliği dili ("ekibimiz", "lezzetlerimiz"), sadece metni yaz.
${isletme ? `İşletme: ${isletme}` : ''}
Yorum: ${yorum}`,
      }],
    }),
  })
  if (!res.ok) throw new Error(`Claude hata: ${res.status}`)
  const d = await res.json()
  return d.content[0].text.trim()
}

// ─── ElevenLabs: TTS ─────────────────────────────────────────────────────────

async function tts(metin, sesId) {
  const voiceId = C.elevenlabs.voices[sesId] || C.elevenlabs.voices.kadin
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': C.elevenlabs.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      text: metin,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  })
  if (!res.ok) throw new Error(`ElevenLabs hata: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function sesSuresi(mp3Buf) {
  const p = tmp('probe', 'mp3')
  fs.writeFileSync(p, mp3Buf)
  return new Promise((ok, err) => {
    ffmpeg.ffprobe(p, (e, m) => { tryDel(p); e ? err(e) : ok(Math.ceil(m.format.duration)) })
  })
}

// ─── Seedance: Video Üret ─────────────────────────────────────────────────────

async function seedance(photos, sureSn, promptText) {
  const clipSn  = 5
  const adet    = Math.ceil(sureSn / clipSn)
  const clips   = []
  const ref     = `data:image/jpeg;base64,${photos[0]}`

  for (let i = 0; i < adet; i++) {
    const img = `data:image/jpeg;base64,${photos[i % photos.length]}`
    console.log(`[Seedance] ${i + 1}/${adet}`)
    const res = await fetch(`${C.evolink.baseUrl}/v1/videos/generations`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${C.evolink.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'seedance-2.0-fast-reference-to-video',
        prompt: promptText || 'Cinematic atmosphere, smooth slow camera, warm professional lighting',
        image_urls: [img],
        video_urls: [ref],
        duration: clipSn,
        quality: '720p',
        aspect_ratio: '9:16',
        generate_audio: false,
      }),
    })
    if (!res.ok) throw new Error(`Seedance ${res.status}: ${await res.text()}`)
    const t = await res.json()
    clips.push(await pollTask(t.id))
  }

  return clips.length === 1 ? await indirBuf(clips[0]) : await birlestir(clips, sureSn)
}

async function pollTask(id, maxMs = 6 * 60 * 1000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    await sleep(7000)
    const r = await fetch(`${C.evolink.baseUrl}/v1/videos/generations/${id}`, {
      headers: { 'Authorization': `Bearer ${C.evolink.apiKey}` }
    })
    if (!r.ok) continue
    const d = await r.json()
    console.log(`[Poll] ${id}: ${d.status}`)
    if (d.status === 'succeeded' || d.status === 'completed') {
      return d.video_url || d.output?.url || d.result?.url
    }
    if (d.status === 'failed' || d.status === 'error') throw new Error(`Task başarısız: ${d.error}`)
  }
  throw new Error('Zaman aşımı')
}

async function indirBuf(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`İndirme hata: ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

async function birlestir(urls, sureSn) {
  const dosyalar = []
  const liste    = tmp('liste', 'txt')
  const cikti    = tmp('birlesik')
  for (const url of urls) {
    const p = tmp('clip')
    fs.writeFileSync(p, await indirBuf(url))
    dosyalar.push(p)
  }
  fs.writeFileSync(liste, dosyalar.map(f => `file '${f}'`).join('\n'))
  await ffRun(c => c
    .input(liste).inputOptions(['-f', 'concat', '-safe', '0'])
    .outputOptions(['-c:v', 'libx264', '-t', String(sureSn), '-y'])
    .output(cikti))
  const buf = fs.readFileSync(cikti)
  ;[...dosyalar, liste, cikti].forEach(tryDel)
  return buf
}

// ─── FFmpeg: Final Video ──────────────────────────────────────────────────────

async function finalYorum(videoBuf, sesBuf, sureSn) {
  const vp = tmp('vid'); const sp = tmp('ses', 'mp3'); const op = tmp('out')
  fs.writeFileSync(vp, videoBuf)
  fs.writeFileSync(sp, sesBuf)

  await ffRun(c => c
    .input(vp).input(sp)
    .complexFilter([
      `[0:v]loop=-1:1,trim=duration=${sureSn + 1},setpts=PTS-STARTPTS,` +
      `drawtext=text='📢 EsnafAjan':fontsize=16:fontcolor=white:` +
      `x=w-tw-15:y=15:shadowcolor=black@0.8:shadowx=1:shadowy=1[out]`,
    ], 'out')
    .outputOptions(['-map', '[out]', '-map', '1:a', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', `-t`, String(sureSn + 1), '-y'])
    .output(op))

  const buf = fs.readFileSync(op)
  ;[vp, sp, op].forEach(tryDel)
  return buf
}

async function finalReels(videoBuf, sureSn) {
  const vp = tmp('vid'); const op = tmp('out')
  fs.writeFileSync(vp, videoBuf)

  await ffRun(c => c
    .input(vp)
    .complexFilter([
      `[0:v]loop=-1:1,trim=duration=${sureSn},setpts=PTS-STARTPTS,` +
      `drawtext=text='📢 EsnafAjan':fontsize=16:fontcolor=white:` +
      `x=w-tw-15:y=15:shadowcolor=black@0.8:shadowx=1:shadowy=1[out]`,
    ], 'out')
    .outputOptions(['-map', '[out]', '-c:v', 'libx264', '-t', String(sureSn), '-y'])
    .output(op))

  const buf = fs.readFileSync(op)
  ;[vp, op].forEach(tryDel)
  return buf
}

// ─── Pipeline 1: Google Yorum ─────────────────────────────────────────────────

async function yorumPipeline(sessionId) {
  const s = await getSession(sessionId)
  if (!s) return

  try {
    await patch(sessionId, { status: 'processing', progress: 5, asama: 'Yorum düzenleniyor...' })
    const metin = await temizleYorum(s.yorum, s.isletme)
    console.log(`[Claude] ${metin}`)

    await patch(sessionId, { progress: 20, asama: 'Ses üretiliyor...', temizMetin: metin })
    const sesBuf = await tts(metin, s.sesSecimi)
    const sureSn = await sesSuresi(sesBuf)
    console.log(`[ElevenLabs] ${sureSn}sn`)

    await patch(sessionId, { progress: 35, asama: 'Video üretiliyor...' })
    const vidBuf = await seedance(s.photos, sureSn, s.prompt)

    await patch(sessionId, { progress: 85, asama: 'Video tamamlanıyor...' })
    const final = await finalYorum(vidBuf, sesBuf, sureSn)

    const token = crypto.randomBytes(20).toString('hex')
    await redis.setEx(`dl:${token}`, 86400, final.toString('base64'))

    await patch(sessionId, {
      status: 'completed', progress: 100,
      downloadUrl: `${C.backendUrl}/api/download/${token}`,
      completedAt: new Date().toISOString(),
    })
    console.log(`[Yorum] ✓ ${sessionId}`)
  } catch (e) {
    console.error(`[Yorum] ✗`, e.message)
    await patch(sessionId, { status: 'failed', error: e.message })
  }
}

// ─── Pipeline 2: Reels ────────────────────────────────────────────────────────

async function reelsPipeline(sessionId) {
  const s = await getSession(sessionId)
  if (!s) return

  try {
    await patch(sessionId, { status: 'processing', progress: 10, asama: 'Video üretiliyor...' })
    const sureSn = s.plan === 'reels_30s' ? 30 : 15
    const vidBuf = await seedance(s.photos, sureSn, s.prompt)

    await patch(sessionId, { progress: 85, asama: 'Video tamamlanıyor...' })
    const final = await finalReels(vidBuf, sureSn)

    const token = crypto.randomBytes(20).toString('hex')
    await redis.setEx(`dl:${token}`, 86400, final.toString('base64'))

    await patch(sessionId, {
      status: 'completed', progress: 100,
      downloadUrl: `${C.backendUrl}/api/download/${token}`,
      completedAt: new Date().toISOString(),
    })
    console.log(`[Reels] ✓ ${sessionId}`)
  } catch (e) {
    console.error(`[Reels] ✗`, e.message)
    await patch(sessionId, { status: 'failed', error: e.message })
  }
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express()
app.use('/api/webhook', express.raw({ type: 'application/json' }))
app.use(express.json({ limit: '20mb' }))
app.use((_, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'Content-Type')
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  next()
})

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (_, f, cb) => cb(null, f.mimetype.startsWith('image/')),
})

// POST /api/session/yorum
app.post('/api/session/yorum', upload.array('photos', 5), async (req, res) => {
  try {
    const { yorum, sesSecimi, isletme, paket, prompt } = req.body
    if (!req.files?.length)           return res.status(400).json({ error: 'En az 1 fotoğraf gerekli' })
    if (!yorum || yorum.length < 10)  return res.status(400).json({ error: 'Yorum çok kısa' })
    if (!sesSecimi)                   return res.status(400).json({ error: 'Ses seçimi zorunlu' })

    const id     = `sess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
    const variant = paket || 'yorum_tek'

    await saveSession(id, {
      id, tip: 'yorum', variant,
      photos:    req.files.map(f => f.buffer.toString('base64')),
      yorum, sesSecimi,
      isletme:   isletme || '',
      prompt:    prompt || '',
      status:    'pending_payment', progress: 0,
      createdAt: new Date().toISOString(),
    })

    res.json({ sessionId: id, checkoutUrl: checkoutUrl(variant, id, 'yorum') })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/session/reels
app.post('/api/session/reels', upload.array('photos', 5), async (req, res) => {
  try {
    const { plan, musicTrackId, prompt } = req.body
    if (!req.files || req.files.length < 2) return res.status(400).json({ error: 'En az 2 fotoğraf gerekli' })

    const id      = `sess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
    const variant = plan || 'reels_15s'

    await saveSession(id, {
      id, tip: 'reels', variant, plan: variant,
      photos:    req.files.map(f => f.buffer.toString('base64')),
      musicTrackId: musicTrackId || '',
      prompt:    prompt || '',
      status:    'pending_payment', progress: 0,
      createdAt: new Date().toISOString(),
    })

    res.json({ sessionId: id, checkoutUrl: checkoutUrl(variant, id, 'reels') })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/webhook/ls
app.post('/api/webhook/ls', async (req, res) => {
  try {
    const sig = req.headers['x-signature']
    if (!sig || !verifySig(req.body, sig)) return res.status(401).json({ error: 'İmza geçersiz' })

    const payload = JSON.parse(req.body.toString())
    if (payload.meta?.event_name !== 'order_created') return res.json({ ok: true, skip: true })
    if (payload.data?.attributes?.status !== 'paid')  return res.json({ ok: true, skip: true })

    const custom    = payload.meta?.custom_data || {}
    const sessionId = custom.session_id
    const tip       = custom.tip

    if (!sessionId) return res.status(400).json({ error: 'session_id yok' })

    const s = await getSession(sessionId)
    if (!s) return res.status(404).json({ error: 'Session yok' })
    if (s.status !== 'pending_payment') return res.json({ ok: true, duplicate: true })

    await patch(sessionId, { status: 'queued', paidAt: new Date().toISOString() })

    // Pipeline'ı başlat
    if (tip === 'yorum') yorumPipeline(sessionId)
    else reelsPipeline(sessionId)

    res.json({ ok: true })
  } catch (e) {
    console.error('[Webhook]', e)
    res.status(500).json({ error: 'Webhook hatası' })
  }
})

// GET /api/session/:id
app.get('/api/session/:id', async (req, res) => {
  try {
    const s = await getSession(req.params.id)
    if (!s) return res.status(404).json({ error: 'Bulunamadı' })
    res.json({ status: s.status, progress: s.progress, asama: s.asama, downloadUrl: s.downloadUrl, temizMetin: s.temizMetin, error: s.error })
  } catch { res.status(500).json({ error: 'Hata' }) }
})

// GET /api/download/:token
app.get('/api/download/:token', async (req, res) => {
  try {
    const b64 = await redis.get(`dl:${req.params.token}`)
    if (!b64) return res.status(404).json({ error: 'Link geçersiz' })
    const buf = Buffer.from(b64, 'base64')
    res.set({ 'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename="esnafajan.mp4"', 'Content-Length': buf.length })
    res.send(buf)
  } catch { res.status(500).json({ error: 'Hata' }) }
})

// GET /api/music
app.get('/api/music', (_, res) => res.json({ tracks: [
  { id: 'demo-1', title: 'Upbeat Morning',  artist: 'EsnafAjan', bpm: 120 },
  { id: 'demo-2', title: 'City Vibes',      artist: 'EsnafAjan', bpm: 110 },
  { id: 'demo-3', title: 'Fresh Start',     artist: 'EsnafAjan', bpm: 128 },
  { id: 'demo-4', title: 'Summer Flavors',  artist: 'EsnafAjan', bpm: 115 },
  { id: 'demo-5', title: 'Evening Hustle',  artist: 'EsnafAjan', bpm: 105 },
]}))

app.get('/health', (_, res) => res.json({
  status: 'ok',
  evolink:    !!C.evolink.apiKey,
  elevenlabs: !!C.elevenlabs.apiKey,
  anthropic:  !!C.anthropic.apiKey,
}))

app.listen(C.port, () => {
  console.log(`\nEsnafAjan → http://localhost:${C.port}`)
  console.log(`  Evolink:    ${C.evolink.apiKey    ? '✓' : '✗ EKSİK'}`)
  console.log(`  ElevenLabs: ${C.elevenlabs.apiKey ? '✓' : '✗ EKSİK'}`)
  console.log(`  Anthropic:  ${C.anthropic.apiKey  ? '✓' : '✗ EKSİK'}`)
})

function tmp(n, e = 'mp4') { return `/tmp/ea_${n}_${Date.now()}_${Math.random().toString(36).slice(2)}.${e}` }
function tryDel(p) { try { fs.unlinkSync(p) } catch {} }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function ffRun(cfg) { return new Promise((ok, err) => cfg(ffmpeg()).on('end', ok).on('error', err).run()) }
