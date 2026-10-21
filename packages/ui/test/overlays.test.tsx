import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  MobileNav,
  NavItem,
  NavList,
  ToastProvider,
  useToast,
} from '../src';

describe('Dialog', () => {
  it('opens as a named modal and closes with Escape, returning focus', async () => {
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Change dates</Button>
        </DialogTrigger>
        <DialogContent title="Change travel dates" description="Prices may change.">
          Body
        </DialogContent>
      </Dialog>,
    );
    const trigger = screen.getByRole('button', { name: 'Change dates' });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Change travel dates' });
    expect(dialog).toHaveAccessibleDescription('Prices may change.');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('closes from the labelled close button', async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent title="Fare rules">Body</DialogContent>
      </Dialog>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('DropdownMenu', () => {
  it('opens from the keyboard and exposes menu items', async () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Sort</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Cheapest first</DropdownMenuItem>
          <DropdownMenuItem disabled>Fastest first</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'Sort' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Cheapest first' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Fastest first' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});

describe('Toast', () => {
  function Trigger() {
    const { toast } = useToast();
    return <Button onClick={() => toast({ title: 'Trip saved', tone: 'success' })}>Save</Button>;
  }

  it('announces a toast and can be dismissed', async () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Trip saved')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    });
    expect(screen.queryByText('Trip saved')).not.toBeInTheDocument();
  });

  it('throws a clear error outside the provider', () => {
    const Broken = () => {
      useToast();
      return null;
    };
    expect(() => render(<Broken />)).toThrow(/ToastProvider/);
  });
});

describe('navigation primitives', () => {
  it('marks the active NavItem as the current page', () => {
    render(
      <NavList label="Primary">
        <NavItem href="/" active>
          Home
        </NavItem>
        <NavItem href="/help">Help</NavItem>
      </NavList>,
    );
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Help' })).not.toHaveAttribute('aria-current');
  });

  it('MobileNav opens a named sheet from the menu button', async () => {
    render(
      <MobileNav title={<span>Wayora</span>} label="Main menu">
        <NavList label="Mobile" orientation="vertical">
          <NavItem href="#services">Services</NavItem>
        </NavList>
      </MobileNav>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(await screen.findByRole('dialog', { name: 'Main menu' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Services' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
