import { NextResponse } from 'next/server'
import {
  academyFollowupSubject,
  contactFollowupSubject,
  renderAcademyFollowupEmail,
  renderContactFollowupEmail,
} from '@/lib/emails'
import { mailAuthGuard } from '@/lib/dev-auth'

export const runtime = 'nodejs'

type Body = {
  template?: 'academy' | 'contact'
  firstName?: string
  courses?: string
  cohortDate?: string
  projectType?: string
  includeAcademy?: boolean
}

export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard

  let body: Body
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const firstName = (body.firstName ?? '').trim() || 'there'

  if (body.template === 'academy') {
    const courses = (body.courses ?? '').trim()
    const cohortDate = (body.cohortDate ?? '').trim()
    if (!courses || !cohortDate) {
      return NextResponse.json({ ok: false, error: 'Pick at least one course and a cohort date' }, { status: 400 })
    }
    const html = renderAcademyFollowupEmail({ firstName, courses, cohortDate })
    return NextResponse.json({ ok: true, subject: academyFollowupSubject(courses), html })
  }

  if (body.template === 'contact') {
    const projectType = (body.projectType ?? '').trim()
    if (!projectType) {
      return NextResponse.json({ ok: false, error: 'Set a project type' }, { status: 400 })
    }
    const html = renderContactFollowupEmail({
      firstName,
      projectType,
      includeAcademy: body.includeAcademy ? 'true' : 'false',
    })
    return NextResponse.json({ ok: true, subject: contactFollowupSubject(projectType), html })
  }

  return NextResponse.json({ ok: false, error: 'Unknown template' }, { status: 400 })
}
