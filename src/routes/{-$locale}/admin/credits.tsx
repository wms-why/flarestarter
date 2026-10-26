import { createFileRoute, notFound, useRouter, useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Search, X, ChevronsLeft, ChevronsRight, ChevronLeft, ChevronRight, Coins } from 'lucide-react'
import { toast } from 'sonner'
import { authClient } from '@/features/auth/auth.client'
import { useTranslation } from '@/features/i18n/provider'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AppShell } from '@/components/app/app-shell'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { fmtDateTime } from '@/lib/format-date'
import { getAdminCredits, getAdminLedger, adjustCredits, type AdminCreditAccountRow } from '@/features/credits/admin.serverfn'
import { creditsFeatureEnabled } from '@/features/credits/credits.serverfn'
import { ledgerKindLabel } from '@/features/credits/credits.core'

interface CreditsAdminSearch {
  q?: string
  page?: number
  pageSize?: number
  ledgerUser?: string
}

export const Route = createFileRoute('/{-$locale}/admin/credits')({
  validateSearch: (s: Record<string, unknown>): CreditsAdminSearch => {
    const out: CreditsAdminSearch = {}
    if (typeof s.q === 'string' && s.q) out.q = s.q
    if (typeof s.page === 'number') out.page = s.page
    if (typeof s.pageSize === 'number') out.pageSize = s.pageSize
    if (typeof s.ledgerUser === 'string' && s.ledgerUser) out.ledgerUser = s.ledgerUser
    return out
  },
  loaderDeps: ({ search }) => ({ q: search.q, page: search.page, pageSize: search.pageSize, ledgerUser: search.ledgerUser }),
  loader: async ({ deps }) => {
    // Switched off → no admin screen, no nav entry, no URL.
    if (!(await creditsFeatureEnabled())) throw notFound()
    const [accounts, ledger] = await Promise.all([
      getAdminCredits({ data: { q: deps.q, page: deps.page, pageSize: deps.pageSize } }),
      deps.ledgerUser
        ? getAdminLedger({ data: { userId: deps.ledgerUser, page: 0, pageSize: 20 } })
        : Promise.resolve({ rows: [], total: 0 }),
    ])
    return { accounts, ledger }
  },
  component: AdminCreditsPage,
})

function AdminCreditsPage() {
  const { t } = useTranslation()
  const router = useRouter()
  const { accounts, ledger } = Route.useLoaderData()
  const search = Route.useSearch()
  const { data: session } = authClient.useSession()

  const q = search.q ?? ''
  const page = search.page ?? 0
  const pageSize = search.pageSize ?? 20
  const ledgerUser = search.ledgerUser ?? ''

  const [qInput, setQInput] = useState(q)
  useEffect(() => setQInput(q), [q])
  const isLoading = useRouterState({ select: (s) => s.isLoading })

  const totalPages = Math.max(1, Math.ceil(accounts.total / pageSize))
  const currentPage = page + 1

  function setSearch(patch: Partial<CreditsAdminSearch>, replace = false) {
    void router.navigate({ to: '/{-$locale}/admin/credits', search: { ...search, ...patch }, replace })
  }

  function openRow(row: AdminCreditAccountRow) {
    setSearch({ ledgerUser: row.userId, page: 0 }, true)
    setAdjust(row)
  }

  const [adjust, setAdjust] = useState<AdminCreditAccountRow | null>(null)
  const [delta, setDelta] = useState('')
  const [note, setNote] = useState('')
  const [adjustBusy, setAdjustBusy] = useState(false)
  const [adjustError, setAdjustError] = useState<string | null>(null)

  useEffect(() => {
    if (!adjust) { setDelta(''); setNote(''); setAdjustError(null) }
  }, [adjust])

  async function submitAdjust(e: React.FormEvent) {
    e.preventDefault()
    const parsed = Number(delta)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed === 0) {
      setAdjustError(t('credits.adjustInvalid'))
      return
    }
    setAdjustBusy(true)
    setAdjustError(null)
    try {
      await adjustCredits({ data: { userId: adjust!.userId, delta: parsed, note } })
      toast.success(t('credits.adjustSubmit'))
      setAdjust(null)
      void router.invalidate()
    } catch (err) {
      setAdjustError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdjustBusy(false)
    }
  }

  return (
    <AppShell user={{ name: session?.user?.name, email: session?.user?.email ?? '', role: session?.user?.role ?? 'admin', image: session?.user?.image ?? null }} isPro={false} active="admin-credits" crumb={t('admin.navAdmin')}>
      <div className="mb-5">
        <h1 className="page-h">{t('credits.adminTitle')}</h1>
        <p className="mt-1.5 text-[14.5px] text-fg-2">{t('credits.adminSub')}</p>
      </div>

      <div className="mb-4 max-w-[380px]">
        <div className="field-wrap relative">
          <span className="lead"><Search size={17} /></span>
          <Input
            className="pl-[38px] pr-9"
            placeholder={t('admin.searchPlaceholder')}
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setSearch({ q: qInput, page: 0 }, true)
            }}
          />
          {qInput && (
            <button
              type="button"
              aria-label={t('admin.clearSearch')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-fg-3 hover:text-foreground"
              onClick={() => { setQInput(''); setSearch({ q: '', page: 0 }, true) }}
            >
              <X size={15} />
            </button>
          )}
        </div>
      </div>

      <Card className={`mb-8 overflow-hidden p-0 transition-opacity ${isLoading ? 'opacity-60' : ''}`}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('admin.email')}</TableHead>
              <TableHead>{t('admin.name')}</TableHead>
              <TableHead>{t('credits.balance')}</TableHead>
              <TableHead>{t('credits.monthlyGrant')}</TableHead>
              <TableHead>{t('credits.lifetimePurchased')}</TableHead>
              <TableHead>{t('credits.lifetimeConsumed')}</TableHead>
              <TableHead>{t('admin.createdAt')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="p-6 text-center text-sm text-fg-3">{t('admin.noResults')}</TableCell>
              </TableRow>
            ) : accounts.rows.map((row) => (
              <TableRow key={row.userId} className="cursor-pointer" onClick={() => openRow(row)}>
                <TableCell className="font-mono text-[12.5px]">{row.email}</TableCell>
                <TableCell>{row.name}</TableCell>
                <TableCell className="font-mono font-semibold tabular-nums">{row.balance.toLocaleString()}</TableCell>
                <TableCell className="font-mono tabular-nums">{row.periodGrant.toLocaleString()}</TableCell>
                <TableCell className="font-mono tabular-nums">{row.lifetimePurchased.toLocaleString()}</TableCell>
                <TableCell className="font-mono tabular-nums">{row.lifetimeConsumed.toLocaleString()}</TableCell>
                <TableCell className="font-mono text-[12.5px] text-fg-3">{fmtDateTime(row.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
          <span className="font-mono text-[13px] text-fg-3">
            {t('admin.pageOf', { page: String(currentPage), total: String(totalPages) })}
          </span>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setSearch({ page: 0 })}><ChevronsLeft size={15} /></Button>
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setSearch({ page: page - 1 })}><ChevronLeft size={15} /></Button>
            <Button variant="outline" size="sm" disabled={currentPage >= totalPages} onClick={() => setSearch({ page: page + 1 })}><ChevronRight size={15} /></Button>
            <Button variant="outline" size="sm" disabled={currentPage >= totalPages} onClick={() => setSearch({ page: totalPages - 1 })}><ChevronsRight size={15} /></Button>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-border px-[22px] py-[18px]">
          <h2 className="m-0 flex items-center gap-2 text-base font-semibold">
            <Coins size={17} /> {t('credits.history')}
            {ledgerUser && <Badge variant="free" className="ml-auto font-mono">{ledgerUser.slice(0, 8)}</Badge>}
          </h2>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('credits.kind')}</TableHead>
              <TableHead>{t('credits.delta')}</TableHead>
              <TableHead>{t('credits.after')}</TableHead>
              <TableHead>{t('credits.ref')}</TableHead>
              <TableHead>{t('credits.period')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ledger.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="p-6 text-center text-sm text-fg-3">{t('credits.selectUser')}</TableCell>
              </TableRow>
            ) : ledger.rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Badge variant={row.delta >= 0 ? 'ok' : 'warn'}>{ledgerKindLabel(row.kind, t)}</Badge>
                </TableCell>
                <TableCell>
                  <span className="font-mono font-semibold tabular-nums" style={{ color: row.delta >= 0 ? 'var(--success)' : 'var(--destructive)' }}>
                    {row.delta >= 0 ? `+${row.delta}` : row.delta}
                  </span>
                </TableCell>
                <TableCell className="font-mono tabular-nums">{row.balanceAfter.toLocaleString()}</TableCell>
                <TableCell className="font-mono text-[12.5px] text-fg-3">{row.ref ?? '—'}</TableCell>
                <TableCell className="font-mono text-[12.5px] text-fg-3">{fmtDateTime(row.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={adjust != null} onOpenChange={(open) => { if (!open) setAdjust(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('credits.adjust')}</DialogTitle>
            <DialogDescription>{adjust?.email}</DialogDescription>
          </DialogHeader>
          <form onSubmit={submitAdjust} className="grid gap-4">
            <div className="field">
              <Label htmlFor="adjustDelta">{t('credits.adjustDelta')}</Label>
              <Input id="adjustDelta" type="number" step={1} value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="+100 / -20" />
            </div>
            <div className="field">
              <Label htmlFor="adjustNote">{t('credits.adjustNote')}</Label>
              <Input id="adjustNote" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            {adjustError && <p className="text-sm text-destructive">{adjustError}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setAdjust(null)}>{t('admin.closeDrawer')}</Button>
              <Button type="submit" disabled={adjustBusy}>{t('credits.adjustSubmit')}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </AppShell>
  )
}
