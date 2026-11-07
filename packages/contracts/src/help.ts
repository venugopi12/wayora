import { z } from 'zod';
import type { SupportCategory } from './support.js';

/*
 * Help Center content (Phase 27, docs/support.md#help-center).
 *
 * Articles live in the repository, not the database: they change with the
 * product, go through code review, and are shared by the web Help Center and
 * the server (help suggestions and AI drafts ground themselves on them).
 *
 * Every statement describes how Wayora behaves today and must be verifiable
 * in the code. Rules that belong to airlines, hotels, rail or bus operators
 * are never stated as fact: articles mark them as provider-specific
 * (`provider` blocks) and say where they come from. Wayora has no live
 * supplier yet, so every booking is a demo.
 */

export const HELP_CATEGORIES = [
  {
    slug: 'booking',
    title: 'Booking and reservations',
    description: 'How demo bookings work, what each status means, and finding your trips.',
  },
  {
    slug: 'payments',
    title: 'Payments',
    description: 'The demo payment simulator, payment windows and what you pay.',
  },
  {
    slug: 'cancellations',
    title: 'Cancellations',
    description: 'When you can cancel and what cancelling does.',
  },
  {
    slug: 'refunds',
    title: 'Refunds',
    description: 'How refunds are tracked and what each refund state means.',
  },
  {
    slug: 'documents',
    title: 'Travel documents',
    description: 'Tickets, vouchers and the documents your journey may need.',
  },
  {
    slug: 'rewards',
    title: 'Loyalty and rewards',
    description: 'Points, tiers and travel credit.',
  },
  {
    slug: 'promotions',
    title: 'Coupons and promotions',
    description: 'Using coupons and automatic offers at payment.',
  },
  {
    slug: 'account',
    title: 'Account management',
    description: 'Signing in, your details and saved travellers.',
  },
  {
    slug: 'technical',
    title: 'Technical support',
    description: 'When something isn’t working, and how support tickets work.',
  },
] as const;
export type HelpCategorySlug = (typeof HELP_CATEGORIES)[number]['slug'];
export const helpCategorySlugSchema = z.enum(
  HELP_CATEGORIES.map((c) => c.slug) as [HelpCategorySlug, ...HelpCategorySlug[]],
);

export type HelpBlock =
  | { type: 'p'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'steps'; items: string[] }
  /** A rule set by an airline, hotel, operator or other provider, not by Wayora. */
  | { type: 'provider'; text: string }
  /** Something that matters because every booking today is a demo. */
  | { type: 'demo'; text: string };

export interface HelpArticle {
  slug: string;
  category: HelpCategorySlug;
  title: string;
  /** One sentence, shown in lists and search results. */
  summary: string;
  body: HelpBlock[];
  /** Links into the app: label and path. */
  actions?: { label: string; path: string }[];
  related: string[];
  /** Extra words people search with. */
  keywords: string[];
  /** Pre-selected category when contacting support from this article. */
  supportCategory: SupportCategory;
  /** When the content was last checked against the product (YYYY-MM-DD). */
  reviewed: string;
}

const R = '2026-11-06';

export const HELP_ARTICLES: readonly HelpArticle[] = [
  // ── Booking and reservations ──────────────────────────────────────────
  {
    slug: 'what-is-a-demo-booking',
    category: 'booking',
    title: 'What is a demo booking?',
    summary:
      'Every booking on Wayora today is a demo: saved by Wayora, but nothing is reserved or charged.',
    body: [
      {
        type: 'p',
        text: 'Wayora is in development. You can search every service (flights, hotels, trains, buses, metro, cabs and holiday packages) and book any result, but the results are Wayora’s own sample data and the booking is a demo.',
      },
      {
        type: 'list',
        items: [
          'Wayora saves the booking in My trips with a reference like WYD-7KQ2-M9XD (“WYD” means Wayora demo booking).',
          'No airline, hotel, operator or other supplier is contacted, and no seat, room or ticket is reserved.',
          'No real money moves. Payments go through Wayora’s payment simulator.',
          'Prices and times are illustrative, and availability isn’t checked.',
        ],
      },
      {
        type: 'demo',
        text: 'Because nothing is reserved with a supplier, a demo booking can’t be used to travel.',
      },
    ],
    actions: [{ label: 'Go to My trips', path: '/trips' }],
    related: ['booking-statuses', 'how-demo-payments-work', 'cancelling-a-booking'],
    keywords: ['demo', 'real', 'fake', 'sample', 'reservation', 'reserved', 'WYD', 'travel'],
    supportCategory: 'booking',
    reviewed: R,
  },
  {
    slug: 'booking-statuses',
    category: 'booking',
    title: 'What each booking status means',
    summary:
      'Pending, confirmed, cancelled, expired and failed, and how a booking moves between them.',
    body: [
      { type: 'p', text: 'Every booking shows one of these statuses in My trips:' },
      {
        type: 'list',
        items: [
          'Pending: waiting for payment. The payment page shows the time to pay by.',
          'Confirmed: the demo payment succeeded (or no payment was needed), and Wayora marked it confirmed. This is a demo confirmation, not a supplier’s.',
          'Expired: the payment window passed without a successful payment. Nothing was charged.',
          'Cancelled: you cancelled it.',
          'Failed: reserved for a future supplier step. Demo bookings don’t fail.',
        ],
      },
      {
        type: 'p',
        text: 'Each booking’s page lists its history: what changed, when, and who changed it.',
      },
    ],
    actions: [{ label: 'Go to My trips', path: '/trips' }],
    related: ['what-is-a-demo-booking', 'payment-window', 'cancelling-a-booking'],
    keywords: ['status', 'pending', 'confirmed', 'expired', 'failed', 'cancelled', 'history'],
    supportCategory: 'booking',
    reviewed: R,
  },
  {
    slug: 'finding-your-booking',
    category: 'booking',
    title: 'Finding a booking and its reference',
    summary:
      'My trips lists your bookings as upcoming, past or cancelled, each with its reference.',
    body: [
      {
        type: 'steps',
        items: [
          'Sign in and open My trips from the account menu.',
          'Choose Upcoming, Past or Cancelled.',
          'Open a booking to see its reference, dates, travellers, payment and history.',
        ],
      },
      {
        type: 'p',
        text: 'The reference (for example WYD-7KQ2-M9XD) is the one to quote when you contact support. You can also contact support straight from the booking’s page, which links the ticket to it.',
      },
    ],
    actions: [{ label: 'Go to My trips', path: '/trips' }],
    related: ['booking-statuses', 'contacting-support'],
    keywords: ['reference', 'my trips', 'find', 'lost', 'booking number', 'WYD'],
    supportCategory: 'booking',
    reviewed: R,
  },

  {
    slug: 'prices-and-results',
    category: 'booking',
    title: 'Are the prices, results and destinations real?',
    summary:
      'Search results are Wayora’s sample data: illustrative prices, no availability checks, no ratings.',
    body: [
      {
        type: 'list',
        items: [
          'Search results come from Wayora’s own sample fixtures, not from travel providers. Prices and times are illustrative, not live fares.',
          'Availability isn’t checked.',
          'Discover uses a small, curated set of sample destinations with editorial descriptions.',
          'Wayora shows no ratings or reviews anywhere.',
        ],
      },
    ],
    related: ['what-is-a-demo-booking', 'currency-selector'],
    keywords: ['price', 'fare', 'real', 'live', 'rating', 'review', 'availability', 'sample'],
    supportCategory: 'booking',
    reviewed: R,
  },
  // ── Payments ──────────────────────────────────────────────────────────
  {
    slug: 'how-demo-payments-work',
    category: 'payments',
    title: 'How payments work',
    summary:
      'Payments go through Wayora’s simulator: no card details are asked for and no money moves.',
    body: [
      {
        type: 'p',
        text: 'Wayora has no real payment gateway yet. When you pay for a booking, Wayora’s payment simulator decides the outcome, and nothing reaches a bank or card network.',
      },
      {
        type: 'list',
        items: [
          'Wayora never asks for card or bank details.',
          'On demo servers you can choose the simulated outcome (approve, decline, or pending first) to see how each is handled.',
          'A successful demo payment confirms the booking. A declined one leaves it pending, and you can try again while the payment window is open.',
        ],
      },
      {
        type: 'demo',
        text: 'No real money is ever charged, so there is nothing to dispute with a bank.',
      },
    ],
    related: ['payment-window', 'what-you-pay', 'payment-failed'],
    keywords: ['pay', 'card', 'bank', 'charge', 'charged', 'simulator', 'gateway', 'upi'],
    supportCategory: 'payment',
    reviewed: R,
  },
  {
    slug: 'payment-window',
    category: 'payments',
    title: 'The payment window',
    summary: 'A booking waiting for payment must be paid by the time shown, or it expires.',
    body: [
      {
        type: 'p',
        text: 'A booking that needs payment starts as pending, with a time to pay by on its payment page (30 minutes by default). If no payment has succeeded by then, it expires.',
      },
      {
        type: 'list',
        items: [
          'An expired booking can’t be paid. Make a new booking instead.',
          'Coupons and rewards applied to an expired booking are given back.',
          'If a payment succeeds after the booking closed, the booking stays closed and the payment is marked as owed back (for a demo payment, no money was taken).',
        ],
      },
    ],
    related: ['how-demo-payments-work', 'booking-statuses', 'refund-states'],
    keywords: ['expire', 'expired', 'time limit', 'deadline', 'pay by', 'timeout'],
    supportCategory: 'payment',
    reviewed: R,
  },
  {
    slug: 'what-you-pay',
    category: 'payments',
    title: 'How the amount to pay is worked out',
    summary:
      'Original price, then offers, then points, then travel credit. Wayora calculates it, never your browser.',
    body: [
      { type: 'p', text: 'The payment page shows the breakdown in this order:' },
      {
        type: 'steps',
        items: [
          'Original price: the booked price, which never changes.',
          'Offers and coupons, if the booking qualifies.',
          'Loyalty points you chose to use, measured on the price after offers.',
          'Travel credit you chose to use, also measured after offers.',
          'To pay: what’s left. At least ₹1 is always left to pay.',
        ],
      },
      {
        type: 'p',
        text: 'If the amount changes before you pay (for example, a coupon stops being valid), Wayora explains what changed and asks you to confirm the new amount.',
      },
    ],
    actions: [{ label: 'Current offers', path: '/promotions' }],
    related: ['using-a-coupon', 'using-points', 'how-demo-payments-work'],
    keywords: ['total', 'breakdown', 'price', 'amount', 'discount', 'changed'],
    supportCategory: 'payment',
    reviewed: R,
  },
  {
    slug: 'payment-failed',
    category: 'payments',
    title: 'My payment failed or is still processing',
    summary: 'What declined and pending payments mean, and when you can try again.',
    body: [
      {
        type: 'list',
        items: [
          'Declined: nothing was paid. You can start another payment while the booking is pending and its window is open.',
          'Pending: the result isn’t known yet. Wayora waits for it and updates the page by itself. You can’t start a second payment while one is in progress.',
          'If a pending payment succeeds after the window closed, the booking stays expired and the payment is marked as owed back.',
        ],
      },
    ],
    related: ['payment-window', 'refund-states'],
    keywords: ['failed', 'declined', 'pending', 'processing', 'stuck', 'retry', 'error'],
    supportCategory: 'payment',
    reviewed: R,
  },

  // ── Cancellations ─────────────────────────────────────────────────────
  {
    slug: 'cancelling-a-booking',
    category: 'cancellations',
    title: 'Cancelling a booking',
    summary: 'Pending and confirmed bookings can be cancelled from My trips until the travel date.',
    body: [
      {
        type: 'steps',
        items: ['Open the booking in My trips.', 'Choose Cancel demo booking and confirm.'],
      },
      {
        type: 'list',
        items: [
          'You can cancel a pending or confirmed booking up to and including its travel start date (by the calendar in India). Metro bookings have no date and can always be cancelled.',
          'Cancelled, expired and failed bookings can’t be cancelled again.',
          'If a payment is still in progress, Wayora cancels that payment first.',
          'Cancelling changes the booking’s status. Coupons are released, and points or credit used on it come back to your account.',
        ],
      },
      {
        type: 'demo',
        text: 'For a demo booking no supplier is contacted, because nothing was reserved, and no real money was taken.',
      },
      {
        type: 'provider',
        text: 'When real booking opens, each airline, hotel or operator will have its own cancellation terms and fees. Wayora will show the provider’s terms on the offer before you book. Hotel offers that already carry the provider’s cancellation terms show them on the booking.',
      },
    ],
    actions: [{ label: 'Go to My trips', path: '/trips' }],
    related: ['refund-states', 'booking-statuses', 'contacting-support'],
    keywords: ['cancel', 'cancellation', 'fee', 'change', 'call off'],
    supportCategory: 'cancellation',
    reviewed: R,
  },
  {
    slug: 'cant-cancel',
    category: 'cancellations',
    title: 'Why can’t I cancel my booking?',
    summary: 'A booking can’t be cancelled after its travel date has started, or once it’s closed.',
    body: [
      {
        type: 'list',
        items: [
          'The travel start date has passed (judged by the calendar in India).',
          'The booking is already cancelled, expired or failed.',
        ],
      },
      {
        type: 'p',
        text: 'If none of these apply and cancelling still doesn’t work, contact support from the booking’s page so the ticket is linked to it.',
      },
    ],
    related: ['cancelling-a-booking', 'contacting-support'],
    keywords: ['cannot cancel', 'can’t cancel', 'cancel button', 'missing', 'not cancellable'],
    supportCategory: 'cancellation',
    reviewed: R,
  },

  // ── Refunds ───────────────────────────────────────────────────────────
  {
    slug: 'refund-states',
    category: 'refunds',
    title: 'Refund states explained',
    summary:
      'What “not applicable”, “required”, “pending”, “succeeded” and other refund states mean.',
    body: [
      {
        type: 'p',
        text: 'A refund is owed when a paid booking is cancelled, or when a payment succeeds after its booking closed. Its state is shown on the booking:',
      },
      {
        type: 'list',
        items: [
          'Not applicable: nothing was paid on Wayora.',
          'Required: owed, but the payment’s provider can’t refund through Wayora. For demo payments this is always the case: no money was taken, so there is nothing to return.',
          'Requested or pending: asked of the payment provider, or being processed by it.',
          'Succeeded: the payment provider confirmed the refund. This is the only state that means a refund completed.',
          'Failed: the provider refused it. It stays owed, and Wayora staff follow it up.',
          'Unknown: asked, with no definite answer yet. Wayora checks with the provider before asking again.',
        ],
      },
      {
        type: 'p',
        text: 'Refunds are never paid as travel credit, and travel credit is never paid out as cash.',
      },
      {
        type: 'demo',
        text: 'Every payment today is a demo payment, so every refund today is “required”, with no money involved.',
      },
    ],
    related: ['cancelling-a-booking', 'travel-credit', 'contacting-support'],
    keywords: ['refund', 'money back', 'refunded', 'when', 'status', 'owed'],
    supportCategory: 'refund',
    reviewed: R,
  },

  // ── Travel documents ──────────────────────────────────────────────────
  {
    slug: 'tickets-and-vouchers',
    category: 'documents',
    title: 'Tickets, vouchers and e-tickets',
    summary: 'Demo bookings have no tickets or vouchers; Wayora never generates one itself.',
    body: [
      {
        type: 'p',
        text: 'A ticket or voucher can only come from the supplier that reserved your journey. Wayora shows only references a supplier actually issued, and never makes one up.',
      },
      {
        type: 'demo',
        text: 'Demo bookings have no supplier reservation, so they have no ticket, voucher or PNR. The booking page says so.',
      },
    ],
    related: ['travel-id-and-visas', 'what-is-a-demo-booking'],
    keywords: ['ticket', 'e-ticket', 'voucher', 'pnr', 'boarding pass', 'confirmation number'],
    supportCategory: 'booking',
    reviewed: R,
  },
  {
    slug: 'travel-id-and-visas',
    category: 'documents',
    title: 'ID, passports and visas',
    summary:
      'Wayora never asks for passport or ID numbers. Document rules are set by carriers and governments.',
    body: [
      {
        type: 'p',
        text: 'Wayora asks only for the names of the people travelling, as they appear on their ID (and, for cabs, a mobile number). It never asks for passport, Aadhaar or other ID numbers, and never stores them.',
      },
      {
        type: 'provider',
        text: 'Which ID you need to travel, and any visa or health requirements, are set by the airline, rail or bus operator, hotel and the governments involved. Check with them before you travel. Wayora doesn’t publish these rules.',
      },
    ],
    related: ['tickets-and-vouchers', 'saved-travellers'],
    keywords: ['passport', 'visa', 'id', 'aadhaar', 'identity', 'documents', 'requirements'],
    supportCategory: 'general',
    reviewed: R,
  },

  // ── Loyalty and rewards ───────────────────────────────────────────────
  {
    slug: 'earning-points',
    category: 'rewards',
    title: 'Earning loyalty points',
    summary: 'Demo points are earned on what you actually paid, a day after the trip ends.',
    body: [
      {
        type: 'list',
        items: [
          '1 base point per ₹10 actually paid (after offers, points and credit). Other currencies don’t earn.',
          'Points become available 1 day after the trip ends, and expire 24 months after they’re added.',
          'Your tier multiplies what you earn: Explorer ×1, Silver ×1.25 (2,000 qualifying points), Gold ×1.5 (6,000) and Platinum ×2 (15,000), counted over a rolling 12 months.',
          'Cancelled, expired and unpaid bookings don’t earn. Points earned on a booking that is later cancelled are taken back.',
        ],
      },
      {
        type: 'demo',
        text: 'All points today are demo points with no cash value, earned only from demo bookings.',
      },
    ],
    actions: [{ label: 'Your rewards', path: '/rewards' }],
    related: ['using-points', 'travel-credit'],
    keywords: ['points', 'earn', 'loyalty', 'tier', 'silver', 'gold', 'platinum', 'expire'],
    supportCategory: 'rewards',
    reviewed: R,
  },
  {
    slug: 'using-points',
    category: 'rewards',
    title: 'Using points at payment',
    summary: 'Use 200 to 20,000 points, worth ₹0.25 each, for up to half a booking’s price.',
    body: [
      {
        type: 'list',
        items: [
          'Each point is worth ₹0.25.',
          'Use between 200 and 20,000 points on one booking, covering at most 50% of the price after offers.',
          'Points can be used on flights, hotels, trains, buses and holiday packages.',
          'You confirm before anything is used. If the booking is cancelled or expires, the points come back with their original expiry date.',
        ],
      },
    ],
    actions: [{ label: 'Your rewards', path: '/rewards' }],
    related: ['earning-points', 'what-you-pay', 'travel-credit'],
    keywords: ['redeem', 'use points', 'burn', 'value', 'worth'],
    supportCategory: 'rewards',
    reviewed: R,
  },
  {
    slug: 'travel-credit',
    category: 'rewards',
    title: 'Travel credit',
    summary:
      'Credit issued by Wayora support that pays towards bookings in its currency. It isn’t cash.',
    body: [
      {
        type: 'list',
        items: [
          'Travel credit is issued by Wayora staff (for example as a goodwill gesture) and shown in Rewards with a reference like WYC-….',
          'It pays towards bookings in the same currency, alongside or instead of points.',
          'It can’t be withdrawn as cash, and refunds are never paid as credit.',
        ],
      },
      {
        type: 'demo',
        text: 'Today all travel credit is demo credit with no cash value.',
      },
    ],
    actions: [{ label: 'Your rewards', path: '/rewards' }],
    related: ['using-points', 'refund-states'],
    keywords: ['credit', 'wallet', 'voucher', 'WYC', 'balance', 'goodwill'],
    supportCategory: 'rewards',
    reviewed: R,
  },

  // ── Coupons and promotions ────────────────────────────────────────────
  {
    slug: 'using-a-coupon',
    category: 'promotions',
    title: 'Using a coupon code',
    summary:
      'Enter a code on the payment page. Wayora checks it and shows the exact discount before you pay.',
    body: [
      {
        type: 'steps',
        items: [
          'Open the booking’s payment page.',
          'Enter the code under “Offers and coupons” and choose Apply.',
          'Check the price breakdown, then pay.',
        ],
      },
      {
        type: 'list',
        items: [
          'One coupon per booking. Applying another replaces it.',
          'Each code has its own conditions: categories, a minimum amount, dates and usage limits. The offers page lists them.',
          'A code is held for your booking until its payment window ends, and only counts as used once the booking is paid.',
          'Changing the coupon gives back any points or credit you applied, so you can apply them to the new price.',
        ],
      },
    ],
    actions: [{ label: 'Current offers', path: '/promotions' }],
    related: ['coupon-not-working', 'automatic-offers', 'what-you-pay'],
    keywords: ['coupon', 'code', 'promo', 'discount', 'voucher code', 'apply'],
    supportCategory: 'promotions',
    reviewed: R,
  },
  {
    slug: 'coupon-not-working',
    category: 'promotions',
    title: 'Why my coupon didn’t work',
    summary:
      'What each coupon message means: expired, not started, category, minimum amount or limits.',
    body: [
      {
        type: 'list',
        items: [
          '“We don’t recognise that code”: check the spelling. Codes aren’t case-sensitive, and spaces are ignored.',
          '“Expired” or “isn’t valid yet”: the code only works between its start and end dates.',
          '“Can’t be used on this kind of booking”: it’s limited to other categories.',
          '“Doesn’t reach the minimum amount”: the booking’s price is below the code’s minimum.',
          '“Reached its usage limit” or “used as many times as it allows”: the code has no uses left, overall or for you.',
          '“Can’t be combined”: an automatic offer already gives a bigger discount.',
        ],
      },
      {
        type: 'p',
        text: 'Wayora can’t apply a code that its conditions don’t allow, including through support.',
      },
    ],
    actions: [{ label: 'Current offers', path: '/promotions' }],
    related: ['using-a-coupon', 'automatic-offers'],
    keywords: ['coupon error', 'invalid', 'expired', 'not working', 'rejected', 'limit'],
    supportCategory: 'promotions',
    reviewed: R,
  },
  {
    slug: 'automatic-offers',
    category: 'promotions',
    title: 'Automatic offers',
    summary: 'Some offers apply by themselves at payment when your booking qualifies.',
    body: [
      {
        type: 'list',
        items: [
          'When a booking qualifies for an automatic offer, the best one is applied at payment and named in the price breakdown.',
          'A coupon replaces it only if the coupon takes more off, unless the coupon says it combines with automatic offers.',
          'Offers never change the original price. They are taken off at payment.',
        ],
      },
    ],
    actions: [{ label: 'Current offers', path: '/promotions' }],
    related: ['using-a-coupon', 'what-you-pay'],
    keywords: ['automatic', 'offer', 'deal', 'sale', 'no code'],
    supportCategory: 'promotions',
    reviewed: R,
  },

  // ── Account management ────────────────────────────────────────────────
  {
    slug: 'signing-in',
    category: 'account',
    title: 'Signing in and staying signed in',
    summary:
      'Sessions last up to 30 days, or 7 days without use. You can sign out everywhere from your profile.',
    body: [
      {
        type: 'list',
        items: [
          'Browsing Discover and searching work without an account. You need one to book, save travellers, use rewards and contact support.',
          'You stay signed in for up to 30 days, or until 7 days pass without using Wayora.',
          'Sign out from the account menu, or from your profile, where you can also sign out on all devices at once.',
          'Wayora keeps you signed in with one cookie that page scripts can’t read. It’s removed when you sign out.',
        ],
      },
    ],
    actions: [{ label: 'Your profile', path: '/profile' }],
    related: ['forgotten-password', 'account-details'],
    keywords: ['login', 'log in', 'sign in', 'session', 'logged out', 'cookie', 'devices'],
    supportCategory: 'account',
    reviewed: R,
  },
  {
    slug: 'forgotten-password',
    category: 'account',
    title: 'I forgot my password',
    summary: 'Password reset isn’t available yet, because Wayora doesn’t send email yet.',
    body: [
      {
        type: 'p',
        text: 'Resetting a password safely needs a confirmation by email, and Wayora doesn’t send email yet. Password reset will be added with email.',
      },
      {
        type: 'p',
        text: 'If you’re still signed in somewhere, your account keeps working there. Support can’t see or change your password.',
      },
    ],
    related: ['signing-in', 'contacting-support'],
    keywords: ['password', 'reset', 'forgot', 'locked out', 'can’t log in'],
    supportCategory: 'account',
    reviewed: R,
  },
  {
    slug: 'account-details',
    category: 'account',
    title: 'Changing your details',
    summary:
      'Your name and saved travellers can be changed any time. Email changes and account deletion aren’t available yet.',
    body: [
      {
        type: 'list',
        items: [
          'Change your name in your profile.',
          'Changing your email address isn’t available in the app yet.',
          'Deleting your account isn’t available in the app yet.',
        ],
      },
    ],
    actions: [{ label: 'Your profile', path: '/profile' }],
    related: ['saved-travellers', 'signing-in'],
    keywords: ['name', 'email', 'delete account', 'close account', 'update', 'profile'],
    supportCategory: 'account',
    reviewed: R,
  },
  {
    slug: 'saved-travellers',
    category: 'account',
    title: 'Saved travellers',
    summary: 'Save the people you travel with to fill booking forms faster.',
    body: [
      {
        type: 'list',
        items: [
          'A saved traveller holds a name and, optionally, a date of birth and nationality. Never ID numbers.',
          'Editing or removing a saved traveller never changes a booking you already made: bookings keep the names they were made with.',
        ],
      },
    ],
    actions: [{ label: 'Saved travellers', path: '/profile/travellers' }],
    related: ['account-details', 'travel-id-and-visas'],
    keywords: ['traveller', 'passenger', 'family', 'companion', 'save'],
    supportCategory: 'account',
    reviewed: R,
  },

  {
    slug: 'cookies',
    category: 'account',
    title: 'Does Wayora use cookies?',
    summary: 'Only one, when you’re signed in: the session cookie that keeps you signed in.',
    body: [
      {
        type: 'list',
        items: [
          'The session cookie can’t be read by page scripts, and is removed when you sign out.',
          'Besides that, the browser keeps scroll positions for the current tab, so Back returns you to the same place.',
          'Wayora loads no analytics or advertising scripts.',
        ],
      },
    ],
    actions: [{ label: 'Draft privacy page', path: '/legal/privacy' }],
    related: ['signing-in'],
    keywords: ['cookie', 'tracking', 'privacy', 'analytics', 'ads'],
    supportCategory: 'account',
    reviewed: R,
  },
  // ── Technical support ─────────────────────────────────────────────────
  {
    slug: 'something-isnt-working',
    category: 'technical',
    title: 'Something isn’t working',
    summary: 'Check platform status, reload, then contact support with what you saw.',
    body: [
      {
        type: 'steps',
        items: [
          'Check Platform status: it shows whether Wayora’s API and the services it depends on are reachable right now.',
          'Reload the page. If you were signed out, sign in again.',
          'If an error page shows a reference, include it when you contact support. It helps staff find what happened.',
        ],
      },
    ],
    actions: [{ label: 'Platform status', path: '/status' }],
    related: ['contacting-support'],
    keywords: ['error', 'bug', 'broken', 'not loading', 'crash', 'slow', 'down'],
    supportCategory: 'technical',
    reviewed: R,
  },
  {
    slug: 'currency-selector',
    category: 'technical',
    title: 'What the currency selector does',
    summary:
      'It sets the currency you’d like prices shown in, for this visit. Nothing is converted or charged.',
    body: [
      {
        type: 'list',
        items: [
          'The choice applies to this visit only and isn’t saved: it resets when you reload the page.',
          'Demo prices are in rupees and aren’t converted.',
        ],
      },
    ],
    related: ['prices-and-results'],
    keywords: ['currency', 'inr', 'usd', 'convert', 'rupees', 'dollars'],
    supportCategory: 'technical',
    reviewed: R,
  },
  {
    slug: 'contacting-support',
    category: 'technical',
    title: 'Contacting support',
    summary:
      'Open a support ticket when you’re signed in. Replies appear in the ticket and in your notifications.',
    body: [
      {
        type: 'steps',
        items: [
          'Sign in, then open Support from the account menu, or choose Get help on a booking’s page.',
          'Choose a topic, and describe what happened. Linking a booking lets support see its status without you copying it.',
          'Follow the conversation in the ticket. You’re notified in Wayora when support replies.',
        ],
      },
      {
        type: 'list',
        items: [
          'Support replies in the ticket and in your Wayora notifications. Wayora doesn’t send email yet.',
          'Wayora aims to reply first within 8 hours for normal tickets (4 hours for high priority, 24 hours for low). These are targets, not guarantees.',
          'Opening a ticket never changes your booking. Support doesn’t cancel bookings, issue refunds or apply discounts on request in a ticket: those follow Wayora’s rules described in these articles.',
          'Never share passwords or card details in a ticket. Support will never ask for them.',
        ],
      },
    ],
    actions: [
      { label: 'Contact support', path: '/support/new' },
      { label: 'Your tickets', path: '/support' },
    ],
    related: ['something-isnt-working', 'finding-your-booking'],
    keywords: ['contact', 'support', 'help', 'ticket', 'agent', 'human', 'complaint', 'chat'],
    supportCategory: 'general',
    reviewed: R,
  },
];

// ─── Lookup and search ───────────────────────────────────────────────────

export const helpCategory = (slug: string) => HELP_CATEGORIES.find((c) => c.slug === slug) ?? null;
export const helpArticle = (slug: string) => HELP_ARTICLES.find((a) => a.slug === slug) ?? null;
export const helpArticlesIn = (category: string) =>
  HELP_ARTICLES.filter((a) => a.category === category);

const fold = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '');
const words = (s: string) =>
  fold(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
const STOP = new Set([
  'the',
  'a',
  'an',
  'is',
  'my',
  'to',
  'of',
  'and',
  'or',
  'in',
  'on',
  'for',
  'it',
  'i',
  'do',
  'how',
  'what',
  'why',
  'can',
  'me',
  'with',
  'was',
  'not',
  'be',
  'at',
  'this',
]);

/**
 * Deterministic keyword search (no AI, no network): weights title, keyword,
 * summary and body matches, prefix matches count. Same query, same order.
 */
export function searchHelp(query: string, limit = 8): HelpArticle[] {
  const terms = [...new Set(words(query).filter((w) => !STOP.has(w)))].slice(0, 12);
  if (terms.length === 0) return [];
  const scored = HELP_ARTICLES.map((a, index) => {
    const title = words(a.title);
    const keys = a.keywords.flatMap(words);
    const summary = words(a.summary);
    const body = a.body.flatMap((b) => ('text' in b ? words(b.text) : b.items.flatMap(words)));
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      const hit = (list: string[]) =>
        list.some((w) => w === t || (t.length >= 4 && w.startsWith(t)));
      const s =
        (hit(title) ? 6 : 0) + (hit(keys) ? 5 : 0) + (hit(summary) ? 3 : 0) + (hit(body) ? 1 : 0);
      if (s > 0) matched += 1;
      score += s;
    }
    return { a, score: score + (matched === terms.length ? 4 : 0), index };
  }).filter((x) => x.score > 0);
  scored.sort((x, y) => y.score - x.score || x.index - y.index);
  return scored.slice(0, limit).map((x) => x.a);
}

/** Search suggestions for a support request (subject + description). */
export const suggestHelp = (subject: string, description = '', limit = 3) =>
  searchHelp(`${subject} ${description.slice(0, 500)}`, limit);
