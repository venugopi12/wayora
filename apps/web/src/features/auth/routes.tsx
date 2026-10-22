import { zodResolver } from '@hookform/resolvers/zod';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useSearchParams } from 'react-router';
import { z } from 'zod';
import { PASSWORD_MIN_LENGTH, loginRequestSchema, registerRequestSchema } from '@wayora/contracts';
import { Alert, Button, Field, Input, useToast } from '@wayora/ui';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { ACCOUNT_PATHS, INFO_PATHS } from '../navigation/config';
import { useAuth } from './AuthProvider';
import { applyServerError } from './form-errors';
import { FormMessage } from './FormMessage';
import type { LoginLocationState } from './guards';
import { PasswordInput } from './PasswordInput';
import { REDIRECT_PARAM } from './redirect';

/*
 * /login and /register. Rendered inside AuthLayout and RedirectIfSignedIn:
 * once a request succeeds the auth state changes and the guard sends the
 * person on to the validated `?redirect=` destination (default: profile).
 */

/** Keeps `?redirect=` when switching between sign-in and registration. */
function useAuthSwitchLink(to: string): string {
  const [params] = useSearchParams();
  const redirect = params.get(REDIRECT_PARAM);
  return redirect ? `${to}?${new URLSearchParams({ [REDIRECT_PARAM]: redirect }).toString()}` : to;
}

function AuthHeading({ title, lead }: { title: string; lead: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-heading-1">{title}</h1>
      <p className="text-body text-ink-secondary">{lead}</p>
    </div>
  );
}

type LoginValues = z.input<typeof loginRequestSchema>;

export function LoginRoute() {
  useDocumentTitle('Sign in');
  const { signIn } = useAuth();
  const location = useLocation();
  const sessionExpired = (location.state as LoginLocationState | null)?.sessionExpired === true;
  const registerLink = useAuthSwitchLink(ACCOUNT_PATHS.register);
  const [formError, setFormError] = useState<string | null>(null);
  // Guards against a second submit before React re-renders the disabled button.
  const inFlight = useRef(false);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues, unknown, z.output<typeof loginRequestSchema>>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { email: '', password: '' },
    mode: 'onTouched',
  });

  const submit = async (values: z.output<typeof loginRequestSchema>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFormError(null);
    try {
      await signIn(values);
    } catch (error) {
      setFormError(applyServerError(error, setError, ['email', 'password']));
    } finally {
      inFlight.current = false;
    }
  };
  // handleSubmit is called per event (not during render), so the ref is only read then.
  const onSubmit = (event: FormEvent<HTMLFormElement>) => void handleSubmit(submit)(event);

  return (
    <div className="flex flex-col gap-8">
      <AuthHeading
        title="Welcome back"
        lead="Sign in to see your profile and the travellers you've saved."
      />
      {sessionExpired && !formError ? (
        <Alert tone="info" title="You've been signed out">
          Your session ended, so please sign in again to continue.
        </Alert>
      ) : null}
      <FormMessage message={formError} />
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5" aria-label="Sign in">
        <Field label="Email address" error={errors.email?.message} required>
          <Input
            type="email"
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            {...register('email')}
          />
        </Field>
        <Field
          label="Password"
          error={errors.password?.message}
          required
          hint={
            <>
              Forgotten it? Password reset isn&apos;t available yet;{' '}
              <Link to={`${INFO_PATHS.help}#accounts`} className="underline underline-offset-2">
                see Help
              </Link>
              .
            </>
          }
        >
          <PasswordInput autoComplete="current-password" {...register('password')} />
        </Field>
        <Button type="submit" size="lg" fullWidth loading={isSubmitting}>
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="text-body-sm text-ink-secondary">
        New to Wayora?{' '}
        <Link
          to={registerLink}
          className="font-semibold text-brand-ink underline-offset-2 hover:underline"
        >
          Create an account
        </Link>
      </p>
    </div>
  );
}

/** Registration form: the shared contract plus a client-only confirmation field. */
const registerFormSchema = registerRequestSchema
  .extend({ confirmPassword: z.string({ error: 'Enter your password again.' }) })
  .refine((v) => v.password === v.confirmPassword, {
    path: ['confirmPassword'],
    error: "The passwords don't match.",
  });
type RegisterValues = z.input<typeof registerFormSchema>;

export function RegisterRoute() {
  useDocumentTitle('Create an account');
  const { register: createAccount } = useAuth();
  const { toast } = useToast();
  const loginLink = useAuthSwitchLink(ACCOUNT_PATHS.login);
  const [formError, setFormError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterValues, unknown, z.output<typeof registerFormSchema>>({
    resolver: zodResolver(registerFormSchema),
    defaultValues: { name: '', email: '', password: '', confirmPassword: '' },
    mode: 'onTouched',
  });

  const submit = async ({
    confirmPassword: _confirm,
    ...values
  }: z.output<typeof registerFormSchema>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFormError(null);
    try {
      const user = await createAccount(values);
      toast({
        tone: 'success',
        title: `Welcome to Wayora, ${user.name.split(' ')[0] ?? user.name}`,
      });
    } catch (error) {
      setFormError(applyServerError(error, setError, ['name', 'email', 'password']));
    } finally {
      inFlight.current = false;
    }
  };
  // handleSubmit is called per event (not during render), so the ref is only read then.
  const onSubmit = (event: FormEvent<HTMLFormElement>) => void handleSubmit(submit)(event);

  return (
    <div className="flex flex-col gap-8">
      <AuthHeading
        title="Create your account"
        lead="Save the people you travel with, so their details are ready for demo bookings."
      />
      <FormMessage message={formError} />
      <form
        noValidate
        onSubmit={onSubmit}
        className="flex flex-col gap-5"
        aria-label="Create an account"
      >
        <Field label="Your name" error={errors.name?.message} required>
          <Input autoComplete="name" {...register('name')} />
        </Field>
        <Field
          label="Email address"
          error={errors.email?.message}
          required
          hint="You'll use this to sign in. We don't send email yet."
        >
          <Input
            type="email"
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            {...register('email')}
          />
        </Field>
        <Field
          label="Password"
          error={errors.password?.message}
          required
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A few unrelated words make a strong, memorable password.`}
        >
          <PasswordInput autoComplete="new-password" {...register('password')} />
        </Field>
        <Field label="Confirm password" error={errors.confirmPassword?.message} required>
          <PasswordInput autoComplete="new-password" {...register('confirmPassword')} />
        </Field>
        <Button type="submit" size="lg" fullWidth loading={isSubmitting}>
          {isSubmitting ? 'Creating your account…' : 'Create account'}
        </Button>
        <p className="text-caption text-ink-secondary">
          Wayora is a preview: bookings are demos, with no real reservation or payment. Read how
          account details are handled in the{' '}
          <Link to={INFO_PATHS.privacy} className="underline underline-offset-2">
            draft privacy policy
          </Link>
          .
        </p>
      </form>
      <p className="text-body-sm text-ink-secondary">
        Already have an account?{' '}
        <Link
          to={loginLink}
          className="font-semibold text-brand-ink underline-offset-2 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
