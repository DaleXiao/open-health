import type { FC } from 'hono/jsx';
import { Layout, ErrorBox, NoticeBox } from './layout.tsx';

export const LoginView: FC<{ error?: string; notice?: string }> = ({ error, notice }) => (
  <Layout title="Sign in">
    <section class="section">
      <span class="section-num">02 · entry</span>
      <h1 class="section-title">Sign in.</h1>
      <p class="section-sub">A private space for you and your family. No tracking, no sharing.</p>

      {error && <ErrorBox message={error} />}
      {notice && <NoticeBox message={notice} />}

      <form method="post" action="/login" class="form-stack">
        <div class="form-row">
          <label for="username">Username</label>
          <input id="username" name="username" required autocomplete="username" />
        </div>
        <div class="form-row">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" required autocomplete="current-password" />
        </div>
        <button type="submit" class="btn-primary">Continue</button>
      </form>

      <hr class="hairline" />
      <p>
        New here? <a href="/register">Create an account</a>.
      </p>
    </section>
  </Layout>
);

export const RegisterView: FC<{ error?: string; values?: Record<string, string | undefined> }> = ({ error, values = {} }) => (
  <Layout title="Register">
    <section class="section">
      <span class="section-num">02 · onboarding</span>
      <h1 class="section-title">Begin.</h1>
      <p class="section-sub">
        Fill this in once — height, weight and birthday set your personal baselines.
        After this the only thing you touch daily is the weight field.
      </p>

      {error && <ErrorBox message={error} />}

      <form method="post" action="/register" class="form-stack">
        <div class="form-row">
          <label for="username">Username</label>
          <input id="username" name="username" required minlength={2} maxlength={32} value={values.username} autocomplete="username" />
        </div>
        <div class="form-row">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" required minlength={6} autocomplete="new-password" />
        </div>

        <hr class="hairline" style="margin:0.5rem 0" />
        <p style="font-size:0.85rem;color:var(--ink-soft);margin:0 0 0.5rem">Your body profile — used to calculate BMI and ideal weight.</p>

        <div class="form-row row-pair">
          <div class="form-row">
            <label for="birthday">Birthday</label>
            <input id="birthday" name="birthday" type="date" value={values.birthday} required />
          </div>
          <div class="form-row">
            <label for="gender">Gender</label>
            <select id="gender" name="gender" required>
              <option value="">—</option>
              <option value="F" selected={values.gender === 'F'}>Female</option>
              <option value="M" selected={values.gender === 'M'}>Male</option>
              <option value="other" selected={values.gender === 'other'}>Other</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <label for="height_cm">Height (cm)</label>
          <input id="height_cm" name="height_cm" type="number" step="0.1" min="80" max="230" value={values.height_cm} required />
        </div>
        <div class="form-row">
          <label for="weight_kg">Current weight (kg) — first entry</label>
          <input id="weight_kg" name="weight_kg" type="number" step="0.1" min="20" max="300" value={values.weight_kg} required inputmode="decimal" autofocus />
        </div>

        <button type="submit" class="btn-primary">Create account</button>
      </form>

      <hr class="hairline" />
      <p>Already have an account? <a href="/login">Sign in</a>.</p>
    </section>
  </Layout>
);
