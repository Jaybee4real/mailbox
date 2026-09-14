export type CustomFont = { name: string; url: string }

export const BUILTIN_FONTS = ['Arial', 'Georgia', 'Times New Roman', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Calibri', 'Courier New']

const FORMATS: Record<string, string> = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' }

export function fontFaceCss(fonts: CustomFont[], origin = ''): string {
  return fonts
    .filter(font => font.url)
    .map(font => {
      const extension = font.url.split('.').pop()?.toLowerCase() ?? ''
      const format = FORMATS[extension] ? ` format('${FORMATS[extension]}')` : ''
      return `@font-face{font-family:'${font.name.replace(/'/g, '')}';src:url('${origin}${font.url}')${format};font-display:swap;}`
    })
    .join('')
}

export const FONT_SIZES = ['10px', '11px', '12px', '13px', '14px', '15px', '16px', '18px', '20px', '24px', '28px', '32px']

export type BaseFont = { family: string; size: string }
export const EMPTY_FONT: BaseFont = { family: '', size: '' }

export const fontStack = (family: string) => (family ? `'${family.replace(/'/g, '')}',Arial,Helvetica,sans-serif` : 'Arial,Helvetica,sans-serif')
