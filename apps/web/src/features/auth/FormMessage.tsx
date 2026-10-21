import { useEffect, useRef } from 'react';
import { Alert } from '@wayora/ui';

/**
 * Form-level message. Focused when a new message appears (not on every
 * render), so it is read out and scrolled into view.
 */
export function FormMessage({ message }: { message: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) ref.current?.focus();
  }, [message]);
  if (!message) return null;
  return (
    <div tabIndex={-1} ref={ref} className="focus:outline-none">
      <Alert tone="danger" title="That didn't work">
        {message}
      </Alert>
    </div>
  );
}
