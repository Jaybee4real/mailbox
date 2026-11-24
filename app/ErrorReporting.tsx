'use client'

import { useEffect } from 'react'
import { startErrorReporting } from '@/lib/monitoring.client'

export default function ErrorReporting() {
  useEffect(() => {
    void startErrorReporting()
  }, [])
  return null
}
