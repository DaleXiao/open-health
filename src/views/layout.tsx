import type { FC } from 'hono/jsx';

// Base editorial layout — Cormorant Garamond italic display + Instrument Sans body,
// warm paper background. Includes a light/dark theme toggle.

interface LayoutProps {
  title: string;
  active?: 'home' | 'log' | 'menu' | 'admin' | 'settings';
  username?: string | null;
  role?: 'user' | 'admin' | null;
  children: unknown;
}

// Inline script — runs synchronously in <head> before paint to prevent FOUC.
// Reads localStorage 'health-tracker-theme' (with one-shot migration from the
// legacy 'health-weweekly-theme' key) or prefers-color-scheme, applies .dark on <html>.
const THEME_INIT_SCRIPT = `(function(){try{var k='health-tracker-theme',ok='health-weweekly-theme',v=localStorage.getItem(k);if(v!=='dark'&&v!=='light'){var ov=localStorage.getItem(ok);if(ov==='dark'||ov==='light'){v=ov;try{localStorage.setItem(k,ov);localStorage.removeItem(ok);}catch(e){}}else{v=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}}if(v==='dark')document.documentElement.classList.add('dark');}catch(e){}})();`;

export const Layout: FC<LayoutProps> = ({ title, active, username, role, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, viewport-fit=cover" />
      <title>{title} · health.openclawd</title>
      <meta name="theme-color" content="#fafaf7" />
      <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
      <link
        href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;1,400;1,500&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"
        rel="stylesheet"
      />
      <link rel="icon" type="image/png" href="/favicon.png" />
      <link rel="stylesheet" href="/assets/app.css" />
    </head>
    <body>
      <header class="site-header">
        <div class="brand">
          <img src="/logo.png" alt="" width={24} height={24} class="brand-logo" />
          <a href="/" class="brand-name">health<span class="brand-italic">.openclawd</span></a>
        </div>
        <div class="header-actions">
          <ThemeToggleButton />
          {username && (
            <>
              {role === 'admin' && (
                <a href="/admin" class={`header-link${active === 'admin' ? ' is-active' : ''}`}>Users</a>
              )}
              <a href="/settings" class={`header-link nav-user${active === 'settings' ? ' is-active' : ''}`}>{username}</a>
              <form method="post" action="/logout" class="logout-form">
                <button type="submit" class="link-btn">Sign out</button>
              </form>
            </>
          )}
        </div>
      </header>
      <main class="container">{children}</main>
      <footer class="site-footer">
        <span class="footer-num">·</span>
        <span>health.openclawd · private family edition</span>
      </footer>
      <script src="/assets/theme-toggle.js" defer></script>
    </body>
  </html>
);

// Circular icon button. Both icons rendered SSR; CSS hides one based on .dark.
const ThemeToggleButton: FC = () => (
  <button
    id="theme-toggle"
    type="button"
    class="theme-toggle"
    aria-label="Switch to dark mode"
    title="Switch to dark mode"
  >
    {/* Moon icon — visible in light mode (click to go dark) */}
    <svg class="theme-icon theme-icon-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
    </svg>
    {/* Sun icon — visible in dark mode (click to go light) */}
    <svg class="theme-icon theme-icon-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 3v1.5M12 19.5V21M4.219 4.219l1.061 1.061M17.72 17.72l1.06 1.06M3 12h1.5M19.5 12H21M4.219 19.781l1.061-1.061M17.72 6.28l1.06-1.06" />
    </svg>
  </button>
);

export const ErrorBox: FC<{ message: string }> = ({ message }) => (
  <p class="error-box" role="alert">{message}</p>
);

export const NoticeBox: FC<{ message: string }> = ({ message }) => (
  <p class="notice-box">{message}</p>
);
