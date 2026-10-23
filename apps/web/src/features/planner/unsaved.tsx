import { useCallback, useEffect, useRef } from 'react';
import { useBlocker, type Blocker } from 'react-router';
import { Button, Dialog, DialogContent } from '@wayora/ui';

/*
 * Unsaved-change protection (docs/planner.md#web). While `when` is true:
 * - in-app navigation to another page is held and the user is asked first;
 * - closing or reloading the tab triggers the browser's own "leave site?"
 *   prompt (its wording can't be customised).
 * `allowNavigation()` lets the next navigation through (e.g. after saving).
 */
export function useUnsavedChanges(when: boolean): {
  blocker: Blocker;
  allowNavigation: () => void;
} {
  const allowed = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      when && !allowed.current && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!when) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [when]);
  const allowNavigation = useCallback(() => {
    allowed.current = true;
  }, []);
  return { blocker, allowNavigation };
}

/** Asks before leaving a page with unsaved changes. */
export function LeaveDialog({
  blocker,
  title = 'Leave without saving?',
  description = 'Your changes on this page haven’t been saved. If you leave now, they’ll be lost.',
}: {
  blocker: Blocker;
  title?: string;
  description?: string;
}) {
  return (
    <Dialog
      open={blocker.state === 'blocked'}
      onOpenChange={(open) => {
        if (!open && blocker.state === 'blocked') blocker.reset();
      }}
    >
      <DialogContent
        size="sm"
        title={title}
        description={description}
        footer={
          <>
            <Button variant="secondary" onClick={() => blocker.reset?.()}>
              Stay on this page
            </Button>
            <Button variant="destructive" onClick={() => blocker.proceed?.()}>
              Leave and discard
            </Button>
          </>
        }
      />
    </Dialog>
  );
}
