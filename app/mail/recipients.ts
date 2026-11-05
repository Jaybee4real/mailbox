export function parseAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/)
  return (match ? match[1] : raw).trim()
}

export function uniqueAddresses(addresses: string[]): string[] {
  const seen = new Set<string>()
  return addresses.filter(address => {
    const key = address.toLowerCase()
    if (!address || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export type ReplyableMessage = { from: string; to: string[]; cc: string[]; replyTo: string[] }

export function replyFor(message: ReplyableMessage, self: Set<string>): string[] {
  const primary = message.replyTo.length ? parseAddress(message.replyTo[0]) : parseAddress(message.from)
  if (primary && !self.has(primary.toLowerCase())) return [primary]
  return uniqueAddresses(message.to.map(parseAddress)).filter(address => Boolean(address) && !self.has(address.toLowerCase()))
}

export function replyAllFor(message: ReplyableMessage, self: Set<string>): { to: string[]; cc: string[] } {
  const notSelf = (address: string) => Boolean(address) && !self.has(address.toLowerCase())
  const primary = message.replyTo.length ? parseAddress(message.replyTo[0]) : parseAddress(message.from)
  const to = uniqueAddresses([primary, ...message.to.map(parseAddress)]).filter(notSelf)
  const taken = new Set(to.map(address => address.toLowerCase()))
  const cc = uniqueAddresses(message.cc.map(parseAddress)).filter(address => notSelf(address) && !taken.has(address.toLowerCase()))
  return { to, cc }
}
