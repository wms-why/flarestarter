import { useTranslation } from '@/features/i18n/provider'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { fmtDate } from '@/lib/format-date'
import type { CreditLedgerRow } from '../credits.schema'

/** Presentational labels for ledger `kind` values. */
const KIND_LABEL: Record<CreditLedgerRow['kind'], string> = {
  'grant.monthly': 'Monthly grant',
  'grant.upgrade': 'Upgrade top-up',
  purchase: 'Purchase',
  consume: 'Consumed',
  refund: 'Refund',
  adjust: 'Adjustment',
}

/**
 * Append-only ledger table: signed delta (green for credits in, red for out),
 * the resulting balance, the reference and the timestamp.
 */
export function CreditLedgerTable({ rows }: { rows: CreditLedgerRow[] }) {
  const { t } = useTranslation()
  return (
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
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={5} className="p-6 text-center text-sm text-fg-3">
              {t('credits.history')}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                <Badge variant={row.delta >= 0 ? 'ok' : 'warn'}>
                  {KIND_LABEL[row.kind] ?? row.kind}
                </Badge>
              </TableCell>
              <TableCell>
                <span
                  className="font-mono font-semibold tabular-nums"
                  style={{ color: row.delta >= 0 ? 'var(--success)' : 'var(--destructive)' }}
                >
                  {row.delta >= 0 ? `+${row.delta}` : row.delta}
                </span>
              </TableCell>
              <TableCell className="font-mono tabular-nums">{row.balanceAfter.toLocaleString()}</TableCell>
              <TableCell className="font-mono text-[12.5px] text-fg-3">{row.ref ?? '—'}</TableCell>
              <TableCell className="font-mono text-[12.5px] text-fg-3">{fmtDate(row.createdAt)}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}
