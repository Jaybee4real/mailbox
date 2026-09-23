/**
 * HTML pasted from Word, Outlook or Excel, without the styling that came with it: Office
 * namespaces, conditional comments, class names and fonts go; bold, lists, links and tables
 * stay.
 */
export function cleanPastedHtml(html: string): string {
  let cleaned = html
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|script|xml|title)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(meta|link)\b[^>]*>/gi, '')
    .replace(/<\/?o:p[^>]*>/gi, '')
    .replace(/\s(class|lang|face|size)="[^"]*"/gi, '')
    .replace(/\sstyle="([^"]*)"/gi, (_whole, css: string) => {
      const kept = css
        .split(';')
        .map(rule => rule.trim())
        .filter(rule => /^(font-weight|font-style|text-decoration|color|background(-color)?|text-align)\s*:/i.test(rule))
        .filter(rule => !/mso-|windowtext/i.test(rule))
        .join(';')
      return kept ? ` style="${kept}"` : ''
    })
  for (let previous = ''; previous !== cleaned; ) {
    previous = cleaned
    cleaned = cleaned
      .replace(/<span>((?:(?!<\/?span\b)[\s\S])*)<\/span>/gi, '$1')
      .replace(/<font\b[^>]*>((?:(?!<\/?font\b)[\s\S])*)<\/font>/gi, '$1')
  }
  return cleaned
}
