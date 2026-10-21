import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Breadcrumbs,
  Eyebrow,
  PageHeader,
  Prose,
} from '../src';

describe('Breadcrumbs', () => {
  it('is a named nav with an ordered list; ancestors link, the last item is current', () => {
    render(
      <Breadcrumbs
        items={[
          { label: 'Home', link: <a href="/" /> },
          { label: 'Legal' },
          { label: 'Privacy policy', link: <a href="/ignored" /> },
        ]}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('list').tagName).toBe('OL');
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
    // A level without a page is plain text, not a guessed link.
    expect(within(nav).queryByRole('link', { name: 'Legal' })).toBeNull();
    // The current page is never a link, even if one is passed.
    expect(within(nav).queryByRole('link', { name: 'Privacy policy' })).toBeNull();
    expect(within(nav).getByText('Privacy policy')).toHaveAttribute('aria-current', 'page');
    // Separators are hidden from assistive technology.
    for (const svg of nav.querySelectorAll('svg'))
      expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders nothing without items', () => {
    const { container } = render(<Breadcrumbs items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Accordion', () => {
  function Faq() {
    return (
      <Accordion type="multiple">
        <AccordionItem value="a">
          <AccordionTrigger headingLevel="h2">First</AccordionTrigger>
          <AccordionContent>First answer</AccordionContent>
        </AccordionItem>
        <AccordionItem value="b">
          <AccordionTrigger headingLevel="h2">Second</AccordionTrigger>
          <AccordionContent>Second answer</AccordionContent>
        </AccordionItem>
      </Accordion>
    );
  }

  it('wraps each trigger in a heading and wires aria-expanded / aria-controls', () => {
    render(<Faq />);
    const first = screen.getByRole('button', { name: 'First' });
    expect(screen.getByRole('heading', { level: 2, name: 'First' })).toContainElement(first);
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('First answer')).toBeNull();
    fireEvent.click(first);
    expect(first).toHaveAttribute('aria-expanded', 'true');
    const region = document.getElementById(first.getAttribute('aria-controls')!)!;
    expect(region).toHaveTextContent('First answer');
    expect(region).toHaveAttribute('role', 'region');
  });

  it('moves focus between headers with the arrow keys and Home/End', () => {
    render(<Faq />);
    const [first, second] = screen.getAllByRole('button');
    first!.focus();
    fireEvent.keyDown(first!, { key: 'ArrowDown' });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second!, { key: 'Home' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first!, { key: 'End' });
    expect(second).toHaveFocus();
  });
});

describe('Eyebrow and PageHeader', () => {
  it('draws a decorative hairline before the text', () => {
    render(<Eyebrow tone="inverse">Your next step</Eyebrow>);
    const p = screen.getByText('Your next step');
    expect(p.tagName).toBe('P');
    expect(p.querySelector('[aria-hidden="true"]')).toHaveClass('bg-brand-200');
  });

  it('PageHeader renders its eyebrow with the shared Eyebrow', () => {
    render(<PageHeader title="Places" eyebrow="The collection" headingLevel="h2" />);
    const eyebrow = screen.getByText('The collection');
    expect(eyebrow.querySelector('[aria-hidden="true"]')).toHaveClass('bg-brand');
    expect(screen.getByRole('heading', { level: 2, name: 'Places' })).toBeInTheDocument();
  });
});

describe('Prose', () => {
  it('keeps long-form text to a readable measure', () => {
    render(
      <Prose>
        <h2>Section</h2>
        <p>Body</p>
      </Prose>,
    );
    expect(screen.getByText('Body').parentElement).toHaveClass('max-w-prose');
  });
});
