/**
 * Real files for the seeded mailbox: a message that says it carries a photo should carry
 * a photo you can open. Everything here is generated, so the repository ships no media.
 *
 * ffmpeg draws the pictures and the video when it is installed; the PDF, the spreadsheet
 * and the document are written by hand, and the rest is skipped rather than faked.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function has(command) {
  try {
    execFileSync('which', [command], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** A PDF of `pages` pages, with the byte offsets its cross-reference table has to name. */
function pdf(title, line, pages = 1) {
  const stream = `BT /F1 20 Tf 64 760 Td (${title}) Tj ET\nBT /F1 12 Tf 64 730 Td (${line}) Tj ET`
  const contentObject = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`
  const fontNumber = 3 + pages * 2

  const kids = []
  for (let page = 0; page < pages; page += 1) kids.push(`${3 + page * 2} 0 R`)

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    `<</Type/Pages/Kids[${kids.join(' ')}]/Count ${pages}>>`,
  ]
  for (let page = 0; page < pages; page += 1) {
    objects.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 ${fontNumber} 0 R>>>>/Contents ${4 + page * 2} 0 R>>`,
    )
    objects.push(contentObject)
  }
  objects.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>')

  let body = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const startxref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${startxref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

/** Writes `entries` into a directory and zips it, which is how every Office format is built. */
function zipOf(directory, label, entries) {
  if (!has('zip')) return null
  const root = join(directory, label)
  for (const [path, content] of entries) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  const out = join(directory, `${label}.zip`)
  rmSync(out, { force: true })
  const roots = [...new Set(entries.map(([path]) => path.split('/')[0]))]
  execFileSync('zip', ['-q', '-r', '-X', out, ...roots], { cwd: root })
  return readFileSync(out)
}

function docx(text, directory) {
  return zipOf(directory, 'docx', [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ],
  ])
}

/** A spreadsheet of `rowCount` rows, built as the minimal set of parts Excel will open. */
function xlsx(directory, headers, rowFor, rowCount) {
  if (headers.length > 26) throw new Error('xlsx(): single-letter columns only, add AA-style names first')
  const cellName = column => String.fromCharCode(65 + column)
  let sheet = ''
  sheet += `<row r="1">${headers.map((header, column) => `<c r="${cellName(column)}1" t="inlineStr"><is><t>${header}</t></is></c>`).join('')}</row>`
  for (let index = 0; index < rowCount; index += 1) {
    const values = rowFor(index)
    const cells = values
      .map((value, column) =>
        typeof value === 'number'
          ? `<c r="${cellName(column)}${index + 2}"><v>${value}</v></c>`
          : `<c r="${cellName(column)}${index + 2}" t="inlineStr"><is><t>${value}</t></is></c>`,
      )
      .join('')
    sheet += `<row r="${index + 2}">${cells}</row>`
  }

  return zipOf(directory, 'xlsx', [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ],
    [
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Model" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ],
    [
      'xl/worksheets/sheet1.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`,
    ],
  ])
}

/**
 * A synthetic pattern compresses almost to nothing, which left a clip named "4k" weighing
 * 30 kB however the bitrate was pinned. Per-frame grain is what gives the encoder
 * something incompressible to carry, so the file ends up the size its name implies.
 */
function clip(directory, name, size, seconds) {
  return ffmpeg(directory, name, [
    '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=25`, '-t', String(seconds),
    '-vf', 'noise=alls=32:allf=t+u', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast',
  ])
}

function ffmpeg(directory, name, args) {
  if (!has('ffmpeg')) return null
  const out = join(directory, name)
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args, out], { stdio: 'ignore' })
    return readFileSync(out)
  } catch {
    return null
  }
}

/** A zip whose members are the files given as [name, bytes]. */
function archive(directory, label, members) {
  return zipOf(directory, label, members.map(([name, bytes]) => [`${label}/${name}`, bytes]))
}

const REGISTRATIONS = ['LAG', 'ABJ', 'KAN', 'PHC', 'IBD']

function csvRows(rowCount) {
  let text = 'reference,location,peril,sum_insured,rate,premium,inception,expiry\n'
  for (let index = 0; index < rowCount; index += 1) {
    const sumInsured = 2_500_000 + (index % 900) * 125_000
    const rate = 0.45 + (index % 37) / 100
    text +=
      `MP-${String(index).padStart(7, '0')},` +
      `${REGISTRATIONS[index % REGISTRATIONS.length]} depot ${index % 240},` +
      `${['Fire', 'Flood', 'Burglary', 'Machinery', 'Transit'][index % 5]},` +
      `${sumInsured},${rate.toFixed(2)},${Math.round((sumInsured * rate) / 100)},` +
      `2025-0${(index % 9) + 1}-01,2026-0${(index % 9) + 1}-01\n`
  }
  return Buffer.from(text, 'utf8')
}

export function buildSamples() {
  const directory = mkdtempSync(join(tmpdir(), 'mailbox-samples-'))
  try {
    const files = [
      { filename: 'schedule.pdf', contentType: 'application/pdf', bytes: pdf('Premium schedule', 'Cover from 1 January, renewable annually.') },
      { filename: 'certificate.pdf', contentType: 'application/pdf', bytes: pdf('Certificate of insurance', 'Issued to the named insured for the period shown.') },
      { filename: 'claim-form.pdf', contentType: 'application/pdf', bytes: pdf('Claim form', 'Complete every section and return it signed.') },
      {
        filename: 'vehicle-list.csv',
        contentType: 'text/csv',
        bytes: Buffer.from(
          'registration,make,model,year,value\nLAG-114-KJA,Toyota,Hilux,2021,18500000\nABJ-882-XA,Ford,Ranger,2019,14200000\nLAG-props-77,Mercedes,Sprinter,2022,31000000\n',
          'utf8',
        ),
      },
      {
        filename: 'site-photo.jpg',
        contentType: 'image/jpeg',
        bytes: ffmpeg(directory, 'site-photo.jpg', ['-f', 'lavfi', '-i', 'testsrc=size=1280x720:duration=1', '-frames:v', '1']),
      },
      {
        filename: 'warehouse.png',
        contentType: 'image/png',
        bytes: ffmpeg(directory, 'warehouse.png', ['-f', 'lavfi', '-i', 'smptebars=size=900x600:duration=1', '-frames:v', '1']),
      },
      {
        filename: 'survey-clip.mp4',
        contentType: 'video/mp4',
        bytes: ffmpeg(directory, 'survey-clip.mp4', [
          '-f', 'lavfi', '-i', 'testsrc=size=480x270:rate=15', '-t', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264',
        ]),
      },
      { filename: 'endorsement.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: docx('Endorsement: the schedule is amended as set out above.', directory) },
    ]
    return files.filter(file => file.bytes && file.bytes.length)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * The files the seeded mailbox hands over as links rather than attachments. They are
 * bigger than the ordinary samples and genuinely of their stated type, so the share
 * page, the password gate and the download all resolve to something openable.
 */
export function buildHeavySamples() {
  const directory = mkdtempSync(join(tmpdir(), 'mailbox-heavy-'))
  try {
    const photo = ffmpeg(directory, 'frame.jpg', ['-f', 'lavfi', '-i', 'testsrc=size=1920x1080:duration=1', '-frames:v', '1'])
    const scan = pdf('Policy scan', 'Scanned page of the placing file.', 40)

    const files = [
      {
        filename: 'site-survey-photos.zip',
        contentType: 'application/zip',
        bytes: photo
          ? archive(
              directory,
              'site-survey-photos',
              Array.from({ length: 24 }, (_, index) => [`survey-${String(index + 1).padStart(3, '0')}.jpg`, photo]),
            )
          : null,
      },
      {
        filename: 'warehouse-walkthrough.mp4',
        contentType: 'video/mp4',
        bytes: clip(directory, 'warehouse-walkthrough.mp4', '1280x720', 5),
      },
      {
        filename: 'fleet-inspection-4k.mov',
        contentType: 'video/quicktime',
        bytes: clip(directory, 'fleet-inspection-4k.mov', '1920x1080', 3),
      },
      {
        filename: 'claims-archive-2019-2025.zip',
        contentType: 'application/zip',
        bytes: archive(
          directory,
          'claims-archive',
          Array.from({ length: 7 }, (_, index) => [
            `claims-${2019 + index}.csv`,
            csvRows(9_000),
          ]),
        ),
      },
      {
        filename: 'policy-scans-full.pdf',
        contentType: 'application/pdf',
        bytes: pdf('Policy scans', 'Complete placing file, scanned front to back.', 900),
      },
      {
        filename: 'drone-footage-ikoyi.mp4',
        contentType: 'video/mp4',
        bytes: clip(directory, 'drone-footage-ikoyi.mp4', '1280x720', 4),
      },
      {
        filename: 'premium-model.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes: xlsx(
          directory,
          ['Reference', 'Class', 'Sum insured', 'Rate', 'Premium'],
          index => [
            `MP-${String(index).padStart(6, '0')}`,
            ['Fire', 'Motor', 'Marine', 'Engineering', 'Liability'][index % 5],
            2_500_000 + (index % 900) * 125_000,
            Number((0.45 + (index % 37) / 100).toFixed(2)),
            Math.round((2_500_000 + (index % 900) * 125_000) * (0.45 + (index % 37) / 100)) / 100,
          ],
          12_000,
        ),
      },
      { filename: 'risk-register.csv', contentType: 'text/csv', bytes: csvRows(30_000) },
      { filename: 'broker-pack.pdf', contentType: 'application/pdf', bytes: pdf('Broker pack', 'Placing information, schedules and loss record.', 300) },
      {
        filename: 'loss-runs.zip',
        contentType: 'application/zip',
        bytes: scan ? archive(directory, 'loss-runs', [['loss-run-2024.pdf', scan], ['loss-run-2025.pdf', scan], ['summary.csv', csvRows(4_000)]]) : null,
      },
    ]
    return files.filter(file => file.bytes && file.bytes.length)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
