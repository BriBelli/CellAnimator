'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useCurrentUser } from '../lib/use-current-user';
import { useLoginModal } from './LoginModalProvider';
import { clearCredentialsSession } from '../lib/credentials-auth';
import { useSettings } from '../store/settings-store';
import { BudgetMeter } from './BudgetMeter';

/* ─────────────────────────────────────────────────────────────────────────────
 * AccountAvatar — the identity anchor at the BOTTOM of the glass rail.
 *
 * A glass circle (same .pxc-glass as the rail). Standard avatar fallback order:
 *     signed in + photo  → the photo
 *     signed in, no photo→ their INITIALS (1–2 letters, brand-gradient chip)
 *     signed out         → a neutral person glyph  →  opens the login modal
 *
 * Clicking (when signed in) opens the account popover (theme · Settings · Sign out) as a glass
 * bubble that opens UP + to the RIGHT out of the rail and overlays the canvas.
 * ───────────────────────────────────────────────────────────────────────────── */

type IconName = 'user' | 'settings' | 'sun' | 'moon' | 'logout';

const PATHS: Record<IconName, string[]> = {
  user: ['M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2', 'M12 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
  settings: [
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  ],
  sun: ['M12 2v2', 'M12 20v2', 'm4.93 4.93 1.41 1.41', 'm17.66 17.66 1.41 1.41', 'M2 12h2', 'M20 12h2', 'm6.34 17.66-1.41 1.41', 'm19.07 4.93-1.41 1.41', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
};

function Ic({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name].map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

/** Initials from a display name ("Brian Bellino" → "BB"), else the email's first letter. */
function initialsOf(name: string, email: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return email.trim().charAt(0).toUpperCase();
}

const CSS = `
  .pxs-account { position: relative; }

  /* The avatar is a persistent glass surface like the rail — same .pxc-glass treatment (applied via
     className), round, 40px. The frosted fill + subtle border come from the shared helper; only the
     size/shape/content live here. (The initials chip inside carries the brand gradient — that's the
     one on-brand pop, since identity reads as an "action" element.) */
  .pxs-av {
    width: 40px; height: 40px; border-radius: var(--a2ui-radius-full);
    display: flex; align-items: center; justify-content: center; overflow: hidden;
    background: var(--a2ui-bg-tertiary); border: 1px solid var(--pxc-border-subtle);
    color: var(--a2ui-text-secondary); cursor: pointer; padding: 0;
    transition: box-shadow var(--a2ui-transition-fast), transform var(--a2ui-transition-fast);
  }
  .pxs-av:hover { transform: translateY(-1px); }
  .pxs-av:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--a2ui-accent-subtle); }
  .pxs-av img { width: 100%; height: 100%; object-fit: cover; display: block; border-radius: inherit; }
  /* Initials: the brand pair, so a signed-in user is instantly identifiable and on-brand. */
  .pxs-av-initials {
    width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, var(--pxs-brand-primary), var(--pxs-brand-secondary));
    color: #fff; font-size: 14px; font-weight: 600; letter-spacing: 0.02em;
  }

  /* Account popover — a glass bubble that OVERLAYS the canvas, opening UP + to the RIGHT out of the
     rail (the avatar sits bottom-left). Same .pxc-glass pattern; no drop shadow. */
  .pxs-acct-pop {
    position: absolute; bottom: 0; left: calc(100% + 12px); width: 260px;
    z-index: 70;
    background: var(--pxc-bg-glass-20);
    backdrop-filter: var(--pxc-glass-filter); -webkit-backdrop-filter: var(--pxc-glass-filter);
    border: 1px solid var(--pxc-border-subtle); border-radius: var(--a2ui-radius-xl);
    box-shadow: none; padding: var(--a2ui-space-2);
    display: flex; flex-direction: column; gap: 2px;
  }
  .pxs-acct-head { display: flex; align-items: center; gap: var(--a2ui-space-3); padding: var(--a2ui-space-2) var(--a2ui-space-2) var(--a2ui-space-3); }
  .pxs-acct-id { display: flex; flex-direction: column; min-width: 0; }
  .pxs-acct-name { font-size: var(--a2ui-text-md); color: var(--a2ui-text-primary); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pxs-acct-email { font-size: var(--a2ui-text-sm); color: var(--a2ui-text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pxs-acct-sep { height: 1px; background: var(--a2ui-border-subtle); margin: var(--a2ui-space-1) 0; }
  .pxs-acct-item {
    display: flex; align-items: center; gap: var(--a2ui-space-3); width: 100%; text-align: left;
    padding: var(--a2ui-space-2) var(--a2ui-space-3); border-radius: var(--a2ui-radius-md);
    background: transparent; color: var(--a2ui-text-primary); cursor: pointer;
    font-family: var(--a2ui-font-family); font-size: var(--a2ui-text-md);
    transition: background var(--a2ui-transition-fast);
  }
  .pxs-acct-item:hover { background: var(--a2ui-bg-hover); }
  .pxs-acct-item > svg { color: var(--a2ui-text-secondary); flex-shrink: 0; }
  .pxs-acct-danger, .pxs-acct-danger > svg { color: var(--a2ui-error); }
  .pxs-acct-danger:hover { background: var(--a2ui-error-bg); }
`;

export default function AccountAvatar({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { isAuthenticated, logout } = useAuth0();
  const { openLogin } = useLoginModal();
  // Merges BOTH sessions (Auth0 SDK + custom credentials).
  const user = useCurrentUser();
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // SIGNED OUT — the standard neutral person glyph; opens the login modal.
  if (!user) {
    return (
      <div className="pxs-account">
        <style>{CSS}</style>
        <button type="button" title="Sign in" aria-label="Sign in" onClick={openLogin} className="pxs-av">
          <Ic name="user" size={20} />
        </button>
      </div>
    );
  }

  const handleLogout = () => {
    setOpen(false);
    clearCredentialsSession();
    if (isAuthenticated) logout({ logoutParams: { returnTo: window.location.origin } });
  };

  const name = (user.name || user.firstName || '').trim();
  const email = (user.email || '').trim();
  const initials = initialsOf(name, email);

  return (
    <div className="pxs-account">
      <style>{CSS}</style>
      <div ref={ref} style={{ position: 'relative' }}>
        <button
          type="button"
          title={name || email || 'Account'}
          aria-label={name || email || 'Account'}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="pxs-av"
        >
          {/* photo → initials (never the generic glyph once signed in). */}
          {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span className="pxs-av-initials">{initials || <Ic name="user" size={20} />}</span>}
        </button>

        {open && (
          <div className="pxs-acct-pop" role="menu">
            <div className="pxs-acct-head">
              <span className="pxs-av" style={{ width: 40, height: 40, flexShrink: 0, cursor: 'default' }}>
                {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span className="pxs-av-initials">{initials}</span>}
              </span>
              <span className="pxs-acct-id">
                <span className="pxs-acct-name">{name || email || 'Account'}</span>
                {email && <span className="pxs-acct-email">{email}</span>}
              </span>
            </div>

            <div className="pxs-acct-sep" />

            {/* Spend lives with identity: it is the user's money, so it belongs where their account
                does — visible without hunting through settings. */}
            <BudgetMeter />

            <div className="pxs-acct-sep" />

            <button type="button" role="menuitem" className="pxs-acct-item" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
              <Ic name={theme === 'dark' ? 'sun' : 'moon'} />
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
            <button
              type="button"
              role="menuitem"
              className="pxs-acct-item"
              onClick={() => {
                setOpen(false);
                onOpenSettings?.();
              }}
            >
              <Ic name="settings" />
              Settings
            </button>

            <div className="pxs-acct-sep" />

            <button type="button" role="menuitem" className="pxs-acct-item pxs-acct-danger" onClick={handleLogout}>
              <Ic name="logout" />
              Sign out
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
