import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { safeRedirectPath, loginPathFor } from '../src/features/auth/redirect';
import { ApiClientError, createApiClient } from '../src/lib/api-client';
import { credentialsFor } from '../src/services/api';
import { TEST_USER, installFakeAccountApi } from './fake-account-api';
import { renderRoute } from './render';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const field = (name: RegExp | string) => screen.getByLabelText(name, { selector: 'input' });
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

async function fillLogin(email: string, password: string) {
  type(await screen.findByRole('textbox', { name: /email address/i }), email);
  type(field(/^password/i), password);
}

describe('redirect validation (open-redirect protection)', () => {
  it.each([
    ['/profile/travellers', '/profile/travellers'],
    ['/discover/goa?x=1#top', '/discover/goa?x=1#top'],
    ['/a/../profile', '/profile'],
  ])('accepts the internal path %s', (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected);
  });

  it.each([
    'https://evil.example/profile',
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    'profile',
    '/\tevil',
    '/login',
    '/register?redirect=/x',
    '/sign-in',
    '',
    null,
  ])('rejects %s', (input) => {
    expect(safeRedirectPath(input as string | null)).toBe('/profile');
  });

  it('builds sign-in links that carry the current page', () => {
    expect(loginPathFor('/profile/travellers')).toBe('/login?redirect=%2Fprofile%2Ftravellers');
    expect(loginPathFor('/')).toBe('/login');
    expect(loginPathFor('//evil.example')).toBe('/login');
  });
});

describe('API client: cookies and session end', () => {
  const schema = z.object({ ok: z.boolean() });

  it('sends the configured credentials mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { ok: true }, meta: { requestId: 'r' } }), {
        status: 200,
      }),
    );
    await createApiClient('http://api.test', {
      fetchImpl: fetchMock,
      credentials: 'include',
    }).request('/x', { schema });
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'include' });
  });

  it('uses include across origins and same-origin otherwise', () => {
    expect(credentialsFor('http://localhost:4000', 'http://localhost:5173')).toBe('include');
    expect(credentialsFor('https://wayora.example', 'https://wayora.example')).toBe('same-origin');
  });

  it('reports a 401 once through onSessionEnded, unless the call opts out', async () => {
    const unauthorized = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.', requestId: 'r' },
          }),
          { status: 401 },
        ),
      );
    const onSessionEnded = vi.fn();
    const client = createApiClient('http://api.test', {
      fetchImpl: vi.fn(unauthorized),
      onSessionEnded,
    });
    await expect(client.request('/x', { schema })).rejects.toBeInstanceOf(ApiClientError);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    await expect(client.request('/x', { schema, reportsSessionEnd: false })).rejects.toThrow();
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });
});

describe('protected routes', () => {
  it('shows only a loader until /auth/session answers, then redirects to sign-in with the destination', async () => {
    const api = installFakeAccountApi({ signedIn: false });
    const release = api.hold('GET', '/auth/session');
    const { router } = renderRoute('/profile/travellers');

    expect(await screen.findByText('Loading page')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Saved travellers' })).toBeNull();
    expect(api.calls()).toEqual(['GET /auth/session']);

    release();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Welcome back' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe('?redirect=%2Fprofile%2Ftravellers');
    // Exactly one session check for the whole app.
    expect(api.calls().filter((c) => c === 'GET /auth/session')).toHaveLength(1);
  });

  it('sends people back to the page they wanted after signing in', async () => {
    const api = installFakeAccountApi({ signedIn: false });
    const { router } = renderRoute('/profile/travellers');
    await fillLogin('  ASHA@example.com ', TEST_USER.password);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Saved travellers' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/profile/travellers');
    expect(api.calls()).toContain('POST /auth/login');
    // The form normalizes the email with the shared contract before sending.
    const login = api.fetch.mock.calls.find(([url]) => String(url).endsWith('/auth/login'))!;
    expect(JSON.parse(String((login[1] as RequestInit).body))).toEqual({
      email: 'asha@example.com',
      password: TEST_USER.password,
    });
  });

  it('ignores an off-site ?redirect= and lands on the profile', async () => {
    installFakeAccountApi({ signedIn: false });
    const { router } = renderRoute('/login?redirect=https%3A%2F%2Fevil.example%2F');
    await fillLogin(TEST_USER.email, TEST_USER.password);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your profile' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/profile');
  });

  it('skips the sign-in page for people who are already signed in', async () => {
    installFakeAccountApi({ signedIn: true });
    const { router } = renderRoute('/login');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your profile' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/profile');
  });

  it('says so when the session check itself fails, instead of bouncing to sign-in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const { router } = renderRoute('/profile');
    expect(
      await screen.findByText("We couldn't check whether you're signed in"),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/profile');
  });

  it('treats a server error from the session check as a failed check, not as signed out', async () => {
    const api = installFakeAccountApi({ signedIn: true });
    api.failNext('GET', '/auth/session', 503, 'SERVICE_UNAVAILABLE');
    const { router } = renderRoute('/profile');
    expect(
      await screen.findByText("We couldn't check whether you're signed in"),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/profile');

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your profile' }),
    ).toBeInTheDocument();
  });

  it('when a session ends on the server, protected pages go to sign-in with an explanation', async () => {
    const api = installFakeAccountApi({ signedIn: true });
    const { router } = renderRoute('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Your profile' });

    api.state.signedIn = false; // e.g. revoked from another device
    await act(() => router.navigate('/profile/travellers'));
    expect(await screen.findByText("You've been signed out")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe('?redirect=%2Fprofile%2Ftravellers');
  });
});

describe('sign in', () => {
  it('validates on the client without sending a request', async () => {
    const api = installFakeAccountApi();
    renderRoute('/login');
    await screen.findByRole('heading', { name: 'Welcome back' });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(field(/email address/i)).toHaveAttribute('aria-invalid', 'true');
    expect(api.calls()).toEqual(['GET /auth/session']);
  });

  it('shows the same generic message for a wrong password', async () => {
    installFakeAccountApi();
    renderRoute('/login');
    await fillLogin(TEST_USER.email, 'not the right one');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That email and password combination is not correct.');
    await waitFor(() => expect(alert.parentElement).toHaveFocus());
  });

  it('explains rate limiting and network failures', async () => {
    const api = installFakeAccountApi();
    renderRoute('/login');
    await fillLogin(TEST_USER.email, TEST_USER.password);
    api.failNext('POST', '/auth/login', 429, 'RATE_LIMITED', 'Too many attempts. Try again later.');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts');
  });

  it('submits once even if the button is pressed repeatedly', async () => {
    const api = installFakeAccountApi();
    const release = api.hold('POST', '/auth/login');
    renderRoute('/login?redirect=%2Fprofile');
    await fillLogin(TEST_USER.email, TEST_USER.password);
    const button = screen.getByRole('button', { name: 'Sign in' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /signing in/i }));
    release();
    await screen.findByRole('heading', { level: 1, name: 'Your profile' });
    expect(api.calls().filter((c) => c === 'POST /auth/login')).toHaveLength(1);
  });

  it('shows and hides the password', async () => {
    installFakeAccountApi();
    renderRoute('/login');
    await screen.findByRole('heading', { name: 'Welcome back' });
    const input = field(/^password/i);
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'current-password');
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(input).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('never puts credentials or session data in browser storage', async () => {
    installFakeAccountApi();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderRoute('/login');
    await fillLogin(TEST_USER.email, TEST_USER.password);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { level: 1, name: 'Your profile' });
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe('');
  });

  it('uses the focused auth layout: no site navigation or marketing footer', async () => {
    installFakeAccountApi();
    renderRoute('/login');
    await screen.findByRole('heading', { name: 'Welcome back' });
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Skip to content' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /google|apple|facebook/i })).toBeNull();
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/register',
    );
  });
});

describe('registration', () => {
  async function fillRegister(values: {
    name: string;
    email: string;
    password: string;
    confirm: string;
  }) {
    type(await screen.findByRole('textbox', { name: /your name/i }), values.name);
    type(screen.getByRole('textbox', { name: /email address/i }), values.email);
    type(field(/^password/i), values.password);
    type(field(/confirm password/i), values.confirm);
  }

  it('checks the shared password rules and the confirmation before sending', async () => {
    const api = installFakeAccountApi({ account: null });
    renderRoute('/register');
    await fillRegister({
      name: 'Ben',
      email: 'ben@example.com',
      password: 'short',
      confirm: 'shorter',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Use at least 10 characters.')).toBeInTheDocument();
    expect(screen.getByText("The passwords don't match.")).toBeInTheDocument();
    expect(api.calls()).toEqual(['GET /auth/session']);
  });

  it('creates the account, signs in and welcomes the person', async () => {
    const api = installFakeAccountApi({ account: null });
    const { router } = renderRoute('/register');
    await fillRegister({
      name: 'Ben  Das',
      email: 'Ben@Example.com',
      password: 'quiet harbour lantern',
      confirm: 'quiet harbour lantern',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your profile' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/profile');
    expect(await screen.findByText('Welcome to Wayora, Ben')).toBeInTheDocument();
    const call = api.fetch.mock.calls.find(([url]) => String(url).endsWith('/auth/register'))!;
    // confirmPassword is client-only; the name and email are normalized.
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      name: 'Ben Das',
      email: 'ben@example.com',
      password: 'quiet harbour lantern',
    });
  });

  it('reports a duplicate email without saying more than the API does', async () => {
    installFakeAccountApi();
    renderRoute('/register');
    await fillRegister({
      name: 'Asha',
      email: TEST_USER.email,
      password: 'quiet harbour lantern',
      confirm: 'quiet harbour lantern',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't create an account/i);
  });
});

describe('header and drawer', () => {
  it('signed out: Sign in and Create account', async () => {
    installFakeAccountApi();
    renderRoute('/discover');
    expect(await screen.findByRole('link', { name: 'Create account' })).toHaveAttribute(
      'href',
      '/register',
    );
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?redirect=%2Fdiscover',
    );
  });

  it('signed in: an account menu with profile, travellers and sign out', async () => {
    const api = installFakeAccountApi({ signedIn: true });
    const { router } = renderRoute('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Your profile' });
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Plan a trip' })).toBeInTheDocument();

    const trigger = screen.getByRole('button', { name: 'Account menu for Asha Rao' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Profile' })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Saved travellers' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Saved travellers' }),
    ).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Account menu for Asha Rao' }), {
      key: 'Enter',
    });
    fireEvent.click(
      within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Sign out' }),
    );
    // Signing out from a protected page goes home, signed out.
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(await screen.findByRole('link', { name: 'Create account' })).toBeInTheDocument();
    expect(api.calls()).toContain('POST /auth/logout');
    expect(await screen.findByText("You're signed out")).toBeInTheDocument();
  });

  it('drawer: shows the account and signs out', async () => {
    installFakeAccountApi({ signedIn: true });
    renderRoute('/discover');
    // Wait for the page itself: until then the header belongs to the loading fallback.
    await screen.findByRole('heading', { level: 1 });
    await screen.findByRole('button', { name: 'Account menu for Asha Rao' });
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Main menu' });
    expect(within(drawer).getByRole('link', { name: 'Profile' })).toHaveAttribute(
      'href',
      '/profile',
    );
    expect(within(drawer).getByRole('link', { name: 'Saved travellers' })).toHaveAttribute(
      'href',
      '/profile/travellers',
    );
    fireEvent.click(within(drawer).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('link', { name: 'Create account' })).toBeInTheDocument();
  });

  it('keeps people signed in and reports the error when sign-out fails', async () => {
    const api = installFakeAccountApi({ signedIn: true });
    renderRoute('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Your profile' });
    api.failNext('POST', '/auth/logout', 503, 'SERVICE_UNAVAILABLE');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText("We couldn't sign you out")).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Your profile' })).toBeInTheDocument();
  });
});

describe('profile', () => {
  it('edits the name with save and cancel', async () => {
    const api = installFakeAccountApi({ signedIn: true });
    renderRoute('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Your profile' });

    fireEvent.click(screen.getByRole('button', { name: 'Edit name' }));
    type(screen.getByRole('textbox', { name: /your name/i }), 'Someone Else');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: 'Edit name' })).toHaveFocus();
    expect(screen.queryByText('Someone Else')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit name' }));
    type(screen.getByRole('textbox', { name: /your name/i }), '');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Enter your name.')).toBeInTheDocument();

    type(screen.getByRole('textbox', { name: /your name/i }), '  Asha   R. ');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Profile updated')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Edit name' })).toHaveFocus();
    expect(screen.getAllByText('Asha R.').length).toBeGreaterThan(0);
    expect(api.state.account!.name).toBe('Asha R.');
    // The header follows the same cached user.
    expect(screen.getByRole('button', { name: 'Account menu for Asha R.' })).toBeInTheDocument();
  });

  it('signs out on all devices after confirmation', async () => {
    const api = installFakeAccountApi({ signedIn: true });
    const { router } = renderRoute('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Your profile' });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out on all devices' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign out on all devices?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(api.calls()).toContain('POST /auth/logout-all');
  });
});

describe('saved travellers', () => {
  it('starts empty, then adds, edits and removes a traveller', { timeout: 20_000 }, async () => {
    const api = installFakeAccountApi({ signedIn: true });
    renderRoute('/profile/travellers');
    expect(await screen.findByText('No saved travellers yet')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add traveller' }));
    let dialog = await screen.findByRole('dialog', { name: 'Add a traveller' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save traveller' }));
    expect(await within(dialog).findByText('Enter a first name.')).toBeInTheDocument();

    type(within(dialog).getByRole('textbox', { name: /first name/i }), 'Ravi');
    type(within(dialog).getByRole('textbox', { name: /last name/i }), 'Rao');
    type(within(dialog).getByLabelText(/date of birth/i), '2015-06-01');
    fireEvent.change(within(dialog).getByRole('combobox', { name: /nationality/i }), {
      target: { value: 'IN' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save traveller' }));

    const list = await screen.findByRole('list', { name: 'Saved travellers' });
    expect(within(list).getByText('Ravi Rao', { selector: 'p' })).toBeInTheDocument();
    expect(within(list).getByText('Born 1 June 2015 · India')).toBeInTheDocument();
    expect(api.state.travellers[0]).toMatchObject({ dateOfBirth: '2015-06-01', nationality: 'IN' });

    fireEvent.click(screen.getByRole('button', { name: 'Edit Ravi Rao' }));
    dialog = await screen.findByRole('dialog', { name: 'Edit traveller' });
    expect(within(dialog).getByRole('textbox', { name: /first name/i })).toHaveValue('Ravi');
    type(within(dialog).getByRole('textbox', { name: /first name/i }), 'Ravindra');
    type(within(dialog).getByLabelText(/date of birth/i), '');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Ravindra Rao', { selector: 'p' })).toBeInTheDocument();
    expect(api.state.travellers[0]).toMatchObject({ firstName: 'Ravindra', dateOfBirth: null });

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ravindra Rao' }));
    dialog = await screen.findByRole('dialog', { name: 'Remove Ravindra Rao?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep traveller' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.state.travellers).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ravindra Rao' }));
    dialog = await screen.findByRole('dialog', { name: 'Remove Ravindra Rao?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove traveller' }));
    expect(await screen.findByText('No saved travellers yet')).toBeInTheDocument();
    expect(api.state.travellers).toHaveLength(0);
  });

  it('saves once even when Save is pressed twice', async () => {
    const api = installFakeAccountApi({ signedIn: true });
    renderRoute('/profile/travellers');
    fireEvent.click(await screen.findByRole('button', { name: 'Add traveller' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a traveller' });
    type(within(dialog).getByRole('textbox', { name: /first name/i }), 'Mira');
    type(within(dialog).getByRole('textbox', { name: /last name/i }), 'Rao');
    const release = api.hold('POST', '/users/me/travellers');
    const save = within(dialog).getByRole('button', { name: 'Save traveller' });
    fireEvent.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    fireEvent.click(save);
    release();
    expect(await screen.findByText('Mira Rao', { selector: 'p' })).toBeInTheDocument();
    expect(api.calls().filter((c) => c === 'POST /users/me/travellers')).toHaveLength(1);
  });

  it('shows an error with a retry when the list fails to load', async () => {
    const api = installFakeAccountApi({ signedIn: true });
    api.failNext('GET', '/users/me/travellers', 500, 'INTERNAL_ERROR');
    renderRoute('/profile/travellers');
    expect(await screen.findByText("We couldn't load your travellers")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No saved travellers yet')).toBeInTheDocument();
  });

  it('shows a loading state while the list loads', async () => {
    const api = installFakeAccountApi({ signedIn: true });
    const release = api.hold('GET', '/users/me/travellers');
    renderRoute('/profile/travellers');
    expect(
      await screen.findByRole('status', { name: 'Loading saved travellers' }),
    ).toBeInTheDocument();
    release();
    expect(await screen.findByText('No saved travellers yet')).toBeInTheDocument();
  });
});
