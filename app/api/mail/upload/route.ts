import { NextResponse } from 'next/server'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { authenticate, isLocalOrigin, verifyMailAuth } from '@/lib/dev-auth'

export const runtime = 'nodejs'

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json()) as HandleUploadBody

  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        // The session cookie is the normal path; the credentials in clientPayload are only
        // still read so a tab that signed in before sessions existed can finish its upload.
        let authorized = isLocalOrigin(req) || Boolean(await authenticate(req))
        if (!authorized && clientPayload) {
          try {
            const creds = JSON.parse(clientPayload) as { email?: string; password?: string }
            authorized = (await verifyMailAuth(creds.email ?? '', creds.password ?? '')).ok
          } catch {
            authorized = false
          }
        }
        if (!authorized) throw new Error('Unauthorized')
        return {
          addRandomSuffix: true,
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          tokenPayload: null,
        }
      },
      onUploadCompleted: async () => {
        // No-op: the URL is returned to the client, which attaches it on send.
      },
    })
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
