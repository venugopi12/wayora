import { useQuery } from '@tanstack/react-query';
import { LifeBuoy } from 'lucide-react';
import { Link } from 'react-router';
import { getSupportTickets } from '../../services/support';
import { Panel } from '../account/AccountShell';
import { TicketStatusBadge } from './format';
import { supportKeys } from './keys';
import { newTicketPath, ticketPath } from './paths';

const linkClass = 'font-semibold text-brand-ink underline-offset-4 hover:underline';

// ─── Booking page panel ──────────────────────────────────────────────────

/** On a booking's page: its support requests, and a way to ask about it. */
export function BookingSupportPanel({ reference }: { reference: string }) {
  const tickets = useQuery({
    queryKey: supportKeys.list({ view: 'all', booking: reference }),
    queryFn: ({ signal }) =>
      getSupportTickets({ view: 'all', booking: reference, pageSize: 5 }, signal),
  });
  return (
    <Panel
      title="Help with this booking"
      description="Ask Wayora support about it. The request is linked to this booking."
    >
      <div className="flex flex-col gap-3">
        {tickets.data && tickets.data.items.length > 0 ? (
          <ul aria-label="Requests about this booking" className="flex flex-col gap-2">
            {tickets.data.items.map((t) => (
              <li
                key={t.reference}
                className="flex flex-wrap items-center justify-between gap-2 text-body-sm"
              >
                <Link to={ticketPath(t.reference)} className={linkClass}>
                  {t.subject}
                </Link>
                <TicketStatusBadge status={t.status} />
              </li>
            ))}
          </ul>
        ) : null}
        <Link
          to={newTicketPath({ booking: reference })}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line-strong bg-card px-4 text-label text-ink hover:border-brand-300 hover:text-brand-ink"
        >
          <LifeBuoy className="size-4" aria-hidden="true" />
          Get help
        </Link>
      </div>
    </Panel>
  );
}
