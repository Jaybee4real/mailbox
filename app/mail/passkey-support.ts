'use client'

import { useEffect, useState } from 'react'
import { browserSupportsWebAuthn } from '@simplewebauthn/browser'

export async function deviceCanHoldPasskey(): Promise<boolean> {
  if (!browserSupportsWebAuthn()) return false
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

export function usePasskeyDevice(): boolean | null {
  const [ready, setReady] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    void deviceCanHoldPasskey().then(result => alive && setReady(result))
    return () => {
      alive = false
    }
  }, [])
  return ready
}
