import http from 'node:http'
import { createRequire } from 'node:module'
import { listZipEntries, srtToVtt, findSidecarSubtitle, sortAZ } from '/tmp/stage-test/stage.mjs'

const zipPath = process.argv[2]
const zipBytes = (await import('node:fs')).readFileSync(zipPath)

const server = http.createServer((req, res) => {
  const range = req.headers.range
  const match = range && /^bytes=(\d*)-(\d*)$/.exec(range)
  if (match && (match[1] !== '' || match[2] !== '')) {
    let start
    let end
    if (match[1] === '') {
      // suffix range: last N bytes
      start = Math.max(0, zipBytes.length - Number(match[2]))
      end = zipBytes.length - 1
    } else {
      start = Number(match[1])
      end = match[2] ? Number(match[2]) : zipBytes.length - 1
    }
    end = Math.min(end, zipBytes.length - 1)
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${zipBytes.length}`,
      'Content-Length': String(end - start + 1),
    })
    res.end(zipBytes.subarray(start, end + 1))
  } else {
    res.writeHead(200, { 'Content-Length': String(zipBytes.length) })
    res.end(zipBytes)
  }
})

await new Promise((resolve) => server.listen(4199, resolve))
let failed = false
try {
  const entries = await listZipEntries('http://localhost:4199/test.zip')
  console.log('ZIP entries:', entries.map((e) => `${e.name} (${e.uncompressedSize}B)`).join(', '))
  const okZip = entries.length === 4 && entries.some((e) => e.name === 'hello/') && entries.some((e) => e.name === 'hello/world.txt') && entries.some((e) => e.name === 'readme.txt')
  console.log(okZip ? 'PASS zip listing' : 'FAIL zip listing')
  if (!okZip) failed = true

  const vtt = srtToVtt('1\r\n00:00:01,000 --> 00:00:02,500\r\nHello there\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nSecond cue\r\n')
  const okVtt = vtt.startsWith('WEBVTT') && vtt.includes('00:00:01.000 --> 00:00:02.500') && vtt.includes('Hello there') && vtt.includes('Second cue')
  console.log(okVtt ? 'PASS srt->vtt' : 'FAIL srt->vtt', JSON.stringify(vtt))
  if (!okVtt) failed = true

  const queue = [{ id: '3', name: 'clip10.mp4' }, { id: '1', name: 'clip2.mp4' }, { id: '2', name: 'clip2.srt' }]
  const sub = findSidecarSubtitle(queue, queue[1]) // clip2.mp4 → clip2.srt
  const okSub = sub && sub.id === '2'
  const noSub = findSidecarSubtitle(queue, queue[0]) // clip10.mp4 has no sidecar
  console.log(okSub && !noSub ? 'PASS sidecar subtitle' : 'FAIL sidecar subtitle')
  if (!(okSub && !noSub)) failed = true

  const sorted = sortAZ(queue).map((f) => f.name)
  const okSort = JSON.stringify(sorted) === JSON.stringify(['clip2.mp4', 'clip2.srt', 'clip10.mp4'])
  console.log(okSort ? 'PASS natural A-Z sort' : 'FAIL natural A-Z sort', JSON.stringify(sorted))
  if (!okSort) failed = true
} catch (error) {
  console.error('FAIL with error:', error.message)
  failed = true
} finally {
  server.close()
}
process.exit(failed ? 1 : 0)
