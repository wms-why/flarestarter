import { createFileRoute, useRouter, Link } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { requireUser } from '@/features/auth/middleware'
import { getEntitlement } from '@/features/billing/middleware'
import { signOut, changePassword, deleteUser } from '@/features/auth/auth.client'
import { mapAuthError } from '@/features/auth/errors'
import { useTranslation } from '@/features/i18n/provider'
import { AppShell } from '@/components/app/app-shell'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import { LogOut, Trash2 } from 'lucide-react'
import { ManageSubscription } from '@/features/billing/components/manage-subscription'
import { AvatarUploader } from '@/features/storage/components/avatar-uploader'

export const Route = createFileRoute('/{-$locale}/app/account')({
  head: () => ({ meta: [{ name: 'robots', content: 'noindex' }] }),
  loader: async ({ params }) => {
    const [user, ent] = await Promise.all([requireUser({ data: { locale: (params as { locale?: string }).locale } }), getEntitlement()])
    return { user, ent }
  },
  component: AccountPage,
})

function Section({
  title,
  danger,
  children,
}: {
  title: string
  danger?: boolean
  children: ReactNode
}) {
  return (
    <Card
      className="mb-[18px] overflow-hidden p-0"
      style={danger ? { borderColor: 'color-mix(in srgb, var(--destructive) 45%, var(--border))' } : undefined}
    >
      <div className="border-b border-border px-[22px] py-[18px]">
        <h3 className="m-0 text-base font-semibold" style={{ color: danger ? 'var(--destructive)' : 'var(--foreground)' }}>
          {title}
        </h3>
      </div>
      <div className="p-[22px]">{children}</div>
    </Card>
  )
}

function AccountPage() {
  const { user, ent } = Route.useLoaderData()
  const { t } = useTranslation()
  const router = useRouter()

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [pwError, setPwError] = useState<string | null>(null)
  const [pwSuccess, setPwSuccess] = useState(false)
  const [pwBusy, setPwBusy] = useState(false)

  const [deletePassword, setDeletePassword] = useState('')
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()
    setPwBusy(true)
    setPwError(null)
    setPwSuccess(false)
    const res = await changePassword({ currentPassword, newPassword, revokeOtherSessions: true })
    setPwBusy(false)
    if (res.error) {
      setPwError(t(mapAuthError(res.error)))
      return
    }
    setPwSuccess(true)
    setCurrentPassword('')
    setNewPassword('')
  }

  async function handleLogout() {
    await signOut()
    router.navigate({ to: '/{-$locale}/login' })
  }

  async function handleDelete(e: React.FormEvent) {
    e.preventDefault()
    if (!confirm(t('auth.deleteConfirm'))) return
    setDeleteBusy(true)
    setDeleteError(null)
    const res = await deleteUser({ password: deletePassword })
    setDeleteBusy(false)
    if (res.error) {
      setDeleteError(t(mapAuthError(res.error)))
      return
    }
    router.navigate({ to: '/{-$locale}' })
  }

  return (
    <AppShell user={user} isPro={ent.plan === 'pro'} active="account" crumb={t('app.account')} paymentFailed={ent.paymentFailed}>
      <div className="mb-6">
        <h1 className="page-h">{t('app.account')}</h1>
        <p className="mt-1.5 font-mono text-[13.5px] text-fg-3">{user.email}</p>
      </div>

      <div className="max-w-[640px]">
        <Section title={t('storage.avatar')}>
          <AvatarUploader image={user.image} name={user.name} />
        </Section>

        <Section title={t('auth.changePassword')}>
          <form onSubmit={handleChangePassword} className="grid gap-4">
            <div className="field">
              <Label htmlFor="currentPassword">{t('auth.currentPassword')}</Label>
              <Input id="currentPassword" type="password" value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)} required autoComplete="current-password" />
            </div>
            <div className="field">
              <Label htmlFor="newPassword">{t('auth.newPassword')}</Label>
              <Input id="newPassword" type="password" value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
            </div>
            {pwError && <p className="text-sm text-destructive">{pwError}</p>}
            {pwSuccess && <p className="text-sm text-success">{t('app.passwordChanged')}</p>}
            <div>
              <Button type="submit" disabled={pwBusy}>{t('auth.changePassword')}</Button>
            </div>
          </form>
        </Section>

        <Section title={t('billing.currentPlan')}>
          <ManageSubscription plan={ent.plan} status={ent.status} currentPeriodEnd={ent.currentPeriodEnd} lifetime={ent.lifetime} provider={ent.provider} />
        </Section>

        {user.role === 'admin' && (
          <Section title={t('admin.title')}>
            <Link to="/{-$locale}/admin" className={buttonVariants({ variant: 'outline' })}>
              {t('admin.title')}
            </Link>
          </Section>
        )}

        <Section title={t('auth.logout')}>
          <Button variant="outline" onClick={handleLogout}>
            <LogOut size={16} /> {t('auth.logout')}
          </Button>
        </Section>

        <Section title={t('auth.deleteAccount')} danger>
          <form onSubmit={handleDelete} className="grid gap-4">
            <p className="m-0 text-[13.5px] text-fg-2">{t('auth.deleteConfirm')}</p>
            <div className="field">
              <Label htmlFor="deletePassword">{t('auth.password')}</Label>
              <Input id="deletePassword" type="password" value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)} required autoComplete="current-password" />
            </div>
            {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
            <div>
              <Button type="submit" disabled={deleteBusy} style={{ background: 'var(--destructive)', color: '#fff' }}>
                <Trash2 size={16} /> {t('auth.deleteAccount')}
              </Button>
            </div>
          </form>
        </Section>
      </div>
    </AppShell>
  )
}
