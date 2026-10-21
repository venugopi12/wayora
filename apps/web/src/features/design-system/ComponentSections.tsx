import { useState } from 'react';
import {
  ArrowRight,
  SlidersHorizontal,
  ArrowUpDown,
  Bell,
  Compass,
  Heart,
  LogOut,
  Pencil,
  Plus,
  Search,
  Settings,
  Share2,
  Trash2,
  User,
} from 'lucide-react';
import {
  Alert,
  Avatar,
  Badge,
  BrandLoader,
  Button,
  Card,
  cn,
  type ButtonSize,
  type ButtonVariant,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
  Divider,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  ErrorState,
  Field,
  Grid,
  IconButton,
  Input,
  MobileNav,
  NavItem,
  NavList,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Radio,
  RadioGroup,
  Select,
  Skeleton,
  Spinner,
  Stack,
  Surface,
  Textarea,
  Tooltip,
  Wordmark,
  MediaFrame,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@wayora/ui';
import { Code, ShowcaseSection, Specimen } from './showcase';

const BUTTON_VARIANTS: ButtonVariant[] = [
  'primary',
  'secondary',
  'outline',
  'ghost',
  'destructive',
  'inverse',
  'outline-inverse',
  'ghost-inverse',
];
const DEEP_VARIANTS = new Set<ButtonVariant>(['inverse', 'outline-inverse', 'ghost-inverse']);

/** Live controls for every Button prop that changes its appearance. */
function ButtonPlayground() {
  const [variant, setVariant] = useState<ButtonVariant>('primary');
  const [size, setSize] = useState<ButtonSize>('md');
  const [disabled, setDisabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [icon, setIcon] = useState(true);
  const deep = DEEP_VARIANTS.has(variant);
  const props = [
    variant !== 'primary' && `variant="${variant}"`,
    size !== 'md' && `size="${size}"`,
    disabled && 'disabled',
    loading && 'loading',
    icon && 'trailingIcon={<ArrowRight />}',
  ].filter(Boolean);
  return (
    <Specimen label="Playground" note="pick a variant, size and state">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Field label="Variant">
            <Select
              value={variant}
              onChange={(e) => setVariant(e.target.value as ButtonVariant)}
              options={BUTTON_VARIANTS.map((v) => ({ value: v, label: v }))}
            />
          </Field>
          <Field label="Size">
            <Select
              value={size}
              onChange={(e) => setSize(e.target.value as ButtonSize)}
              options={(['sm', 'md', 'lg'] as const).map((v) => ({ value: v, label: v }))}
            />
          </Field>
          <Checkbox
            label="Disabled"
            checked={disabled}
            onChange={(e) => setDisabled(e.target.checked)}
          />
          <Checkbox
            label="Loading"
            checked={loading}
            onChange={(e) => setLoading(e.target.checked)}
          />
          <Checkbox
            label="Trailing icon"
            checked={icon}
            onChange={(e) => setIcon(e.target.checked)}
          />
        </div>
        <div className="flex flex-col gap-4">
          <div
            className={cn(
              'grid min-h-40 place-items-center rounded-lg p-6',
              deep
                ? 'bg-deep focus-ring-inverse'
                : 'border border-dashed border-line-strong bg-page',
            )}
          >
            <Button
              variant={variant}
              size={size}
              disabled={disabled}
              loading={loading}
              trailingIcon={icon ? <ArrowRight /> : undefined}
            >
              Explore journeys
            </Button>
          </div>
          <pre className="overflow-x-auto rounded-md bg-sunken p-4 font-mono text-caption">
            {`<Button${props.length ? ' ' + props.join(' ') : ''}>Explore journeys</Button>`}
          </pre>
        </div>
      </div>
    </Specimen>
  );
}

export function ButtonSection() {
  return (
    <ShowcaseSection
      id="buttons"
      title="Buttons"
      description="One primary action per view. Size md and lg give 44px+ touch targets. Icon-only buttons require a label, which becomes their accessible name."
    >
      <ButtonPlayground />
      <Specimen label="Variants" note="primary, secondary, outline, ghost, destructive">
        <div className="flex flex-wrap items-center gap-3">
          <Button>Search trips</Button>
          <Button variant="secondary">Save for later</Button>
          <Button variant="outline">Compare</Button>
          <Button variant="ghost">View details</Button>
          <Button variant="destructive" leadingIcon={<Trash2 />}>
            Cancel booking
          </Button>
        </div>
      </Specimen>
      <Specimen
        label="Inverse, for deep surfaces"
        note="inverse, outline-inverse, ghost-inverse"
        tone="deep"
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="inverse" trailingIcon={<ArrowRight />}>
            Start planning
          </Button>
          <Button variant="outline-inverse">Discover destinations</Button>
          <Button variant="ghost-inverse">Sign in</Button>
          <Button variant="inverse" disabled>
            Unavailable
          </Button>
        </div>
      </Specimen>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <Specimen label="Sizes" note="sm 36px, md 44px, lg 52px">
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm">Small</Button>
            <Button>Medium</Button>
            <Button size="lg">Large</Button>
          </div>
        </Specimen>
        <Specimen label="States" note="disabled, loading (aria-busy)">
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled>Disabled</Button>
            <Button variant="secondary" disabled>
              Disabled
            </Button>
            <Button loading>Searching</Button>
          </div>
        </Specimen>
        <Specimen label="With icons and as links">
          <div className="flex flex-wrap items-center gap-3">
            <Button leadingIcon={<Search />}>Search</Button>
            <Button variant="secondary" leadingIcon={<Plus />}>
              Add traveller
            </Button>
            <Button asChild variant="ghost">
              <a href="#travel">
                Travel components <ArrowRight aria-hidden="true" />
              </a>
            </Button>
          </div>
        </Specimen>
        <Specimen label="IconButton" note="always labelled">
          <div className="flex flex-wrap items-center gap-2">
            <IconButton
              label="Swap origin and destination"
              icon={<ArrowUpDown />}
              variant="secondary"
            />
            <IconButton label="Save to wishlist" icon={<Heart />} />
            <IconButton label="Share" icon={<Share2 />} />
            <IconButton label="Notifications" icon={<Bell />} size="sm" />
            <IconButton label="Search" icon={<Search />} variant="primary" />
            <IconButton label="Loading" icon={<Search />} loading />
          </div>
        </Specimen>
      </div>
    </ShowcaseSection>
  );
}

export function FormSection() {
  return (
    <ShowcaseSection
      id="forms"
      title="Form controls"
      description={
        <>
          Wrap text-like controls in <Code>Field</Code>, which supplies the label, hint and error
          wiring (aria-describedby, aria-invalid). Checkbox, radio and select are native elements
          styled with tokens: accessible by default, mobile-native pickers, and compatible with
          React Hook Form&apos;s <Code>register()</Code>.
        </>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <Specimen label="Text inputs">
          <Stack gap={5}>
            <Field label="Full name" hint="As shown on your ID." required>
              <Input placeholder="Asha Rao" autoComplete="name" />
            </Field>
            <Field label="Email" error="Enter an email address like name@example.com.">
              <Input type="email" defaultValue="asha@" leading={<User />} />
            </Field>
            <Field label="Booking reference" hint="Not editable after confirmation.">
              <Input defaultValue="WY-7KQ2-M9XD" disabled />
            </Field>
          </Stack>
        </Specimen>
        <Specimen label="Select, textarea">
          <Stack gap={5}>
            <Field label="Cabin class">
              <Select
                placeholder="Choose a class"
                options={[
                  { value: 'economy', label: 'Economy' },
                  { value: 'premium', label: 'Premium economy' },
                  { value: 'business', label: 'Business' },
                ]}
              />
            </Field>
            <Field label="Special requests" hint="Optional. Shared with the property.">
              <Textarea placeholder="Late check-in, accessible room…" rows={3} />
            </Field>
          </Stack>
        </Specimen>
        <Specimen label="Checkbox">
          <Stack gap={1}>
            <Checkbox
              label="Flexible dates"
              description="Show fares up to 3 days either side"
              defaultChecked
            />
            <Checkbox label="Direct flights only" />
            <Checkbox label="Refundable fares" description="Not available on this route" disabled />
          </Stack>
        </Specimen>
        <Specimen label="Radio group">
          <RadioGroup legend="Trip type" hint="Multi-city opens with flights booking." inline>
            <Radio label="One way" value="oneway" defaultChecked />
            <Radio label="Round trip" value="round" />
            <Radio label="Multi-city" value="multi" disabled />
          </RadioGroup>
        </Specimen>
      </div>
    </ShowcaseSection>
  );
}

export function DisplaySection() {
  return (
    <ShowcaseSection id="display" title="Badges, avatars, dividers, tooltips">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <Specimen label="Tabs" note="Radix tabs; arrow keys move and select">
          <Tabs defaultValue="flights">
            <TabsList label="Example services" className="rounded-lg bg-sunken p-1">
              <TabsTrigger value="flights">Flights</TabsTrigger>
              <TabsTrigger value="hotels">Hotels</TabsTrigger>
              <TabsTrigger value="trains">Trains</TabsTrigger>
            </TabsList>
            <TabsContent value="flights" className="pt-4 text-body-sm text-ink-secondary">
              Panel for flights.
            </TabsContent>
            <TabsContent value="hotels" className="pt-4 text-body-sm text-ink-secondary">
              Panel for hotels.
            </TabsContent>
            <TabsContent value="trains" className="pt-4 text-body-sm text-ink-secondary">
              Panel for trains.
            </TabsContent>
          </Tabs>
        </Specimen>
        <Specimen label="MediaFrame" note="fixed aspect, focal point, lazy by default">
          <div className="grid grid-cols-3 gap-3">
            <MediaFrame
              aspect="3/4"
              src="/media/artwork/mood-beach-escapes.svg"
              alt="Illustration of a calm sea at sunset"
              className="rounded-lg"
            />
            <MediaFrame
              aspect="1/1"
              src="/media/artwork/destination-kerala.svg"
              alt="Illustration of a houseboat on backwaters"
              focalPoint="60% 60%"
              className="rounded-lg"
            />
            <MediaFrame
              aspect="4/3"
              src="/media/missing.svg"
              alt="Missing file example"
              fallbackColor="var(--color-brand-soft)"
              className="rounded-lg"
            />
          </div>
        </Specimen>
        <Specimen label="Badge tones">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Neutral</Badge>
            <Badge tone="brand">New route</Badge>
            <Badge tone="success" dot>
              Confirmed
            </Badge>
            <Badge tone="warning" dot>
              2 seats left
            </Badge>
            <Badge tone="danger" dot>
              Cancelled
            </Badge>
            <Badge size="sm">Small</Badge>
          </div>
        </Specimen>
        <Specimen label="Avatar" note="initials fallback; image when provided">
          <div className="flex items-center gap-3">
            <Avatar name="Asha Rao" size="sm" />
            <Avatar name="Vikram Iyer" />
            <Avatar name="Meera" size="lg" />
            <div className="flex -space-x-2">
              <Avatar name="Asha Rao" size="sm" />
              <Avatar name="Dev Patel" size="sm" />
              <Avatar name="Lin Zhou" size="sm" />
            </div>
          </div>
        </Specimen>
        <Specimen label="Divider">
          <Stack gap={4}>
            <p className="text-body-sm text-ink-secondary">Above</p>
            <Divider />
            <Divider label="or" />
            <div className="flex h-6 items-center gap-3 text-body-sm">
              Economy <Divider orientation="vertical" /> 1 adult
            </div>
          </Stack>
        </Specimen>
        <Specimen label="Tooltip" note="hover or focus the buttons">
          <div className="flex gap-3">
            <Tooltip content="Prices include taxes and fees">
              <Button variant="secondary" size="sm">
                Price details
              </Button>
            </Tooltip>
            <Tooltip content="Edit travellers" side="bottom">
              <IconButton label="Edit travellers" icon={<Pencil />} variant="secondary" size="sm" />
            </Tooltip>
          </div>
        </Specimen>
      </div>
    </ShowcaseSection>
  );
}

export function LayoutSection() {
  return (
    <ShowcaseSection
      id="layout"
      title="Layout and surfaces"
      description={
        <>
          <Code>Container</Code> centres content with the fluid gutter; <Code>Section</Code> adds
          vertical rhythm and tone; <Code>Stack</Code> and <Code>Grid</Code> handle spacing with
          tokens. <Code>Card</Code> is a bordered surface; only make it <Code>interactive</Code>{' '}
          when the whole card is a link.
        </>
      }
    >
      <Specimen label="Surface tones" tone="page">
        <Grid columns={{ base: 1, sm: 2, lg: 5 }} gap={3}>
          {(['page', 'card', 'sunken', 'brand', 'deep'] as const).map((tone) => (
            <Surface key={tone} tone={tone} bordered padding="sm" className="text-body-sm">
              <Code>{`tone="${tone}"`}</Code>
            </Surface>
          ))}
        </Grid>
      </Specimen>
      <Specimen label="Cards" tone="page" note="hover the interactive one">
        <Grid columns={{ base: 1, md: 3 }} gap={5}>
          <Card>
            <p className="text-title">Static card</p>
            <p className="mt-1 text-body-sm text-ink-secondary">
              Groups related content. No hover change.
            </p>
          </Card>
          <Card interactive>
            <p className="text-title">
              <a href="#layout" className="stretched-link rounded-xs outline-none">
                Interactive card
              </a>
            </p>
            <p className="mt-1 text-body-sm text-ink-secondary">
              The title link covers the card; hover lifts it.
            </p>
          </Card>
          <Card tone="deep" elevation="md">
            <p className="text-title">Deep card</p>
            <p className="mt-1 text-body-sm text-ink-inverse-secondary">
              For emphasis panels and promotions.
            </p>
          </Card>
        </Grid>
      </Specimen>
      <Specimen label="Responsive grid" note="resize the window">
        <Grid minItemWidth="11rem" gap={3}>
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={i}
              className="grid h-16 place-items-center rounded-md bg-brand-soft text-label text-brand-ink"
            >
              Item {i + 1}
            </div>
          ))}
        </Grid>
        <p className="mt-4 text-caption text-ink-secondary">
          Current breakpoint: <span className="sm:hidden">base (&lt;640px)</span>
          <span className="hidden sm:inline md:hidden">sm (≥640px)</span>
          <span className="hidden md:inline lg:hidden">md (≥768px)</span>
          <span className="hidden lg:inline xl:hidden">lg (≥1024px)</span>
          <span className="hidden xl:inline">xl (≥1280px)</span>
        </p>
      </Specimen>
      <Specimen
        label="Navigation primitives"
        note="NavList, NavItem, MobileNav (Phase 3 builds the navbar on these)"
      >
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-line bg-page px-4 py-2">
          <Wordmark size="sm" />
          <NavList label="Example navigation" className="hidden sm:block">
            <NavItem href="#layout" active>
              Overview
            </NavItem>
            <NavItem href="#layout">Trips</NavItem>
            <NavItem href="#layout">Help</NavItem>
          </NavList>
          <MobileNav title={<Wordmark size="sm" />} label="Example menu">
            <NavList label="Example menu" orientation="vertical">
              <NavItem href="#layout" size="lg" active>
                Overview
              </NavItem>
              <NavItem href="#layout" size="lg">
                Trips
              </NavItem>
            </NavList>
          </MobileNav>
        </div>
      </Specimen>
    </ShowcaseSection>
  );
}

function ToastButtons() {
  const { toast } = useToast();
  return (
    <div className="flex flex-wrap gap-3">
      <Button
        variant="secondary"
        onClick={() =>
          toast({ title: 'Trip saved', description: 'Find it under Trips.', tone: 'success' })
        }
      >
        Success toast
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          toast({
            title: 'Traveller removed',
            tone: 'info',
            action: {
              label: 'Undo',
              altText: 'Undo removing the traveller',
              onClick: () => undefined,
            },
          })
        }
      >
        With action
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          toast({
            title: 'Payment didn’t go through',
            description: 'Your card was not charged.',
            tone: 'danger',
          })
        }
      >
        Error toast
      </Button>
    </div>
  );
}

function RadioMenuExample() {
  const [sort, setSort] = useState('recommended');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" leadingIcon={<ArrowUpDown />}>
          Sort
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Sort example results</DropdownMenuLabel>
        <DropdownMenuRadioGroup label="Sort" value={sort} onValueChange={setSort}>
          <DropdownMenuRadioItem value="recommended">Recommended</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="price">Lowest price</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="duration">Shortest</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function OverlaySection() {
  return (
    <ShowcaseSection
      id="overlays"
      title="Dialogs, menus and notifications"
      description="Built on Radix primitives for focus trapping, Escape handling, focus return and correct ARIA. Animations use token durations and are removed under reduced motion."
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-3">
        <Specimen label="Dialog">
          <Dialog>
            <DialogTrigger asChild>
              <Button>Change dates</Button>
            </DialogTrigger>
            <DialogContent
              title="Change travel dates?"
              description="Fares are recalculated for the new dates."
              footer={
                <>
                  <DialogClose asChild>
                    <Button variant="secondary">Keep dates</Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button>Change dates</Button>
                  </DialogClose>
                </>
              }
            >
              Your seats are held for 15 minutes while you choose. Changing dates releases them.
            </DialogContent>
          </Dialog>
        </Specimen>
        <Specimen label="Dropdown menu">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" leadingIcon={<User />}>
                Account
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Signed in as asha@example.com</DropdownMenuLabel>
              <DropdownMenuItem icon={<Compass />}>Your trips</DropdownMenuItem>
              <DropdownMenuItem icon={<Settings />} shortcut="⌘,">
                Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem icon={<LogOut />} destructive>
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Specimen>
        <Specimen label="Toast">
          <ToastButtons />
        </Specimen>
        <Specimen label="Popover" note="non-modal; Escape and outside click close">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="secondary" leadingIcon={<SlidersHorizontal />}>
                Filters
              </Button>
            </PopoverTrigger>
            <PopoverContent aria-label="Example filters" align="start" className="p-5">
              <Stack gap={2}>
                <Checkbox label="Free cancellation" />
                <Checkbox label="Breakfast included" />
              </Stack>
            </PopoverContent>
          </Popover>
        </Specimen>
        <Specimen label="Menu with a single choice" note="menuitemradio">
          <RadioMenuExample />
        </Specimen>
        <Specimen label="NavigationMenu" note="see the site header: More opens the mega menu">
          <p className="text-body-sm text-ink-secondary">
            Click or hover <strong className="text-ink">More</strong> in the header above (lg and
            wider).
          </p>
        </Specimen>
      </div>
    </ShowcaseSection>
  );
}

export function FeedbackSection() {
  return (
    <ShowcaseSection
      id="feedback"
      title="Loading, empty and error states"
      description="Explain what happened and what to do next. Errors never apologise and are never vague."
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <Specimen label="Alert" className="flex flex-col gap-3">
          <Alert tone="info" title="Prices shown per person" role="none">
            Taxes and fees are added at checkout.
          </Alert>
          <Alert tone="success" title="Booking confirmed" role="none">
            Your e-ticket is on its way to asha@example.com.
          </Alert>
          <Alert tone="warning" title="Passport must be valid for 6 months" role="none">
            Check the expiry date before you travel.
          </Alert>
          <Alert
            tone="danger"
            title="Seat selection failed"
            role="none"
            action={
              <Button size="sm" variant="secondary">
                Choose again
              </Button>
            }
          >
            The seat was taken while you were choosing.
          </Alert>
        </Specimen>
        <Stack gap={6}>
          <Specimen
            label="Loading"
            note="Spinner in controls, Skeleton for content, BrandLoader for pages"
          >
            <div className="flex items-center gap-8">
              <Spinner className="text-brand" />
              <div className="flex flex-1 items-center gap-4">
                <Skeleton shape="circle" className="size-12" />
                <Skeleton shape="text" lines={2} />
              </div>
              <BrandLoader size={36} label="Loading example" />
            </div>
          </Specimen>
          <Specimen label="Empty state">
            <EmptyState
              icon={<Compass />}
              title="No trips yet"
              description="Trips you book or save appear here."
              action={<Button size="sm">Plan a trip</Button>}
            />
          </Specimen>
          <Specimen label="Error state">
            <ErrorState
              title="Fares didn't load"
              description="The connection dropped. Check your network and try again."
              reference="7f3c2a1e"
              action={
                <Button size="sm" variant="secondary">
                  Try again
                </Button>
              }
            />
          </Specimen>
        </Stack>
      </div>
    </ShowcaseSection>
  );
}
