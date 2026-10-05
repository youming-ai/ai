import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import ThemeSwitcher from './ThemeSwitcher';

describe('ThemeSwitcher', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to dark and applies it to the document', () => {
    render(<ThemeSwitcher />);
    expect(screen.getByRole('button', { name: 'Dark theme' })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('toggles to light on click, persisting and applying it', () => {
    render(<ThemeSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Dark theme' }));
    expect(screen.getByRole('button', { name: 'Light theme' })).toBeInTheDocument();
    expect(localStorage.getItem('theme')).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('restores a persisted theme on mount', () => {
    localStorage.setItem('theme', 'light');
    render(<ThemeSwitcher />);
    expect(screen.getByRole('button', { name: 'Light theme' })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('keeps a second instance in step, because the rail renders it twice', async () => {
    // The desktop column and the mobile disclosure each render one. Without a
    // shared source of truth the hidden one keeps a stale icon and label, and
    // resizing across the breakpoint would show the wrong theme.
    render(
      <>
        <ThemeSwitcher />
        <ThemeSwitcher />
      </>,
    );
    const [first] = screen.getAllByRole('button', { name: 'Dark theme' });
    fireEvent.click(first!);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Light theme' })).toHaveLength(2);
    });
  });
});
