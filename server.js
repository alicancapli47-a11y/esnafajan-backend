/**
 * EsnafAjan — Backend
 * Ödeme: Lemon Squeezy
 * Video:  Evolink / Seedance 2.0
 * Müzik:  Epidemic Sound
 */

import express    from 'express'
import multer     from 'multer'
import crypto     from 'crypto'
import { Queue, Worker }                                    from 'bullmq'
import { createClient }                                     from 'redis'
import { S3Client, PutObjectCommand, GetObjectCommand }     from '@aws-sdk/client-s3'
import { getSignedUrl }                                     from '@aws-sdk/s3-request-presigner'
import ffmpeg     from 'fluent-ffmpeg'
import fetch      from 'node-fetch'
import FormData   from 'form-data'
import fs         from 'fs'

// ─── Config ───────────────────────────────────────────────────────────────────

const config = {
  port: parseInt(process.env.PORT || '3000'),

  lemonSqueezy: {
    webhookSecret: process.env.LS_WEBHOOK_SECRET,
    variants: {
      '15s': process.env.LS_VARIANT_15S,
      '30s': process.env.LS_VARIANT_30S,
    },
    checkoutBase: process.env.LS_CHECKOUT_BASE,
  },

  evolink: {
    baseUrl: process.env.EVOLINK_BASE_URL || 'https://api.evolink.ai',
    apiKey:  process.env.EVOLINK_API_KEY,
  },

  epidemicSound: {
    baseUrl: 'https://api.epidemicsound.com',
    apiKey:  process.env.EPIDEMIC_SOUND_API_KEY,
  },

  s3: {
    bucket: process.env.S3_BUCKET  || 'esnafajan-media',
    region: process.env.AWS_REGION || 'eu-central-1',
  },

  redis: { url: process.env.REDIS_URL || 'redis://localhost:6379' },

  session: { ttlSeconds: 60 * 60 * 2 },

  plans: {
    '15s': { durationSec: 15 },
    '30s': { durationSec: 30 },
  },
}

// ─── Redis ────────────────────────────────────────────────────────────────────

const redis = createClient({ url: config.redis.url })
await redis.connect()

async function saveSession(id, data) {
  await redis.setEx(`session:${id}`, config.session.ttlSeconds, JSON.stringify(data))
}
async function getSession(id) {
  const raw = await redis.get(`session:${id}`)
  return raw ? JSON.parse(raw) : null
}
async function updateSession(id, patch) {
  const s = await getSession(id)
  if (!s) throw new Error(`Session bulunamadı: ${id}`)
  await saveSession(id, { ...s, ...patch })
}

// ─── S3 ───────────────────────────────────────────────────────────────────────

const s3 = new S3Client({ region: config.s3.region })

async function uploadToS3(buffer, key, contentType = 'image/jpeg') {
  await s3.send(new PutObjectCommand({
    Bucket: config.s3.bucket, Key: key, Body: buffer, ContentType: contentType,
  }))
  return `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com/${key}`
}

async function getPresignedUrl(key) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }),
    { expiresIn: 86400 }
  )
}

// ─── Lemon Squeezy ────────────────────────────────────────────────────────────

function buildCheckoutUrl(plan, sessionId) {
  const variantId = config.lemonSqueezy.variants[plan]
  if (!variantId) throw new Error(`LS variant ayarlanmamış: ${plan}`)
  const params = new URLSearchParams({
    'checkout[custom][session_id]': sessionId,
    'checkout[custom][plan]': plan,
  })
  return `${config.lemonSqueezy.checkoutBase}/${variantId}?${params}`
}

function verifyLsSignature(rawBody, signature) {
  const expected = crypto
    .createHmac('sha256', config.lemonSqueezy.webhookSecret)
    .update(rawBody)
    .digest('hex')
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}

// ─── Evolink / Seedance 2.0 ───────────────────────────────────────────────────

async function uploadImageToEvolink(buffer, filename) {
  const form = new FormData()
  form.append('file', buffer, { filename, contentType: 'image/jpeg' })
  const res = await fetch(`${config.evolink.baseUrl}/v1/files/upload`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.evolink.apiKey}`, ...form.getHeaders() },
    body: form,
  })
  if (!res.ok) throw new Error(`Evolink upload hata: ${res.status} ${await res.text()}`)
  return (await res.json()).url
}

async function generateVideoWithSeedance(referenceUrl, contentUrls, durationSec, prompt) {
  const clips = []
  const callCount = durationSec / 15

  for (let i = 0; i < callCount; i++) {
    const imageUrl = i === 0 ? referenceUrl : (contentUrls[i] ?? contentUrls.at(-1))
    const res = await fetch(`${config.evolink.baseUrl}/v1/video/generate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.evolink.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'seedance-v2',
        image_url: imageUrl,
        reference_image_url: referenceUrl,
        duration: 15,
        aspect_ratio: '9:16',
        quality: 'high',
        prompt: prompt || 'Cinematic restaurant reel, smooth camera movement, warm lighting',
      }),
    })
    if (!res.ok) throw new Error(`Seedance hata: ${res.status} ${await res.text()}`)
    const task = await res.json()
    clips.push(await pollVideoTask(task.task_id))
  }

  if (clips.length === 1) return { type: 'url', value: clips[0] }
  return { type: 'buffer', value: await mergeVideoClips(clips) }
}

async function pollVideoTask(taskId, maxMs = 4 * 60 * 1000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const res  = await fetch(`${config.evolink.baseUrl}/v1/video/tasks/${taskId}`, {
      headers: { 'Authorization': `Bearer ${config.evolink.apiKey}` },
    })
    const data = await res.json()
    if (data.status === 'completed') return data.video_url
    if (data.status === 'failed')    throw new Error(`Task başarısız: ${data.error}`)
    await sleep(5000)
  }
  throw new Error('Video üretimi zaman aşımı')
}

// ─── FFmpeg ───────────────────────────────────────────────────────────────────

async function mergeVideoClips(urls) {
  const clips  = []
  const list   = tmp('list', 'txt')
  const output = tmp('merged')

  for (const url of urls) {
    const p = tmp('clip')
    fs.writeFileSync(p, Buffer.from(await (await fetch(url)).arrayBuffer()))
    clips.push(p)
  }
  fs.writeFileSync(list, clips.map(f => `file '${f}'`).join('\n'))

  await ffmpegRun(cmd => cmd
    .input(list).inputOptions(['-f', 'concat', '-safe', '0'])
    .outputOptions(['-c', 'copy'])
    .output(output))

  const buf = fs.readFileSync(output)
  ;[...clips, list, output].forEach(tryUnlink)
  return buf
}

async function addMusicToVideo(videoSource, musicTrackId, durationSec) {
  const videoPath  = tmp('video')
  const musicPath  = tmp('music', 'mp3')
  const outputPath = tmp('final')

  const mRes = await fetch(
    `${config.epidemicSound.baseUrl}/v1/tracks/${musicTrackId}/download`,
    { headers: { 'Authorization': `Bearer ${config.epidemicSound.apiKey}` } }
  )
  if (!mRes.ok) throw new Error(`Müzik indirme hata: ${mRes.status}`)
  fs.writeFileSync(musicPath, Buffer.from(await mRes.arrayBuffer()))

  if (Buffer.isBuffer(videoSource)) {
    fs.writeFileSync(videoPath, videoSource)
  } else {
    fs.writeFileSync(videoPath, Buffer.from(await (await fetch(videoSource)).arrayBuffer()))
  }

  await ffmpegRun(cmd => cmd
    .input(videoPath).input(musicPath)
    .outputOptions([
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-map', '0:v:0', '-map', '1:a:0', '-shortest', '-t', String(durationSec),
    ])
    .output(outputPath))

  const buf = fs.readFileSync(outputPath)
  ;[videoPath, musicPath, outputPath].forEach(tryUnlink)
  return buf
}

function ffmpegRun(configure) {
  return new Promise((resolve, reject) => {
    configure(ffmpeg()).on('end', resolve).on('error', reject).run()
  })
}

// ─── BullMQ Worker ────────────────────────────────────────────────────────────

const reelQueue = new Queue('reel-generation', {
  connection: { url: config.redis.url },
})

new Worker('reel-generation', async (job) => {
  const { sessionId } = job.data
  const session = await getSession(sessionId)
  if (!session) throw new Error(`Session bulunamadı: ${sessionId}`)

  const { plan, photoKeys, musicTrackId, prompt } = session
  const { durationSec } = config.plans[plan]

  const progress = async (p) => {
    await job.updateProgress(p)
    await updateSession(sessionId, { progress: p, status: p < 100 ? 'processing' : 'completed' })
  }

  await progress(5)
  console.log(`[Job ${job.id}] ${sessionId} | ${plan}`)

  // 1. S3 → Evolink
  const evolinkUrls = []
  for (const key of photoKeys) {
    const url = `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com/${key}`
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
    evolinkUrls.push(await uploadImageToEvolink(buf, key.split('/').pop()))
  }
  await progress(20)

  // 2. Video üret
  const [refUrl, ...contentUrls] = evolinkUrls
  const videoResult = await generateVideoWithSeedance(refUrl, contentUrls, durationSec, prompt)
  await progress(70)

  // 3. Müzik ekle
  const finalBuf = await addMusicToVideo(videoResult.value, musicTrackId, durationSec)
  await progress(90)

  // 4. S3'e yükle
  const outputKey = `reels/${sessionId}/final.mp4`
  await uploadToS3(finalBuf, outputKey, 'video/mp4')
  const downloadUrl = await getPresignedUrl(outputKey)

  await updateSession(sessionId, {
    status: 'completed', progress: 100,
    outputKey, downloadUrl,
    completedAt: new Date().toISOString(),
  })
  await progress(100)
  return { downloadUrl }

}, {
  connection: { url: config.redis.url },
  concurrency: 3,
}).on('failed', async (job, err) => {
  console.error(`[Job ${job?.id}] Hata:`, err.message)
  if (job?.data?.sessionId) {
    await updateSession(job.data.sessionId, { status: 'failed', error: err.message }).catch(() => {})
  }
})

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express()
app.use('/api/webhook', express.raw({ type: 'application/json' }))
app.use(express.json({ limit: '1mb' }))

// CORS — Vercel frontend'inden istek gelecek
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'Content-Type')
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 5 },
  fileFilter: (_, file, cb) => cb(null, file.mimetype.startsWith('image/')),
})

// ── POST /api/session ─────────────────────────────────────────────────────────
app.post('/api/session', upload.array('photos', 5), async (req, res) => {
  try {
    const { plan, musicTrackId, prompt } = req.body
    const files = req.files

    if (!config.plans[plan])
      return res.status(400).json({ error: 'Geçersiz plan. "15s" veya "30s" olmalı.' })
    if (!files || files.length < 2)
      return res.status(400).json({ error: 'En az 2 fotoğraf gerekli.' })
    if (!musicTrackId)
      return res.status(400).json({ error: 'Müzik seçimi zorunlu.' })

    const sessionId = `sess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`

    const photoKeys = []
    for (let i = 0; i < files.length; i++) {
      const ext = files[i].originalname.split('.').pop() || 'jpg'
      const key = `sessions/${sessionId}/photo_${i}.${ext}`
      await uploadToS3(files[i].buffer, key, files[i].mimetype)
      photoKeys.push(key)
    }

    await saveSession(sessionId, {
      sessionId, plan, photoKeys, musicTrackId,
      prompt: prompt || '',
      status: 'pending_payment',
      progress: 0,
      createdAt: new Date().toISOString(),
    })

    const checkoutUrl = buildCheckoutUrl(plan, sessionId)
    console.log(`[Session] ${sessionId} | ${plan} | ${files.length} fotoğraf`)

    res.json({ sessionId, checkoutUrl, expiresIn: config.session.ttlSeconds })
  } catch (err) {
    console.error('[/api/session]', err)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /api/webhook/ls ──────────────────────────────────────────────────────
app.post('/api/webhook/ls', async (req, res) => {
  try {
    const signature = req.headers['x-signature']
    if (!signature) return res.status(401).json({ error: 'İmza eksik' })
    if (!verifyLsSignature(req.body, signature))
      return res.status(401).json({ error: 'Geçersiz imza' })

    const payload   = JSON.parse(req.body.toString())
    const eventName = payload.meta?.event_name

    if (eventName !== 'order_created') return res.json({ received: true, skipped: true })

    const order = payload.data
    if (order?.attributes?.status !== 'paid') return res.json({ received: true, skipped: true })

    const customData = payload.meta?.custom_data || {}
    const sessionId  = customData.session_id

    if (!sessionId) {
      console.error('[Webhook] session_id yok:', customData)
      return res.status(400).json({ error: 'session_id eksik' })
    }

    const session = await getSession(sessionId)
    if (!session) return res.status(404).json({ error: 'Session bulunamadı' })

    if (session.status !== 'pending_payment') {
      return res.json({ received: true, duplicate: true })
    }

    await updateSession(sessionId, {
      status: 'queued',
      lsOrderId: order?.id,
      paidAt: new Date().toISOString(),
    })

    const job = await reelQueue.add(
      'generate-reel',
      { sessionId },
      {
        attempts: 2,
        backoff: { type: 'exponential', delay: 15000 },
        jobId: `reel-${sessionId}`,
      }
    )

    console.log(`[Webhook] Order ${order?.id} → Session ${sessionId} → Job ${job.id}`)
    res.json({ received: true, jobId: job.id })
  } catch (err) {
    console.error('[Webhook]', err)
    res.status(500).json({ error: 'Webhook işlenemedi' })
  }
})

// ── GET /api/session/:id ──────────────────────────────────────────────────────
app.get('/api/session/:sessionId', async (req, res) => {
  try {
    const session = await getSession(req.params.sessionId)
    if (!session) return res.status(404).json({ error: 'Session bulunamadı' })
    const { status, progress, downloadUrl, error } = session
    res.json({ status, progress, downloadUrl, error })
  } catch (err) {
    res.status(500).json({ error: 'Durum alınamadı' })
  }
})

// ── GET /api/music/trending ───────────────────────────────────────────────────
app.get('/api/music/trending', async (req, res) => {
  try {
    const r    = await fetch(
      `${config.epidemicSound.baseUrl}/v1/tracks?tags=trending,upbeat&limit=24`,
      { headers: { 'Authorization': `Bearer ${config.epidemicSound.apiKey}` } }
    )
    const data = await r.json()
    res.json({
      tracks: (data.results || []).map(t => ({
        id:          t.id,
        title:       t.title,
        artist:      t.artist?.name,
        durationSec: t.length,
        bpm:         t.bpm,
        previewUrl:  t.stems?.find(s => s.type === 'full')?.lqMp3Url,
        coverUrl:    t.coverArt?.original,
      })),
    })
  } catch (err) {
    res.status(500).json({ error: 'Müzik listesi alınamadı' })
  }
})

// ── Sağlık kontrolü ───────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok' }))

app.listen(config.port, () => {
  console.log(`\nEsnafAjan backend çalışıyor → http://localhost:${config.port}`)
})

// ─── Yardımcılar ──────────────────────────────────────────────────────────────

function tmp(name, ext = 'mp4') {
  return `/tmp/${name}_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
}
function tryUnlink(p) { try { fs.unlinkSync(p) } catch {} }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
