/**
 * Real files for the seeded mailbox: a message that says it carries a photo should carry
 * a photo you can open. Everything here is generated, so the repository ships no media.
 *
 * ffmpeg draws the picture and the video when it is installed; the PDF, the spreadsheet
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

/** A one-page PDF, with the byte offsets its cross-reference table has to name. */
function pdf(title, line) {
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>',
    null,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ]
  const stream = `BT /F1 20 Tf 64 760 Td (${title}) Tj ET\nBT /F1 12 Tf 64 730 Td (${line}) Tj ET`
  objects[3] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`

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

/** A .docx is a zip of three small XML parts; the zip tool does the rest. */
function docx(text, directory) {
  if (!has('zip')) return null
  const root = join(directory, 'docx')
  mkdirSync(join(root, '_rels'), { recursive: true })
  mkdirSync(join(root, 'word'), { recursive: true })
  writeFileSync(
    join(root, '[Content_Types].xml'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  writeFileSync(
    join(root, '_rels/.rels'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  )
  writeFileSync(
    join(root, 'word/document.xml'),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  )
  const out = join(directory, 'endorsement.docx')
  execFileSync('zip', ['-q', '-r', '-X', out, '[Content_Types].xml', '_rels', 'word'], { cwd: root })
  return readFileSync(out)
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
