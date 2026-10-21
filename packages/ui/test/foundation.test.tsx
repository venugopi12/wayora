import { fireEvent, render, screen } from '@testing-library/react';
import { Plane } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import {
  Avatar,
  Badge,
  BrandMark,
  Button,
  Checkbox,
  EmptyState,
  Field,
  IconButton,
  Input,
  Radio,
  RadioGroup,
  Select,
  Textarea,
  Wordmark,
  buttonVariants,
  interaction,
  type ButtonVariant,
} from '../src';

describe('Button', () => {
  it.each(Object.keys(buttonVariants) as ButtonVariant[])(
    'renders the %s variant as a type="button" with its own styles',
    (variant) => {
      render(<Button variant={variant}>Search</Button>);
      const button = screen.getByRole('button', { name: 'Search' });
      expect(button).toHaveAttribute('type', 'button');
      for (const cls of buttonVariants[variant].split(' ')) expect(button).toHaveClass(cls);
    },
  );

  it('offers the documented variants, each visually distinct', () => {
    expect(Object.keys(buttonVariants).sort()).toEqual(
      [
        'destructive',
        'ghost',
        'ghost-inverse',
        'inverse',
        'outline',
        'outline-inverse',
        'primary',
        'secondary',
      ].sort(),
    );
    const styles = Object.values(buttonVariants);
    expect(new Set(styles).size).toBe(styles.length);
  });

  it('gives press feedback from the shared interaction preset', () => {
    render(<Button>Go</Button>);
    for (const cls of interaction.press.split(' '))
      expect(screen.getByRole('button', { name: 'Go' })).toHaveClass(cls);
  });

  it('keeps a disabled link-button out of the click path', () => {
    render(
      <Button asChild variant="outline">
        <a href="/x" aria-disabled="true">
          Later
        </a>
      </Button>,
    );
    expect(screen.getByRole('link', { name: 'Later' })).toHaveClass(
      'aria-disabled:pointer-events-none',
    );
  });

  it('does not fire clicks when disabled', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Book
      </Button>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Book' }));
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Book' })).toBeDisabled();
  });

  it('is busy and disabled while loading', () => {
    render(<Button loading>Saving</Button>);
    const button = screen.getByRole('button', { name: 'Saving' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('can render a link with button styles via asChild', () => {
    render(
      <Button asChild>
        <a href="/flights">Explore flights</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Explore flights' });
    expect(link).toHaveAttribute('href', '/flights');
    expect(link.className).toContain('bg-brand');
  });
});

describe('IconButton', () => {
  it('uses its label as the accessible name', () => {
    render(<IconButton label="Swap origin and destination" icon={<Plane />} />);
    expect(screen.getByRole('button', { name: 'Swap origin and destination' })).toBeInTheDocument();
  });
});

describe('form controls', () => {
  it('Field labels its Input and links hint and error text', () => {
    render(
      <Field label="Email" hint="We send your e-ticket here." error="Enter a valid email." required>
        <Input type="email" />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: /email/i });
    expect(input).toBeRequired();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter a valid email. We send your e-ticket here.');
  });

  it('Field works for Textarea and Select', () => {
    render(
      <>
        <Field label="Special requests">
          <Textarea />
        </Field>
        <Field label="Cabin class">
          <Select
            placeholder="Choose a class"
            options={[
              { value: 'economy', label: 'Economy' },
              { value: 'business', label: 'Business' },
            ]}
          />
        </Field>
      </>,
    );
    expect(screen.getByRole('textbox', { name: 'Special requests' })).toBeInTheDocument();
    const select = screen.getByRole('combobox', { name: 'Cabin class' });
    expect(select).toHaveValue('');
    fireEvent.change(select, { target: { value: 'business' } });
    expect(select).toHaveValue('business');
  });

  it('Input without a Field can be labelled with aria-label', () => {
    render(<Input aria-label="Destination" />);
    expect(screen.getByRole('textbox', { name: 'Destination' })).not.toHaveAttribute(
      'aria-invalid',
    );
  });

  it('Checkbox is labelled, described and toggles', () => {
    render(<Checkbox label="Flexible dates" description="Show fares ±3 days" />);
    const box = screen.getByRole('checkbox', { name: 'Flexible dates' });
    expect(box).toHaveAccessibleDescription('Show fares ±3 days');
    fireEvent.click(box);
    expect(box).toBeChecked();
  });

  it('RadioGroup exposes a named group with one selectable option', () => {
    render(
      <RadioGroup legend="Trip type">
        <Radio label="One way" value="oneway" defaultChecked />
        <Radio label="Round trip" value="round" />
      </RadioGroup>,
    );
    expect(screen.getByRole('group', { name: 'Trip type' })).toBeInTheDocument();
    const round = screen.getByRole('radio', { name: 'Round trip' });
    fireEvent.click(round);
    expect(round).toBeChecked();
    expect(screen.getByRole('radio', { name: 'One way' })).not.toBeChecked();
    expect(round).toHaveAttribute(
      'name',
      screen.getByRole('radio', { name: 'One way' }).getAttribute('name'),
    );
  });
});

describe('display components', () => {
  it('Badge renders its text', () => {
    render(<Badge tone="success">Confirmed</Badge>);
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
  });

  it('Avatar falls back to initials and keeps the full name accessible', async () => {
    render(<Avatar name="Asha Rao" />);
    expect(await screen.findByText('AR')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Asha Rao')).toBeInTheDocument();
  });

  it('BrandMark is decorative unless titled; Wordmark reads "wayora"', () => {
    const { container } = render(<BrandMark />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    render(<BrandMark title="Wayora" />);
    expect(screen.getByRole('img', { name: 'Wayora' })).toBeInTheDocument();
    render(<Wordmark />);
    expect(screen.getByText('wayora')).toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  it('titles with a paragraph by default, so it never adds headings to a page', () => {
    render(<EmptyState title="No trips yet" />);
    expect(screen.getByText('No trips yet').tagName).toBe('P');
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('can title the page when the state is the whole page', () => {
    render(<EmptyState size="page" titleAs="h1" title="This offer link isn't valid" />);
    expect(
      screen.getByRole('heading', { level: 1, name: "This offer link isn't valid" }),
    ).toBeInTheDocument();
  });
});
