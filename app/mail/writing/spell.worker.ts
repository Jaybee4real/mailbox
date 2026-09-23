import nspell from 'nspell'

type Request =
  | { id: number; type: 'check'; language: string; words: string[] }
  | { id: number; type: 'suggest'; language: string; word: string }

let checker: ReturnType<typeof nspell> | null = null
let loaded = ''
let loading: Promise<void> | null = null

async function ready(language: string) {
  if (checker && loaded === language) return
  if (!loading || loaded !== language) {
    loaded = language
    loading = Promise.all([
      fetch(`/dictionaries/${language}.aff`).then(response => response.text()),
      fetch(`/dictionaries/${language}.dic`).then(response => response.text()),
    ]).then(([aff, dic]) => {
      checker = nspell(aff, dic)
    })
  }
  await loading
}

const plain = (word: string) => word.replace(/’/g, "'")

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data
  try {
    await ready(request.language)
    if (request.type === 'check') {
      const wrong = request.words.filter(word => !checker!.correct(plain(word)))
      postMessage({ id: request.id, wrong })
    } else {
      postMessage({ id: request.id, suggestions: checker!.suggest(plain(request.word)).slice(0, 6) })
    }
  } catch (err) {
    postMessage({ id: request.id, error: String(err) })
  }
}
