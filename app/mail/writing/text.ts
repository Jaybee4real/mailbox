const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'etc', 'eg', 'ie', 'vs', 'viz', 'cf', 'al', 'approx', 'ref', 'no', 'nos', 'tel', 'fig', 'p', 'pp', 'pg',
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'hon', 'rev', 'engr', 'arc', 'barr', 'chief', 'alh', 'gen', 'capt',
  'ltd', 'plc', 'inc', 'co', 'corp', 'dept', 'est', 'attn', 'encl', 'pls',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
])

/**
 * Whether a letter typed after `before` begins a sentence. `before` is the paragraph's text
 * up to the caret. "e.g. the" and "Ltd. has" do not; "1.5" and "metroperil.com" never
 * reach here because nothing but a space follows a full stop that ends a sentence.
 */
export function startsSentence(before: string): boolean {
  if (!before.trim()) return true
  const match = before.match(/(\S*?)([.!?])["'”’)\]]*\s+$/)
  if (!match) return false
  if (match[2] !== '.') return true
  if (/\.\.$/.test(before.trimEnd().replace(/["'”’)\]]+$/, ''))) return false
  const word = match[1].replace(/^["'“‘(\[]+/, '').toLowerCase()
  if (ABBREVIATIONS.has(word)) return false
  if (/^[a-z]$/.test(word)) return false
  return !/@|\//.test(word)
}

const TYPOS: Record<string, string> = {
  teh: 'the', hte: 'the', adn: 'and', nad: 'and', taht: 'that', thta: 'that', wiht: 'with', whit: 'with',
  recieve: 'receive', recieved: 'received', reciept: 'receipt', beleive: 'believe', acheive: 'achieve',
  seperate: 'separate', seperately: 'separately', definately: 'definitely', occured: 'occurred',
  occurence: 'occurrence', untill: 'until', wich: 'which', becuase: 'because', becasue: 'because',
  thier: 'their', freind: 'friend', calender: 'calendar', accomodate: 'accommodate', acommodate: 'accommodate',
  adress: 'address', buisness: 'business', comittee: 'committee', commited: 'committed', enviroment: 'environment',
  existance: 'existence', foward: 'forward', goverment: 'government', gaurantee: 'guarantee', garantee: 'guarantee',
  immediatly: 'immediately', independant: 'independent', neccessary: 'necessary', necesary: 'necessary',
  noticable: 'noticeable', occassion: 'occasion', persue: 'pursue', posession: 'possession', prefered: 'preferred',
  premuim: 'premium', premiun: 'premium', polcy: 'policy', ploicy: 'policy', insurace: 'insurance', insurnace: 'insurance',
  renewel: 'renewal', reneval: 'renewal', recomend: 'recommend', refered: 'referred', responsability: 'responsibility',
  sincerly: 'sincerely', succesful: 'successful', sucessful: 'successful', tommorow: 'tomorrow', tomorow: 'tomorrow',
  truely: 'truly', wierd: 'weird', writting: 'writing', thanx: 'thanks', pls: 'please', plz: 'please',
  dont: "don't", doesnt: "doesn't", didnt: "didn't", cant: "can't", couldnt: "couldn't", wouldnt: "wouldn't",
  shouldnt: "shouldn't", isnt: "isn't", wasnt: "wasn't", arent: "aren't", werent: "weren't", havent: "haven't",
  hasnt: "hasn't", wont: "won't", im: "I'm", ive: "I've", youre: "you're", theyre: "they're", thats: "that's",
}

/** The correction for a mistyped word, keeping its capitals; null when the word is fine. */
export function correctWord(word: string): string | null {
  const fixed = TYPOS[word.toLowerCase()]
  if (!fixed) return null
  if (word === word.toUpperCase() && word.length > 1) return fixed.toUpperCase()
  if (word[0] === word[0].toUpperCase()) return fixed[0].toUpperCase() + fixed.slice(1)
  return fixed
}

/** "N1500000" or "NGN1500000.50" as "₦1,500,000" / "₦1,500,000.50"; null for anything else. */
export function formatNaira(token: string): string | null {
  const match = token.match(/^(?:NGN|N|₦)(\d{4,})(\.\d{1,2})?$/)
  if (!match) return null
  return `₦${Number(match[1]).toLocaleString('en-GB')}${match[2] ?? ''}`
}

/** Whether a word should be put to the dictionary at all. */
export function checkableWord(word: string, options: { ignoreCapitals: boolean; ignoreWithNumbers: boolean }): boolean {
  if (word.length < 2) return false
  if (/\d/.test(word)) return !options.ignoreWithNumbers
  if (!/^[A-Za-zÀ-ɏ'’-]+$/.test(word)) return false
  if (options.ignoreCapitals && word === word.toUpperCase()) return false
  return true
}

/** The words of a passage with their offsets, ignoring web and email addresses. */
export function wordsOf(text: string): Array<{ word: string; start: number; end: number }> {
  const out: Array<{ word: string; start: number; end: number }> = []
  const skip: Array<[number, number]> = []
  for (const match of text.matchAll(/\S+@\S+|https?:\/\/\S+|www\.\S+|\b\S+\.(?:com|ng|org|net|io|africa|co|uk)\b\S*/gi)) {
    skip.push([match.index ?? 0, (match.index ?? 0) + match[0].length])
  }
  for (const match of text.matchAll(/[A-Za-zÀ-ɏ0-9]+(?:['’-][A-Za-zÀ-ɏ0-9]+)*/g)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (skip.some(([from, to]) => start >= from && end <= to)) continue
    out.push({ word: match[0], start, end })
  }
  return out
}
