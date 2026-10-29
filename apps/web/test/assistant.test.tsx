import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantBlock } from '@wayora/contracts';
import {
  AI_SOURCE,
  DEMO_SOURCE,
  conversation,
  installFakeAssistantApi,
  message,
  status,
} from './fake-assistant-api';
import { item, plannedTrip } from './fake-planner-api';
import { renderRoute } from './render';

/*
 * The travel assistant page (docs/assistant.md#web): loading, empty, error and
 * retry states; conversation history; honest source labels; proposals that
 * change nothing until reviewed and confirmed; viewers without apply
 * controls; keyboard sending; and model text rendered as text, never HTML.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const JOURNEY = { timeout: 30_000 };
const D1 = '2026-11-12';

const itinerary: AssistantBlock = {
  type: 'itinerary',
  id: 'b1',
  title: '3 balanced days in Goa',
  destination: { name: 'Goa', catalogId: 'goa' },
  dayCount: 3,
  pace: 'balanced',
  budgetNote: null,
  days: [
    {
      dayNumber: 1,
      theme: 'Candolim',
      activities: [
        {
          title: 'Fort Aguada',
          category: 'sightseeing',
          startTime: null,
          durationMinutes: 90,
          area: 'Candolim',
          note: null,
          catalogId: 'goa:fort-aguada',
        },
        {
          title: 'Spice farm',
          category: 'nature',
          startTime: null,
          durationMinutes: 120,
          area: null,
          note: null,
          catalogId: null,
        },
      ],
    },
    {
      dayNumber: 2,
      theme: null,
      activities: [
        {
          title: 'Palolem Beach',
          category: 'beach',
          startTime: null,
          durationMinutes: 180,
          area: null,
          note: null,
          catalogId: null,
        },
      ],
    },
  ],
};

describe('Travel assistant', () => {
  it('shows loading, then suggested prompts, and labels the demo honestly', async () => {
    installFakeAssistantApi();
    renderRoute('/assistant');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Travel assistant' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Demo assistant: rule-based, not AI')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Plan a 4-day trip to Goa for two people.' }),
    ).toBeEnabled();
    // Plan-specific prompts only appear in a conversation about a plan.
    expect(
      screen.queryByRole('button', { name: 'Make my itinerary less hectic.' }),
    ).not.toBeInTheDocument();
    expect(await screen.findByText(/None yet/)).toBeInTheDocument();
  });

  it('says when the assistant is unavailable and keeps everything else working', async () => {
    installFakeAssistantApi({ status: status({ available: false, source: null }) });
    renderRoute('/assistant');
    expect(await screen.findByText('The assistant isn’t available right now')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Message the assistant/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('sends with Enter, waits honestly, and shows the reply as text', JOURNEY, async () => {
    const api = installFakeAssistantApi({
      reply: () => [
        { type: 'text', text: '<img src=x onerror=alert(1)> Goa is lovely.\n\nPack light.' },
      ],
    });
    const release = api.hold(/\/messages$/);
    renderRoute('/assistant');
    const box = await screen.findByRole('textbox', { name: /Message the assistant/ });
    // Disabled until the assistant's status is known.
    await waitFor(() => expect(box).toBeEnabled());
    fireEvent.change(box, { target: { value: 'Tell me about Goa' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(api.writes()).toHaveLength(0); // Shift+Enter is a new line
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText(/Waiting for the assistant’s reply/)).toBeInTheDocument();
    expect(screen.queryByText(/typing/i)).not.toBeInTheDocument();
    release();
    const reply = await screen.findByText(/Goa is lovely\./);
    expect(reply.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getByText('Pack light.')).toBeInTheDocument();
    expect(screen.getByText('Demo · rule-based, not AI')).toBeInTheDocument();
    const [create, send] = api.writes();
    expect(create).toMatchObject({ method: 'POST', path: '/assistant/conversations', body: {} });
    expect(send).toMatchObject({ body: { text: 'Tell me about Goa' } });
    expect(send!.key).toBeTruthy();
    expect(await screen.findByText('The assistant replied.')).toBeInTheDocument();
  });

  it('explains a failed reply and retries the same request', JOURNEY, async () => {
    const id = '01890000-0000-7000-9000-000000000999';
    const api = installFakeAssistantApi({
      conversations: [conversation({ id, title: 'Goa ideas' })],
    });
    api.failNext(
      /\/messages$/,
      504,
      'ASSISTANT_TIMEOUT',
      'The assistant took too long to answer. Try again.',
    );
    renderRoute(`/assistant/${id}`);
    const box = await screen.findByRole('textbox', { name: /Message the assistant/ });
    await waitFor(() => expect(box).toBeEnabled());
    fireEvent.change(box, { target: { value: 'Plan Goa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'The assistant took too long to answer. Try again. Nothing was saved.',
    );
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Here you go.')).toBeInTheDocument();
    const sends = api.writes().filter((w) => w.path.endsWith('/messages'));
    expect(sends).toHaveLength(2);
    expect(sends[0]!.key).toBe(sends[1]!.key);
  });

  it('shows saved history with AI and demo labels', async () => {
    const id = '01890000-0000-7000-9000-000000000998';
    installFakeAssistantApi({
      conversations: [
        conversation({
          id,
          title: 'Kyoto',
          messages: [
            message({ role: 'user', text: 'Plan Kyoto' }),
            message({
              blocks: [{ type: 'text', text: 'Earlier demo answer' }],
              source: DEMO_SOURCE,
            }),
            message({ role: 'user', text: 'And food?' }),
            message({ blocks: [{ type: 'text', text: 'An AI answer' }], source: AI_SOURCE }),
          ],
        }),
      ],
    });
    renderRoute(`/assistant/${id}`);
    const list = await screen.findByRole('list', { name: 'Messages' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    expect(within(list).getByText('Earlier demo answer')).toBeInTheDocument();
    expect(within(list).getByText('AI-generated')).toBeInTheDocument();
    expect(within(list).getByText('Demo · rule-based, not AI')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Your conversations' });
    expect(within(nav).getByRole('link', { name: /Kyoto/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it(
    'previews an itinerary and applies only the chosen activities after confirming',
    JOURNEY,
    async () => {
      const trip = plannedTrip({
        title: 'Goa with friends',
        items: [item({ title: 'Sunrise yoga', day: D1 })],
      });
      const id = '01890000-0000-7000-9000-000000000997';
      const api = installFakeAssistantApi({
        trips: [trip],
        conversations: [
          conversation({
            id,
            trip: { id: trip.id, title: trip.title },
            tripAccess: trip.access,
            messages: [
              message({ role: 'user', text: 'Plan Goa' }),
              message({ blocks: [itinerary], source: DEMO_SOURCE }),
            ],
          }),
        ],
      });
      renderRoute(`/assistant/${id}`);
      const card = await screen.findByRole('region', { name: '3 balanced days in Goa' });
      expect(within(card).getByText('Demo suggestion · not saved')).toBeInTheDocument();
      expect(within(card).getByText(/about 1 h 30 min \(estimate\)/)).toBeInTheDocument();

      // Cancel changes nothing.
      fireEvent.click(within(card).getByRole('button', { name: /Review and add to a plan/ }));
      let dialog = await screen.findByRole('dialog', { name: 'Add this proposal to a plan' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(api.writes().filter((w) => w.path.endsWith('/apply'))).toHaveLength(0);

      fireEvent.click(within(card).getByRole('button', { name: /Review and add to a plan/ }));
      dialog = await screen.findByRole('dialog', { name: 'Add this proposal to a plan' });
      expect(within(dialog).getByRole('combobox', { name: /Plan/ })).toHaveValue(trip.id);
      fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Spice farm' }));
      expect(await within(dialog).findByText('Checked against the plan')).toBeInTheDocument();
      expect(within(dialog).getByText(/they stay as they are/)).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add 2 activities' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      const applied = api.writes().filter((w) => w.path.endsWith('/apply'));
      expect(applied).toHaveLength(1);
      expect(applied[0]!.key).toBeTruthy();
      expect(applied[0]!.body).toEqual({
        action: 'add_itinerary',
        blockId: 'b1',
        tripId: trip.id,
        selected: [
          { dayNumber: 1, index: 0 },
          { dayNumber: 2, index: 0 },
        ],
        confirm: true,
      });
      expect(await screen.findByText('Applied it.')).toBeInTheDocument();
    },
  );

  it('can start a new plan from a proposal, with a name and first day', JOURNEY, async () => {
    const trip = plannedTrip();
    const id = '01890000-0000-7000-9000-000000000996';
    const api = installFakeAssistantApi({
      trips: [trip],
      conversations: [
        conversation({ id, messages: [message({ blocks: [itinerary], source: DEMO_SOURCE })] }),
      ],
    });
    renderRoute(`/assistant/${id}`);
    fireEvent.click(await screen.findByRole('button', { name: /Review and add to a plan/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add this proposal to a plan' });
    expect(within(dialog).getByRole('radio', { name: 'A new plan' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create plan with 3' }));
    expect(
      await within(dialog).findByText('Choose the first day of the trip.'),
    ).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/First day/), {
      target: { value: '2026-12-01' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create plan with 3' }));
    await waitFor(() =>
      expect(api.writes().filter((w) => w.path.endsWith('/apply'))).toHaveLength(1),
    );
    expect(api.writes().at(-1)!.body).toMatchObject({
      action: 'create_plan',
      title: '3 balanced days in Goa',
      startDate: '2026-12-01',
      confirm: true,
    });
  });

  it('offers a budget proposal to editors, showing what it replaces', JOURNEY, async () => {
    const trip = plannedTrip({ title: 'Goa with friends' });
    const id = '01890000-0000-7000-9000-000000000995';
    const budget: AssistantBlock = {
      type: 'budget',
      id: 'b2',
      currency: 'INR',
      categories: [
        { category: 'hotels', amountMinor: '700000' },
        { category: 'food', amountMinor: '300000' },
      ],
      totalMinor: '1000000',
      tips: ['Share rooms.'],
    };
    const api = installFakeAssistantApi({
      trips: [trip],
      conversations: [
        conversation({
          id,
          trip: { id: trip.id, title: trip.title },
          tripAccess: trip.access,
          messages: [message({ blocks: [budget], source: AI_SOURCE })],
        }),
      ],
    });
    renderRoute(`/assistant/${id}`);
    const card = await screen.findByRole('region', { name: 'Budget proposal' });
    expect(within(card).getByText('AI suggestion · estimates')).toBeInTheDocument();
    expect(within(card).getByText('₹10,000.00')).toBeInTheDocument();
    expect(
      within(card).getByText(/exact sum of the amounts above, calculated by Wayora/),
    ).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: /Use as this plan’s budget/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Use this as the plan’s budget?' });
    expect(await within(dialog).findByText('This plan has no budget yet.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save budget' }));
    await waitFor(() =>
      expect(api.writes().filter((w) => w.path.endsWith('/apply'))).toHaveLength(1),
    );
    expect(api.writes().at(-1)!.body).toEqual({
      action: 'apply_budget',
      blockId: 'b2',
      tripId: trip.id,
      confirm: true,
    });
  });

  it('gives viewers the suggestions without apply controls', async () => {
    const trip = plannedTrip({
      access: { role: 'viewer', canEdit: false, canManage: false },
      owner: { name: 'Asha Rao', isYou: false },
    });
    const id = '01890000-0000-7000-9000-000000000994';
    installFakeAssistantApi({
      trips: [trip],
      conversations: [
        conversation({
          id,
          trip: { id: trip.id, title: trip.title },
          tripAccess: trip.access,
          messages: [
            message({
              source: DEMO_SOURCE,
              blocks: [
                {
                  type: 'moves',
                  id: 'b2',
                  tripId: trip.id,
                  items: [
                    {
                      itemId: '01890000-0000-7000-9000-000000000111',
                      itemVersion: 1,
                      title: 'Cafe',
                      fromDay: D1,
                      toDay: '2026-11-13',
                      reason: 'Day 1 is busy.',
                    },
                  ],
                },
                {
                  type: 'budget',
                  id: 'b3',
                  currency: 'INR',
                  categories: [{ category: 'food', amountMinor: '100000' }],
                  totalMinor: '100000',
                  tips: [],
                },
              ],
            }),
          ],
        }),
      ],
    });
    renderRoute(`/assistant/${id}`);
    expect(await screen.findByText(/Move/)).toBeInTheDocument();
    expect(screen.getByText('View only')).toBeInTheDocument();
    expect(screen.getByText(/You can view this plan but not change it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move it/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Use as this plan’s budget/ }),
    ).not.toBeInTheDocument();
  });

  it('starts a conversation about a plan from the plan page', JOURNEY, async () => {
    const trip = plannedTrip({ title: 'Goa with friends' });
    const api = installFakeAssistantApi({ trips: [trip] });
    const { router } = renderRoute(`/plans/${trip.id}`);
    fireEvent.click(await screen.findByRole('link', { name: 'Ask the assistant' }));
    await waitFor(() => expect(router.state.location.search).toBe(`?trip=${trip.id}`));
    expect(await screen.findByRole('link', { name: 'Goa with friends' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Make my itinerary less hectic.' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/^\/assistant\/[0-9a-f-]+$/),
    );
    expect(api.writes()[0]).toMatchObject({
      path: '/assistant/conversations',
      body: { tripId: trip.id },
    });
    expect(api.writes()[1]).toMatchObject({
      body: { text: 'Make my itinerary less hectic.', intent: 'review' },
    });

    // What the assistant can see, on request.
    fireEvent.click(await screen.findByText('What the assistant can see about this plan'));
    expect(await screen.findByText('Never shared')).toBeInTheDocument();
    expect(screen.getByText('Names and emails of plan members')).toBeInTheDocument();
  });

  it('lets you tick off a packing list without saving it', async () => {
    const id = '01890000-0000-7000-9000-000000000993';
    const api = installFakeAssistantApi({
      conversations: [
        conversation({
          id,
          messages: [
            message({
              source: DEMO_SOURCE,
              blocks: [
                { type: 'packing', id: 'b1', groups: [{ title: 'Health', items: ['Sunscreen'] }] },
              ],
            }),
          ],
        }),
      ],
    });
    renderRoute(`/assistant/${id}`);
    const box = await screen.findByRole('checkbox', { name: 'Sunscreen' });
    fireEvent.click(box);
    expect(box).toBeChecked();
    expect(api.writes()).toHaveLength(0);
  });

  it('handles a conversation that no longer exists', async () => {
    installFakeAssistantApi();
    renderRoute('/assistant/01890000-0000-7000-9000-000000000001');
    expect(await screen.findByText("We couldn't open that conversation")).toBeInTheDocument();
    renderRoute('/assistant/not-an-id');
    expect(
      (await screen.findAllByText("We couldn't open that conversation")).length,
    ).toBeGreaterThan(0);
  });
});
