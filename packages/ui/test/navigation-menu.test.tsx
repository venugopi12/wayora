import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../src';

function Menu() {
  return (
    <NavigationMenu label="Primary">
      <NavigationMenuItem>
        <NavigationMenuLink variant="top" active>
          <a href="/flights">Flights</a>
        </NavigationMenuLink>
      </NavigationMenuItem>
      <NavigationMenuItem>
        <NavigationMenuTrigger>More</NavigationMenuTrigger>
        <NavigationMenuContent>
          <NavigationMenuLink>
            <a href="/metro">Metro</a>
          </NavigationMenuLink>
        </NavigationMenuContent>
      </NavigationMenuItem>
    </NavigationMenu>
  );
}

describe('NavigationMenu', () => {
  it('exposes a named nav landmark and marks the active link as the current page', () => {
    render(<Menu />);
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Flights' })).toHaveAttribute('aria-current', 'page');
  });

  it('toggles a panel with explicit clicks and wires aria-expanded / aria-controls', () => {
    render(<Menu />);
    const trigger = screen.getByRole('button', { name: 'More' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(trigger.getAttribute('aria-controls')!)).toContainElement(
      screen.getByRole('link', { name: 'Metro' }),
    );

    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens from the keyboard and closes with Escape', async () => {
    render(<Menu />);
    const trigger = screen.getByRole('button', { name: 'More' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(screen.getByRole('link', { name: 'Metro' }), { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  });
});

describe('Popover', () => {
  it('opens from its trigger, is named, and closes with Escape', async () => {
    render(
      <Popover>
        <PopoverTrigger asChild>
          <Button>Filters</Button>
        </PopoverTrigger>
        <PopoverContent aria-label="Trip filters">Body</PopoverContent>
      </Popover>,
    );
    const trigger = screen.getByRole('button', { name: 'Filters' });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Trip filters' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(trigger).toHaveFocus();
  });
});

describe('DropdownMenuRadioGroup', () => {
  function CurrencyMenu() {
    const [value, setValue] = useState('INR');
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>{value}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup label="Display currency" value={value} onValueChange={setValue}>
            <DropdownMenuRadioItem value="INR">INR</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="USD">USD</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  it('exposes menuitemradio with aria-checked and reports changes', async () => {
    render(<CurrencyMenu />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'INR' }), { key: 'Enter' });
    expect(await screen.findByRole('group', { name: 'Display currency' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'INR' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'USD' }));
    expect(await screen.findByRole('button', { name: 'USD' })).toBeInTheDocument();
  });
});
