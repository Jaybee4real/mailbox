import { describeDevice } from './two-factor'

const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
]
const CLOUDFLARE_V6 = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
]

function v4ToNumber(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!/^\d{1,3}$/.test(part) || octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

function v6ToBigInt(address: string): bigint | null {
  if (!address.includes(':')) return null
  const [head, tail = ''] = address.split('::')
  const headParts = head ? head.split(':') : []
  const tailParts = tail ? tail.split(':') : []
  const missing = 8 - headParts.length - tailParts.length
  if (missing < 0 || (!address.includes('::') && missing !== 0)) return null
  const groups = [...headParts, ...Array(missing).fill('0'), ...tailParts]
  let value = BigInt(0)
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
    value = (value << BigInt(16)) + BigInt(parseInt(group, 16))
  }
  return value
}

export function isCloudflareAddress(address: string): boolean {
  const v4 = v4ToNumber(address.replace(/^::ffff:/, ''))
  if (v4 !== null) {
    return CLOUDFLARE_V4.some(range => {
      const [base, bits] = range.split('/')
      const start = v4ToNumber(base)!
      return v4 >= start && v4 < start + 2 ** (32 - Number(bits))
    })
  }
  const v6 = v6ToBigInt(address)
  if (v6 === null) return false
  return CLOUDFLARE_V6.some(range => {
    const [base, bits] = range.split('/')
    const shift = BigInt(128 - Number(bits))
    return v6 >> shift === v6ToBigInt(base)! >> shift
  })
}

export function clientIp(req: Request): string | null {
  const forwarded = (req.headers.get('x-forwarded-for') ?? '').split(',').map(part => part.trim()).filter(Boolean)
  const peer = req.headers.get('x-real-ip') || forwarded[forwarded.length - 1] || null
  const viaCloudflare = req.headers.get('cf-connecting-ip')
  if (peer && viaCloudflare && isCloudflareAddress(peer)) return viaCloudflare.trim()
  return forwarded[0] || peer
}

export type VisitorContext = {
  ip: string | null
  userAgent: string | null
  device: string
  country: string | null
  region: string | null
  city: string | null
  timezone: string | null
  language: string | null
}

const header = (req: Request, name: string) => {
  const value = req.headers.get(name)?.trim()
  return value && value !== 'XX' && value !== 'T1' ? value : null
}

export function visitorContext(req: Request): VisitorContext {
  const userAgent = req.headers.get('user-agent')
  const fromCloudflare = isCloudflareAddress(req.headers.get('x-real-ip') ?? '')
  const geo = (name: string) => (fromCloudflare ? header(req, name) : null)
  return {
    ip: clientIp(req),
    userAgent,
    device: describeDevice(userAgent ?? ''),
    country: geo('cf-ipcountry'),
    region: geo('cf-region'),
    city: geo('cf-ipcity'),
    timezone: geo('cf-timezone'),
    language: (req.headers.get('accept-language') ?? '').split(',')[0].trim() || null,
  }
}

export function describeLocation(context: { city?: string | null; region?: string | null; country?: string | null }): string | null {
  const parts = [context.city, context.region, context.country].filter((part, index, all) => part && all.indexOf(part) === index)
  return parts.length ? parts.join(', ') : null
}

const headerSafe = (value: string) =>
  value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().slice(0, 300)

export function originHeaders(context: VisitorContext): Record<string, string> {
  const location = describeLocation(context)
  const headers: Record<string, string> = {}
  if (context.ip) headers['X-Originating-IP'] = `[${headerSafe(context.ip)}]`
  headers['X-Sender-Device'] = headerSafe(context.device)
  if (location) headers['X-Sender-Location'] = headerSafe(context.timezone ? `${location} (${context.timezone})` : location)
  if (context.language) headers['X-Sender-Language'] = headerSafe(context.language)
  if (context.userAgent) headers['X-Sender-User-Agent'] = headerSafe(context.userAgent)
  return headers
}
