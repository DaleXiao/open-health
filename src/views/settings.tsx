import type { FC } from 'hono/jsx';
import { Layout, ErrorBox, NoticeBox } from './layout.tsx';

interface SettingsProps {
  username: string;
  role: 'user' | 'admin';
  birthday: string | null;
  gender: 'M' | 'F' | 'other' | null;
  height_cm: number | null;
  error?: string | null;
  success?: string | null;
  // which section had an error / success (to scroll to it)
  section?: 'profile' | 'password' | null;
}

export const SettingsView: FC<SettingsProps> = (p) => (
  <Layout title="Settings" active="settings" username={p.username} role={p.role}>
    <section class="section">
      <span class="section-num">00 · settings</span>
      <h1 class="section-title">Your account.</h1>
    </section>

    {/* ── 01 · profile ── */}
    <section class="section" id="profile">
      <span class="section-num">01 · profile</span>
      <h2 class="section-title" style="font-size:1.75rem">Profile.</h2>

      {p.section === 'profile' && p.error && <ErrorBox message={p.error} />}
      {p.section === 'profile' && p.success && <NoticeBox message={p.success} />}

      {p.role === 'admin' ? (
        <p style="color:var(--ink-soft)">Admin accounts don't have profile fields (birthday, gender, height). Use the password section below to update your password.</p>
      ) : (
        <form method="post" action="/settings/profile" class="form-stack">
          <div class="form-row">
            <label>Username</label>
            <input value={p.username} disabled style="color:var(--ink-soft);background:var(--accent-soft)" />
          </div>
          <div class="form-row row-pair">
            <div class="form-row">
              <label for="birthday">Birthday</label>
              <input id="birthday" name="birthday" type="date" value={p.birthday ?? ''} required />
            </div>
            <div class="form-row">
              <label for="gender">Gender</label>
              <select id="gender" name="gender" required>
                <option value="">—</option>
                <option value="F" selected={p.gender === 'F'}>Female</option>
                <option value="M" selected={p.gender === 'M'}>Male</option>
                <option value="other" selected={p.gender === 'other'}>Other</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <label for="height_cm">Height (cm)</label>
            <input id="height_cm" name="height_cm" type="number" step="0.1" min="100" max="230"
              value={p.height_cm != null ? String(p.height_cm) : ''} required inputmode="decimal" />
          </div>
          <button type="submit" class="btn-primary">Save profile</button>
        </form>
      )}
    </section>

    <hr class="hairline" />

    {/* ── 02 · password ── */}
    <section class="section" id="password">
      <span class="section-num">02 · password</span>
      <h2 class="section-title" style="font-size:1.75rem">Password.</h2>

      {p.section === 'password' && p.error && <ErrorBox message={p.error} />}
      {p.section === 'password' && p.success && <NoticeBox message={p.success} />}

      <form method="post" action="/settings/password" class="form-stack">
        <div class="form-row">
          <label for="current_password">Current password</label>
          <input id="current_password" name="current_password" type="password" required
            autocomplete="current-password" />
        </div>
        <div class="form-row">
          <label for="new_password">New password</label>
          <input id="new_password" name="new_password" type="password" required minlength={8}
            autocomplete="new-password" />
        </div>
        <div class="form-row">
          <label for="confirm_password">Confirm new password</label>
          <input id="confirm_password" name="confirm_password" type="password" required minlength={8}
            autocomplete="new-password" />
        </div>
        <button type="submit" class="btn-primary">Update password</button>
      </form>
    </section>

    <hr class="hairline" />

    {/* ── 03 · session ── */}
    <section class="section" id="session">
      <span class="section-num">03 · session</span>
      <h2 class="section-title" style="font-size:1.75rem">Session.</h2>
      <p style="color:var(--ink-soft);margin:0 0 1.5rem">Signed in as <strong>{p.username}</strong>.</p>
      <form method="post" action="/logout">
        <button type="submit" class="btn-secondary">Sign out</button>
      </form>
    </section>
  </Layout>
);
