import { parseRangeHeader, RangeNotSatisfiableError } from '../dist/modules/vault/vault-stream.js'

const T = 1000n
const cases = [
  [undefined, null],
  ['bytes=0-99', { s: '0', e: '99' }],
  ['bytes=900-', { s: '900', e: '999' }],
  ['bytes=-100', { s: '900', e: '999' }],
  ['bytes=0-9999', { s: '0', e: '999' }],
  ['bytes=500-499', 'ERR'],
  ['bytes=2000-3000', 'ERR'],
  ['bytes=-5000', { s: '0', e: '999' }], // RFC 7233: oversized suffix range clamps to whole file
  ['junk', null],
]
let pass = 0
for (const [hdr, want] of cases) {
  let got
  try {
    const r = parseRangeHeader(hdr, T)
    got = r ? { s: r.start.toString(), e: r.end.toString() } : null
  } catch (e) {
    got = e instanceof RangeNotSatisfiableError ? 'ERR' : 'THROW: ' + e.message
  }
  const ok = JSON.stringify(got) === JSON.stringify(want)
  pass += ok ? 1 : 0
  console.log(ok ? 'PASS' : 'FAIL', String(hdr), '=>', JSON.stringify(got), '(want', JSON.stringify(want) + ')')
}
console.log(pass + '/' + cases.length, 'passed')
process.exit(pass === cases.length ? 0 : 1)
