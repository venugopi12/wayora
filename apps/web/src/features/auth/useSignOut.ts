import { useState } from 'react';
import { useToast } from '@wayora/ui';
import { useAuth } from './AuthProvider';

/**
 * Sign out with feedback. On success the auth state changes, so protected
 * pages send the person home (see RequireAuth). On failure the session is
 * still valid on the server, so the person is told and stays signed in.
 */
export function useSignOut() {
  const { signOut, signOutEverywhere } = useAuth();
  const { toast } = useToast();
  const [pending, setPending] = useState(false);

  const run = async (everywhere: boolean) => {
    if (pending) return false;
    setPending(true);
    try {
      if (everywhere) {
        await signOutEverywhere();
        toast({ tone: 'success', title: "You're signed out on all devices" });
      } else {
        await signOut();
        toast({ tone: 'success', title: "You're signed out" });
      }
      return true;
    } catch {
      toast({
        tone: 'danger',
        title: "We couldn't sign you out",
        description: 'Check your connection and try again. You are still signed in.',
      });
      return false;
    } finally {
      setPending(false);
    }
  };

  return {
    pending,
    signOut: () => run(false),
    signOutEverywhere: () => run(true),
  };
}
