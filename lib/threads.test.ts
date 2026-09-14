import assert from 'node:assert/strict'
import { applyThreadFlagDeltas } from './threads.ts'

type Counts = {
  threadId: string
  unreadCount: number
  starredCount: number
  inboxCount: number
  archivedCount: number
  trashedCount: number
}

type Message = {
  id: string
  threadId: string | null
  read: boolean
  starred: boolean
  archived: boolean
  trashed: boolean
}

function thread(over: Partial<Counts> = {}): Counts {
  return {
    threadId: 't1',
    unreadCount: 6,
    starredCount: 0,
    inboxCount: 9,
    archivedCount: 0,
    trashedCount: 0,
    ...over,
  }
}

function message(id: string, over: Partial<Message> = {}): Message {
  return {
    id,
    threadId: 't1',
    read: false,
    starred: false,
    archived: false,
    trashed: false,
    ...over,
  }
}

// Opening a conversation marks its unread members read: the row must stop being bold now,
// not on the next poll ninety seconds later.
const opened = applyThreadFlagDeltas(
  [thread()],
  [message('a'), message('b'), message('c', { read: true })],
  ['a', 'b', 'c'],
  { read: true },
)
assert.equal(opened[0].unreadCount, 4, 'only the two that were actually unread come off the count')

// Only the loaded members move the figure, and the ones not loaded are not invented: a
// recount would have reported this nine-message conversation as holding one.
const partial = applyThreadFlagDeltas([thread()], [message('a')], ['a'], { read: true })
assert.equal(partial[0].unreadCount, 5)
assert.equal(partial[0].inboxCount, 9, 'a bucket the change does not touch is left alone')

// Archiving takes the conversation out of the inbox list and into the archive one.
const archived = applyThreadFlagDeltas([thread({ inboxCount: 1 })], [message('a')], ['a'], { archived: true })
assert.equal(archived[0].inboxCount, 0)
assert.equal(archived[0].archivedCount, 1)

// Trashing pulls the message out of unread and starred too, because the server's summary
// counts both only outside the bin.
const trashed = applyThreadFlagDeltas(
  [thread({ unreadCount: 1, starredCount: 1, inboxCount: 1 })],
  [message('a', { starred: true })],
  ['a'],
  { trashed: true },
)
assert.deepEqual(
  {
    unread: trashed[0].unreadCount,
    starred: trashed[0].starredCount,
    inbox: trashed[0].inboxCount,
    binned: trashed[0].trashedCount,
  },
  { unread: 0, starred: 0, inbox: 0, binned: 1 },
)

// A count can never be talked below zero by a message the summary did not know about.
const floored = applyThreadFlagDeltas([thread({ unreadCount: 0 })], [message('a')], ['a'], { read: true })
assert.equal(floored[0].unreadCount, 0)

// Another conversation's message, an unthreaded one, and an id outside the change all
// leave the row exactly as it was.
const rows = [thread()]
assert.equal(applyThreadFlagDeltas(rows, [message('a', { threadId: 't2' })], ['a'], { read: true })[0], rows[0])
assert.equal(applyThreadFlagDeltas(rows, [message('a', { threadId: null })], ['a'], { read: true })[0], rows[0])
assert.equal(applyThreadFlagDeltas(rows, [message('b')], ['a'], { read: true })[0], rows[0])

console.log('threads: ok')
