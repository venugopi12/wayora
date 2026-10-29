import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlannedTrip } from '@wayora/contracts';
import { PERSON, budgetState, expense, type FakeBudgetState } from './fake-budget-api';
import { installFakePlannerApi, plannedTrip } from './fake-planner-api';
import { renderRoute } from './render';

/*
 * The plan budget page (docs/planner.md#budget): loading, empty, error and
 * saved states; setting a budget; adding expenses with an exact split
 * preview and validation; balances with the sign convention; settlement
 * suggestions recorded only as payments made outside Wayora; viewers
 * without edit controls; conflicts; and the budget card on the plan page.
 * The real rules are tested against the API in
 * apps/api/test/integration/planner-budget.test.ts.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const JOURNEY = { timeout: 30_000 };

const team: FakeBudgetState['people'] = [
  { id: PERSON.asha, name: 'Asha Rao', initials: 'AR', isYou: true, role: 'owner' },
  { id: PERSON.ravi, name: 'Ravi Kumar', initials: 'RK', isYou: false, role: 'editor' },
  { id: PERSON.meera, name: 'Meera Iyer', initials: 'MI', isYou: false, role: 'viewer' },
];

function setup(state: FakeBudgetState, trip: PlannedTrip = plannedTrip({ memberCount: 2 })) {
  const api = installFakePlannerApi({ trips: [trip], budgets: { [trip.id]: state } });
  const view = renderRoute(`/plans/${trip.id}/budget`);
  return { api, trip, ...view };
}

describe('Budget page', () => {
  it('shows a loading state, then useful empty states', async () => {
    setup(budgetState({ people: team }));
    expect(await screen.findByRole('status', { name: 'Loading the budget' })).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Budget for Goa with friends' }),
    ).toBeInTheDocument();
    expect(screen.getByText('No budget yet')).toBeInTheDocument();
    expect(await screen.findByText('No expenses yet')).toBeInTheDocument();
    expect(await screen.findByText(/No balances yet/)).toBeInTheDocument();
    expect(screen.getByText(/Wayora doesn’t move money/)).toBeInTheDocument();
  });

  it('explains a failure to load and retries', async () => {
    const trip = plannedTrip();
    const api = installFakePlannerApi({ trips: [trip] });
    api.failNext('GET', /\/budget$/, 500, 'INTERNAL_ERROR');
    renderRoute(`/plans/${trip.id}/budget`);
    expect(await screen.findByText("We couldn't load this budget")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: /Budget for/ }),
    ).toBeInTheDocument();
  });

  it('sets a budget with category amounts in integer minor units', JOURNEY, async () => {
    const { api } = setup(budgetState({ people: team }));
    fireEvent.click(await screen.findByRole('button', { name: 'Set a budget' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set a budget' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save budget' }));
    expect(await within(dialog).findByText(/Enter a total above zero/)).toBeInTheDocument();
    // Keyboard users land on the field to fix.
    expect(within(dialog).getByRole('textbox', { name: /Total budget/ })).toHaveFocus();
    expect(api.writes()).toHaveLength(0);

    fireEvent.change(within(dialog).getByRole('textbox', { name: /Total budget/ }), {
      target: { value: '50,000' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Food' }), {
      target: { value: '12000.5' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save budget' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.writes().at(-1)).toMatchObject({
      method: 'PUT',
      body: {
        currency: 'INR',
        totalMinor: '5000000',
        categories: [{ category: 'food', amountMinor: '1200050' }],
      },
    });
    expect(api.writes().at(-1)!.body).not.toHaveProperty('version');
    expect(await screen.findByText('Budget set')).toBeInTheDocument();
    const summary = screen.getByRole('region', { name: 'Summary' });
    // Total and remaining (nothing recorded yet).
    expect(within(summary).getAllByText('₹50,000.00', { selector: 'dd' })).toHaveLength(2);
    expect(within(summary).getByRole('meter', { name: 'Budget used' })).toHaveAttribute(
      'aria-valuetext',
      '0.00% of the budget used',
    );
  });

  it('separates paid, planned and other-currency totals and flags over budget', async () => {
    setup(
      budgetState({
        people: team,
        budget: {
          currency: 'INR',
          totalMinor: '100000',
          categories: [{ category: 'food', amountMinor: '50000' }],
          version: 1,
          updatedAt: '2026-10-22T10:00:00.000Z',
        },
        expenses: [
          expense({
            description: 'Dinner',
            amountMinor: '120000',
            parts: [
              {
                personId: PERSON.asha,
                paidMinor: '120000',
                shareMinor: '120000',
                basisPoints: null,
              },
            ],
          }),
          expense({
            description: 'Ferry estimate',
            amountMinor: '30000',
            status: 'planned',
            splitMethod: null,
            category: 'local_transport',
          }),
          expense({
            description: 'Airport taxi',
            amountMinor: '4500',
            currency: 'USD',
            parts: [
              { personId: PERSON.asha, paidMinor: '4500', shareMinor: '4500', basisPoints: null },
            ],
          }),
        ],
      }),
    );
    const summary = await screen.findByRole('region', { name: 'Summary' });
    expect(within(summary).getByText('Over budget by')).toBeInTheDocument();
    expect(within(summary).getByText('₹200.00', { selector: 'dd' })).toBeInTheDocument();
    expect(within(summary).getByRole('meter', { name: 'Budget used' })).toHaveAttribute(
      'aria-valuetext',
      '120.00% of the budget used, over budget',
    );
    expect(within(summary).getByText('Planned (estimates)')).toBeInTheDocument();
    expect(within(summary).getByText('Other currencies (not converted)')).toBeInTheDocument();
    expect(within(summary).getByText('$45.00')).toBeInTheDocument();
    const table = within(summary).getByRole('table', { name: 'Spending by category in INR' });
    expect(within(table).getByText('Over by ₹700.00')).toBeInTheDocument();
    // A planned estimate is labelled and kept out of balances.
    expect(await screen.findByText('Planned · estimate')).toBeInTheDocument();
    expect(screen.getByText(/An estimate: not counted as paid/)).toBeInTheDocument();
  });
});

describe('Adding expenses', () => {
  it('previews an exact equal split and saves it once', JOURNEY, async () => {
    const { api } = setup(budgetState({ people: team }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Add expense' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add an expense' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Description/ }), {
      target: { value: 'Houseboat' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Category/ }), {
      target: { value: 'hotels' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Amount/ }), {
      target: { value: '1000' },
    });
    for (const name of ['Asha Rao (you)', 'Ravi Kumar', 'Meera Iyer']) {
      fireEvent.click(within(dialog).getByRole('checkbox', { name }));
    }
    const preview = within(dialog).getByRole('list', { name: 'Each person’s share' });
    expect(
      within(preview)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Asha Rao (you): ₹333.34', 'Ravi Kumar: ₹333.33', 'Meera Iyer: ₹333.33']);
    expect(within(dialog).getByText(/doesn’t divide evenly/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add expense' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const posts = api.writes().filter((w) => w.path.endsWith('/expenses'));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.key).toBeTruthy();
    expect(posts[0]!.body).toMatchObject({
      description: 'Houseboat',
      category: 'hotels',
      amountMinor: '100000',
      currency: 'INR',
      status: 'paid',
      paidBy: [{ personId: PERSON.asha, amountMinor: '100000' }],
      split: { method: 'equal', participants: [PERSON.asha, PERSON.ravi, PERSON.meera] },
    });
    expect(await screen.findByText('Added “Houseboat”')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Expenses' });
    expect(within(list).getByText('Houseboat', { selector: 'p' })).toBeInTheDocument();

    // Balances follow the convention: positive = owed, negative = owes.
    const balances = await screen.findByRole('list', { name: 'Balances in INR' });
    await waitFor(() =>
      expect(within(balances).getByText('You are owed ₹666.66')).toBeInTheDocument(),
    );
    expect(within(balances).getByText('Ravi Kumar owes ₹333.33')).toBeInTheDocument();
    expect(within(balances).getByText('Meera Iyer owes ₹333.33')).toBeInTheDocument();
  });

  it('refuses a custom split that doesn’t add up, without sending it', JOURNEY, async () => {
    const { api } = setup(budgetState({ people: team }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Add expense' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add an expense' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Description/ }), {
      target: { value: 'Scooters' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Category/ }), {
      target: { value: 'local_transport' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Amount/ }), {
      target: { value: '900' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'By amount' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Asha Rao \(you\)’s share/ }), {
      target: { value: '500' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Ravi Kumar’s share/ }), {
      target: { value: '300' },
    });
    expect(within(dialog).getByText('₹100.00 left to assign.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add expense' }));
    expect(
      await within(dialog).findByText('The shares must add up exactly to the amount.'),
    ).toBeInTheDocument();
    expect(api.writes()).toHaveLength(0);

    fireEvent.change(within(dialog).getByRole('textbox', { name: /Ravi Kumar’s share/ }), {
      target: { value: '400' },
    });
    expect(within(dialog).getByText('Every share is assigned.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add expense' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toMatchObject({
      split: {
        method: 'custom',
        shares: [
          { personId: PERSON.asha, amountMinor: '50000' },
          { personId: PERSON.ravi, amountMinor: '40000' },
        ],
      },
    });
  });

  it('previews a percentage split with the largest-remainder rule', JOURNEY, async () => {
    setup(budgetState({ people: team }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Add expense' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add an expense' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Amount/ }), {
      target: { value: '100' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'By percentage' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Asha Rao \(you\) \(%\)/ }), {
      target: { value: '33.33' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Ravi Kumar \(%\)/ }), {
      target: { value: '33.33' },
    });
    expect(within(dialog).getByText('66.66% of 100% assigned.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Meera Iyer \(%\)/ }), {
      target: { value: '33.34' },
    });
    const preview = within(dialog).getByRole('list', { name: 'Each person’s share' });
    expect(
      within(preview)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Asha Rao (you): ₹33.33', 'Ravi Kumar: ₹33.33', 'Meera Iyer: ₹33.34']);
  });

  it('records a planned estimate without payer or split', JOURNEY, async () => {
    const { api } = setup(budgetState({ people: team }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Add expense' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add an expense' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Description/ }), {
      target: { value: 'Dolphin trip' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Category/ }), {
      target: { value: 'activities' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Amount/ }), {
      target: { value: '2400' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Planned (estimate)' }));
    expect(within(dialog).queryByRole('group', { name: 'Paid by' })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add expense' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    const body = api.writes()[0]!.body!;
    expect(body).toMatchObject({ status: 'planned', amountMinor: '240000' });
    expect(body).not.toHaveProperty('paidBy');
    expect(body).not.toHaveProperty('split');
  });
});

describe('Editing and deleting', () => {
  const dinner = () =>
    expense({
      description: 'Dinner',
      amountMinor: '90000',
      parts: [
        { personId: PERSON.asha, paidMinor: '90000', shareMinor: '45000', basisPoints: null },
        { personId: PERSON.ravi, paidMinor: '0', shareMinor: '45000', basisPoints: null },
      ],
    });

  it('explains a conflicting edit instead of overwriting it', JOURNEY, async () => {
    const { api } = setup(budgetState({ people: team, expenses: [dinner()] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Dinner' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit expense' });
    expect(within(dialog).getByRole('textbox', { name: /Amount/ })).toHaveValue('900.00');
    expect(within(dialog).getByRole('checkbox', { name: 'Ravi Kumar' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Meera Iyer' })).not.toBeChecked();
    api.failNext('PUT', /\/expenses\//, 409, 'PLAN_OUT_OF_DATE', 'Changed.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save expense' }));
    expect(
      await within(dialog).findByText('Someone else changed this expense'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save expense' })).toBeDisabled();
    expect(api.writes().at(-1)!.body).toMatchObject({ version: 1 });
  });

  it('deletes an expense only after confirmation', JOURNEY, async () => {
    const { api } = setup(budgetState({ people: team, expenses: [dinner()] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Dinner' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this expense?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.writes()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Dinner' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Delete this expense?' })).getByRole(
        'button',
        { name: 'Delete expense' },
      ),
    );
    expect(await screen.findByText('Deleted “Dinner”')).toBeInTheDocument();
    expect(api.writes()).toMatchObject([{ method: 'DELETE' }]);
    expect(await screen.findByText('No expenses yet')).toBeInTheDocument();
  });
});

describe('Settling up', () => {
  it(
    'suggests payments as recommendations and records one made outside Wayora',
    JOURNEY,
    async () => {
      const { api } = setup(
        budgetState({
          people: team,
          expenses: [
            expense({
              description: 'Villa',
              amountMinor: '300000',
              parts: [
                {
                  personId: PERSON.asha,
                  paidMinor: '300000',
                  shareMinor: '100000',
                  basisPoints: null,
                },
                { personId: PERSON.ravi, paidMinor: '0', shareMinor: '100000', basisPoints: null },
                { personId: PERSON.meera, paidMinor: '0', shareMinor: '100000', basisPoints: null },
              ],
            }),
          ],
        }),
      );
      expect(await screen.findByText(/Recommendations only/)).toBeInTheDocument();
      expect(screen.getByText(/Nothing has been paid/)).toBeInTheDocument();
      const record = screen.getAllByRole('button', { name: /Record as paid outside Wayora/ });
      expect(record).toHaveLength(2);
      fireEvent.click(record[0]!);
      const dialog = await screen.findByRole('dialog', {
        name: 'Record a payment made outside Wayora',
      });
      expect(within(dialog).getByRole('textbox', { name: /Amount/ })).toHaveValue('1000.00');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Record payment' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      const post = api.writes().find((w) => w.path.endsWith('/settlements'))!;
      expect(post.key).toBeTruthy();
      expect(post.body).toMatchObject({ amountMinor: '100000', currency: 'INR' });
      expect(await screen.findByRole('heading', { name: 'Recorded payments' })).toBeInTheDocument();
      expect(screen.getByText(/Wayora didn’t process or verify them/)).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /Record as paid outside Wayora/ })).toHaveLength(
        1,
      );
    },
  );
});

describe('Roles', () => {
  it('shows a viewer the figures without edit controls', async () => {
    const trip = plannedTrip({
      access: { role: 'viewer', canEdit: false, canManage: false },
      owner: { name: 'Asha Rao', isYou: false },
      memberCount: 2,
    });
    setup(
      budgetState({
        people: team.map((p) => ({ ...p, isYou: p.id === PERSON.meera })),
        canAddExpenses: false,
        canManageBudget: false,
        canRecordSettlements: false,
        expenses: [
          expense({
            description: 'Dinner',
            amountMinor: '60000',
            canEdit: false,
            parts: [
              { personId: PERSON.asha, paidMinor: '60000', shareMinor: '30000', basisPoints: null },
              { personId: PERSON.meera, paidMinor: '0', shareMinor: '30000', basisPoints: null },
            ],
          }),
        ],
      }),
      trip,
    );
    expect(await screen.findByText('Dinner')).toBeInTheDocument();
    expect(screen.getByText(/You can view this budget/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add expense/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /budget/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Edit Dinner|Delete Dinner/ }),
    ).not.toBeInTheDocument();
    // A viewer may record a payment they're part of.
    expect(await screen.findByText('You owe ₹300.00')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Record as paid outside Wayora/ }),
    ).toBeInTheDocument();
  });
});

describe('Plan page', () => {
  it('summarises the budget and links to it', async () => {
    const trip = plannedTrip();
    installFakePlannerApi({
      trips: [trip],
      budgets: {
        [trip.id]: budgetState({
          budget: {
            currency: 'INR',
            totalMinor: '1000000',
            categories: [],
            version: 1,
            updatedAt: '2026-10-22T10:00:00.000Z',
          },
          expenses: [
            expense({
              description: 'Dinner',
              amountMinor: '250000',
              parts: [
                {
                  personId: PERSON.asha,
                  paidMinor: '250000',
                  shareMinor: '250000',
                  basisPoints: null,
                },
              ],
            }),
          ],
        }),
      },
    });
    const { router } = renderRoute(`/plans/${trip.id}`);
    const card = await screen.findByRole('region', { name: 'Budget & expenses' });
    expect(await within(card).findByText('₹10,000.00')).toBeInTheDocument();
    expect(within(card).getByText(/25\.00%/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('link', { name: 'Open budget' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/plans/${trip.id}/budget`));
  });

  it('adds a demo booking as a planned estimate, never as paid', JOURNEY, async () => {
    const { api } = setup(
      budgetState({
        bookingImport: {
          reference: 'WAY-ABC123',
          amountMinor: '450000',
          currency: 'INR',
          paid: false,
          demo: true,
        },
      }),
    );
    expect(
      await screen.findByText(/It’s a demo booking, so no money was charged/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add booking as expense' }));
    expect(await screen.findByText('Added “Booking WAY-ABC123”')).toBeInTheDocument();
    expect(api.writes()[0]!.key).toBeTruthy();
    expect(await screen.findByText('Planned · estimate')).toBeInTheDocument();
  });
});
