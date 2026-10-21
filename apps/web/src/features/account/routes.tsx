import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, MonitorSmartphone, Pencil, Plus, Trash2, UserRound, Users } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { NavLink } from 'react-router';
import { z } from 'zod';
import {
  MAX_TRAVELLERS_PER_USER,
  createTravellerRequestSchema,
  dateOfBirthSchema,
  nationalitySchema,
  updateProfileRequestSchema,
  type CreateTravellerRequest,
  type Traveller,
} from '@wayora/contracts';
import {
  Alert,
  Avatar,
  Button,
  Container,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
  cn,
  useToast,
} from '@wayora/ui';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { ApiClientError } from '../../lib/api-client';
import {
  createTraveller,
  deleteTraveller,
  listTravellers,
  updateProfile,
  updateTraveller,
} from '../../services/account';
import { authKeys, useAuth } from '../auth/AuthProvider';
import { applyServerError } from '../auth/form-errors';
import { FormMessage } from '../auth/FormMessage';
import { useSignOut } from '../auth/useSignOut';
import { ACCOUNT_PATHS } from '../navigation/config';
import { countryName, countryOptions } from './countries';

/*
 * /profile and /profile/travellers. Both render inside RequireAuth, so a
 * signed-in user is guaranteed here; every request is still checked by the
 * API (the session cookie, never a client-supplied id, decides whose data).
 */

const ACCOUNT_NAV = [
  { to: ACCOUNT_PATHS.profile, label: 'Profile', icon: UserRound },
  { to: ACCOUNT_PATHS.travellers, label: 'Saved travellers', icon: Users },
] as const;

function AccountShell({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Container className="py-section-sm">
      <div className="grid gap-8 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-12">
        <nav aria-label="Account" className="lg:pt-2">
          <ul className="flex gap-1 overflow-x-auto lg:flex-col">
            {ACCOUNT_NAV.map(({ to, label, icon: Icon }) => (
              <li key={to} className="shrink-0">
                <NavLink
                  to={to}
                  end
                  className={cn(
                    'flex min-h-11 items-center gap-2.5 rounded-md px-3 text-body-sm text-ink-secondary',
                    'hover:bg-brand-soft hover:text-brand-ink',
                    'aria-[current=page]:bg-brand-soft aria-[current=page]:font-semibold aria-[current=page]:text-brand-ink',
                  )}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-col gap-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex max-w-2xl flex-col gap-2">
              <h1 className="text-heading-1">{title}</h1>
              <p className="text-body text-ink-secondary">{description}</p>
            </div>
            {actions ? <div className="shrink-0">{actions}</div> : null}
          </div>
          {children}
        </div>
      </div>
    </Container>
  );
}

function Panel({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = `panel-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section
      aria-labelledby={id}
      className={cn('rounded-xl border border-line bg-card p-5 shadow-xs sm:p-7', className)}
    >
      <div className="mb-5 flex flex-col gap-1">
        <h2 id={id} className="text-title">
          {title}
        </h2>
        {description ? <p className="text-body-sm text-ink-secondary">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

const memberSince = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(new Date(iso));

// ─── /profile ─────────────────────────────────────────────────────────────

type ProfileValues = z.input<typeof updateProfileRequestSchema>;

export function ProfileRoute() {
  useDocumentTitle('Your profile');
  const { user, setUser } = useAuth();
  const { toast } = useToast();
  const { pending: signingOut, signOut, signOutEverywhere } = useSignOut();
  const [editing, setEditing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  const form = useForm<ProfileValues, unknown, z.output<typeof updateProfileRequestSchema>>({
    resolver: zodResolver(updateProfileRequestSchema),
    defaultValues: { name: user?.name ?? '' },
  });

  const save = useMutation({
    mutationFn: updateProfile,
    onSuccess: (updated) => {
      setUser(updated);
      returnFocus.current = true;
      setEditing(false);
      toast({ tone: 'success', title: 'Profile updated' });
    },
    onError: (error) => setFormError(applyServerError(error, form.setError, ['name'])),
  });

  // After saving or cancelling, put focus back on the Edit button.
  useEffect(() => {
    if (!editing && returnFocus.current) {
      returnFocus.current = false;
      editButton.current?.focus();
    }
  }, [editing]);

  if (!user) return null; // RequireAuth guarantees a user; this keeps types honest.

  const startEditing = () => {
    form.reset({ name: user.name });
    setFormError(null);
    setEditing(true);
  };
  const cancel = () => {
    returnFocus.current = true;
    setEditing(false);
  };

  return (
    <AccountShell
      title="Your profile"
      description="The details on your Wayora account, and where you're signed in."
    >
      <Panel title="Personal details">
        <div className="mb-6 flex items-center gap-4">
          <Avatar name={user.name} size="lg" />
          <div className="min-w-0">
            <p className="truncate text-title">{user.name}</p>
            <p className="truncate text-body-sm text-ink-secondary">{user.email}</p>
          </div>
        </div>

        {editing ? (
          <form
            noValidate
            aria-label="Edit your name"
            className="flex max-w-md flex-col gap-5"
            onSubmit={form.handleSubmit((values) => {
              if (save.isPending) return;
              setFormError(null);
              save.mutate(values);
            })}
          >
            <FormMessage message={formError} />
            <Field label="Your name" error={form.formState.errors.name?.message} required>
              <Input autoComplete="name" autoFocus {...form.register('name')} />
            </Field>
            <div className="flex flex-wrap gap-3">
              <Button type="submit" loading={save.isPending}>
                Save changes
              </Button>
              <Button type="button" variant="secondary" onClick={cancel} disabled={save.isPending}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <dt className="text-label text-ink-secondary">Name</dt>
              <dd className="text-body">{user.name}</dd>
              <dt className="text-label text-ink-secondary">Email</dt>
              <dd className="text-body">
                <span className="break-all">{user.email}</span>
                <span className="mt-1 block text-body-sm text-ink-secondary">
                  {user.emailVerified
                    ? 'Verified.'
                    : "Not verified: email verification and changing your email aren't available yet."}
                </span>
              </dd>
              <dt className="text-label text-ink-secondary">Member since</dt>
              <dd className="text-body">{memberSince(user.createdAt)}</dd>
            </dl>
            <Button ref={editButton} variant="secondary" className="mt-6" onClick={startEditing}>
              <Pencil aria-hidden="true" />
              Edit name
            </Button>
          </>
        )}
      </Panel>

      <Panel
        title="Signing in"
        description="Sessions end after 7 days without activity, and after 30 days at most."
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap">
          <Button
            variant="secondary"
            onClick={() => void signOut()}
            loading={signingOut && !confirmAll}
          >
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
          <Dialog open={confirmAll} onOpenChange={(open) => !signingOut && setConfirmAll(open)}>
            <Button variant="ghost" onClick={() => setConfirmAll(true)} disabled={signingOut}>
              <MonitorSmartphone aria-hidden="true" />
              Sign out on all devices
            </Button>
            <DialogContent
              size="sm"
              title="Sign out on all devices?"
              description="This ends every Wayora session for your account, including this one. You'll need to sign in again everywhere."
              footer={
                <>
                  <DialogClose asChild>
                    <Button variant="secondary" disabled={signingOut}>
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button
                    variant="destructive"
                    loading={signingOut}
                    onClick={async () => {
                      if (!(await signOutEverywhere())) setConfirmAll(false);
                    }}
                  >
                    Sign out everywhere
                  </Button>
                </>
              }
            />
          </Dialog>
        </div>
      </Panel>
    </AccountShell>
  );
}

// ─── /profile/travellers ──────────────────────────────────────────────────

const travellerFormSchema = z.object({
  firstName: createTravellerRequestSchema.shape.firstName,
  lastName: createTravellerRequestSchema.shape.lastName,
  dateOfBirth: z.union([z.literal(''), dateOfBirthSchema]),
  nationality: z.union([z.literal(''), nationalitySchema]),
});
type TravellerFormValues = z.input<typeof travellerFormSchema>;

const toRequest = (v: z.output<typeof travellerFormSchema>): CreateTravellerRequest => ({
  firstName: v.firstName,
  lastName: v.lastName,
  dateOfBirth: v.dateOfBirth || null,
  nationality: v.nationality || null,
});

const formatDob = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00Z`));

function TravellerFormDialog({
  open,
  onOpenChange,
  traveller,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this traveller; omit to add a new one. */
  traveller?: Traveller;
}) {
  const client = useQueryClient();
  const { toast } = useToast();
  const [formError, setFormError] = useState<string | null>(null);
  // Mounted afresh for each opening (see `key` in TravellersRoute), so the
  // form starts from the traveller being edited, or empty.
  const form = useForm<TravellerFormValues, unknown, z.output<typeof travellerFormSchema>>({
    resolver: zodResolver(travellerFormSchema),
    defaultValues: {
      firstName: traveller?.firstName ?? '',
      lastName: traveller?.lastName ?? '',
      dateOfBirth: traveller?.dateOfBirth ?? '',
      nationality: traveller?.nationality ?? '',
    },
  });

  const save = useMutation({
    mutationFn: (body: CreateTravellerRequest) =>
      traveller ? updateTraveller(traveller.id, body) : createTraveller(body),
    onSuccess: (saved) => {
      client.setQueryData<Traveller[]>(authKeys.travellers, (list = []) =>
        traveller ? list.map((t) => (t.id === saved.id ? saved : t)) : [...list, saved],
      );
      void client.invalidateQueries({ queryKey: authKeys.travellers });
      onOpenChange(false);
      toast({
        tone: 'success',
        title: traveller ? 'Traveller updated' : `${saved.firstName} ${saved.lastName} saved`,
      });
    },
    onError: (error) =>
      setFormError(
        applyServerError(error, form.setError, [
          'firstName',
          'lastName',
          'dateOfBirth',
          'nationality',
        ]),
      ),
  });

  const countries = countryOptions();
  const { errors } = form.formState;
  const formId = traveller ? `traveller-form-${traveller.id}` : 'traveller-form-new';
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Dialog open={open} onOpenChange={(next) => !save.isPending && onOpenChange(next)}>
      <DialogContent
        title={traveller ? 'Edit traveller' : 'Add a traveller'}
        description="Names should match the traveller's ID, as they'll be used for bookings."
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary" disabled={save.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" form={formId} loading={save.isPending}>
              {traveller ? 'Save changes' : 'Save traveller'}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          noValidate
          className="flex flex-col gap-5 pb-2"
          onSubmit={form.handleSubmit((values) => {
            if (save.isPending) return;
            setFormError(null);
            save.mutate(toRequest(values));
          })}
        >
          <FormMessage message={formError} />
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="First name" error={errors.firstName?.message} required>
              <Input autoComplete="off" {...form.register('firstName')} />
            </Field>
            <Field label="Last name" error={errors.lastName?.message} required>
              <Input autoComplete="off" {...form.register('lastName')} />
            </Field>
          </div>
          <Field
            label="Date of birth"
            error={errors.dateOfBirth?.message}
            hint="Optional. Some fares depend on age."
          >
            <Input type="date" min="1900-01-01" max={today} {...form.register('dateOfBirth')} />
          </Field>
          <Field label="Nationality" error={errors.nationality?.message} hint="Optional.">
            <Select
              {...form.register('nationality')}
              options={[
                { value: '', label: 'Not specified' },
                ...countries.map((c) => ({ value: c.code, label: c.name })),
              ]}
            />
          </Field>
          <p className="text-caption text-ink-secondary">
            Wayora doesn&apos;t ask for passport or ID numbers.
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteTravellerDialog({
  traveller,
  onOpenChange,
}: {
  traveller: Traveller | null;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useQueryClient();
  const { toast } = useToast();
  const remove = useMutation({
    mutationFn: (id: string) => deleteTraveller(id),
    onSuccess: (_void, id) => {
      client.setQueryData<Traveller[]>(authKeys.travellers, (list = []) =>
        list.filter((t) => t.id !== id),
      );
      void client.invalidateQueries({ queryKey: authKeys.travellers });
      onOpenChange(false);
      toast({ tone: 'success', title: 'Traveller removed' });
    },
    onError: (error) => {
      // Already gone (e.g. removed in another tab): the list just needs refreshing.
      if (error instanceof ApiClientError && error.status === 404) {
        void client.invalidateQueries({ queryKey: authKeys.travellers });
        onOpenChange(false);
        return;
      }
      toast({
        tone: 'danger',
        title: "We couldn't remove this traveller",
        description: 'Check your connection and try again.',
      });
    },
  });
  const name = traveller ? `${traveller.firstName} ${traveller.lastName}` : '';

  return (
    <Dialog
      open={traveller !== null}
      onOpenChange={(next) => !remove.isPending && onOpenChange(next)}
    >
      {traveller ? (
        <DialogContent
          size="sm"
          title={`Remove ${name}?`}
          description="Their saved details will be deleted from your account. This can't be undone."
          footer={
            <>
              <DialogClose asChild>
                <Button variant="secondary" disabled={remove.isPending}>
                  Keep traveller
                </Button>
              </DialogClose>
              <Button
                variant="destructive"
                loading={remove.isPending}
                onClick={() => !remove.isPending && remove.mutate(traveller.id)}
              >
                Remove traveller
              </Button>
            </>
          }
        />
      ) : null}
    </Dialog>
  );
}

function TravellerCard({
  traveller,
  onEdit,
  onDelete,
}: {
  traveller: Traveller;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const name = `${traveller.firstName} ${traveller.lastName}`;
  return (
    <li className="flex flex-col gap-4 rounded-xl border border-line bg-card p-5 shadow-xs sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <Avatar name={name} />
        <div className="min-w-0">
          <p className="truncate text-title">{name}</p>
          <p className="text-body-sm text-ink-secondary">
            {[
              traveller.dateOfBirth ? `Born ${formatDob(traveller.dateOfBirth)}` : null,
              traveller.nationality ? countryName(traveller.nationality) : null,
            ]
              .filter(Boolean)
              .join(' · ') || 'No other details saved'}
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={onEdit} aria-label={`Edit ${name}`}>
          <Pencil aria-hidden="true" />
          Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete} aria-label={`Remove ${name}`}>
          <Trash2 aria-hidden="true" />
          Remove
        </Button>
      </div>
    </li>
  );
}

export function TravellersRoute() {
  useDocumentTitle('Saved travellers');
  const travellers = useQuery({
    queryKey: authKeys.travellers,
    queryFn: ({ signal }) => listTravellers(signal),
  });
  const [formOpen, setFormOpen] = useState(false);
  // Changes on every opening, so the form dialog remounts with fresh state.
  const [formSession, setFormSession] = useState(0);
  const [editing, setEditing] = useState<Traveller | undefined>(undefined);
  const [deleting, setDeleting] = useState<Traveller | null>(null);

  const list = travellers.data ?? [];
  const atCap = list.length >= MAX_TRAVELLERS_PER_USER;
  const openForm = (traveller?: Traveller) => {
    setEditing(traveller);
    setFormSession((n) => n + 1);
    setFormOpen(true);
  };
  const openAdd = () => openForm();
  const addButton = (
    <Button onClick={openAdd} disabled={atCap || !travellers.isSuccess}>
      <Plus aria-hidden="true" />
      Add traveller
    </Button>
  );

  return (
    <AccountShell
      title="Saved travellers"
      description="The people you travel with. Their names and details will fill in booking forms when booking opens."
      actions={travellers.isSuccess && list.length > 0 ? addButton : undefined}
    >
      {travellers.isPending ? (
        <div role="status" aria-label="Loading saved travellers" className="flex flex-col gap-3">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-22 rounded-xl" />
          ))}
        </div>
      ) : travellers.isError ? (
        <ErrorState
          title="We couldn't load your travellers"
          description="Check your connection, then try again."
          reference={
            travellers.error instanceof ApiClientError
              ? (travellers.error.requestId ?? undefined)
              : undefined
          }
          action={
            <Button
              variant="secondary"
              onClick={() => void travellers.refetch()}
              loading={travellers.isFetching}
            >
              Try again
            </Button>
          }
        />
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong bg-card">
          <EmptyState
            size="page"
            icon={<Users />}
            title="No saved travellers yet"
            description="Add yourself, family or friends once, and skip retyping their details later."
            action={addButton}
          />
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-3" aria-label="Saved travellers">
            {list.map((t) => (
              <TravellerCard
                key={t.id}
                traveller={t}
                onEdit={() => openForm(t)}
                onDelete={() => setDeleting(t)}
              />
            ))}
          </ul>
          {atCap ? (
            <Alert tone="info">
              You&apos;ve saved {MAX_TRAVELLERS_PER_USER} travellers, the most an account can hold.
              Remove one to add someone new.
            </Alert>
          ) : null}
        </>
      )}

      <TravellerFormDialog
        key={formSession}
        open={formOpen}
        onOpenChange={setFormOpen}
        traveller={editing}
      />
      <DeleteTravellerDialog
        traveller={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
      />
    </AccountShell>
  );
}
