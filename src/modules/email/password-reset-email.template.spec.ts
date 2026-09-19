import { buildPasswordResetEmail } from './password-reset-email.template';

describe('buildPasswordResetEmail', () => {
  const resetLink = 'https://app.kebdazaman.cloud/reset-password?token=abc123';

  it('renders English copy by default (locale "en" or unrecognized)', () => {
    const content = buildPasswordResetEmail({ name: 'Sara', resetLink, locale: 'en' });
    expect(content.subject).toContain('Reset your password');
    expect(content.html).toContain('dir="ltr"');
    expect(content.html).toContain('Hi Sara,');
    expect(content.text).toContain('Hi Sara,');
  });

  it('renders Arabic copy for an "ar"-prefixed locale', () => {
    const content = buildPasswordResetEmail({ name: 'سارة', resetLink, locale: 'ar' });
    expect(content.subject).toContain('إعادة تعيين كلمة المرور');
    expect(content.html).toContain('dir="rtl"');
    expect(content.html).toContain('مرحباً سارة،');
  });

  it('falls back to English for an unknown locale', () => {
    const content = buildPasswordResetEmail({ name: 'Sara', resetLink, locale: 'fr' });
    expect(content.subject).toContain('Reset your password');
  });

  it('embeds the exact reset link in both the button href and the plain-text fallback', () => {
    const content = buildPasswordResetEmail({ name: 'Sara', resetLink, locale: 'en' });
    expect(content.html).toContain(`href="${resetLink}"`);
    expect(content.text).toContain(resetLink);
  });

  it('HTML-escapes the name to prevent injection into the email body', () => {
    const content = buildPasswordResetEmail({
      name: '<script>alert(1)</script>',
      resetLink,
      locale: 'en',
    });
    expect(content.html).not.toContain('<script>alert(1)</script>');
    expect(content.html).toContain('&lt;script&gt;');
  });

  it('states the 15-minute, single-use expiry in both locales', () => {
    expect(buildPasswordResetEmail({ name: 'A', resetLink, locale: 'en' }).text).toContain(
      '15 minutes',
    );
    expect(buildPasswordResetEmail({ name: 'A', resetLink, locale: 'ar' }).text).toContain(
      '15 دقيقة',
    );
  });
});
