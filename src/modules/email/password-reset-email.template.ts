const BRAND_NAME = 'Kebda Zaman';

export interface BuildPasswordResetEmailParams {
  name: string;
  resetLink: string;
  /** User.locale — any string is accepted; only an "ar"-prefixed value picks
   * the Arabic copy, everything else (including unset) falls back to English. */
  locale: string;
}

export interface PasswordResetEmailContent {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Copy {
  dir: 'ltr' | 'rtl';
  lang: 'en' | 'ar';
  subject: string;
  greeting: (name: string) => string;
  body1: string;
  cta: string;
  expiry: string;
  ignore: string;
  fallback: string;
}

/**
 * Bilingual copy, chosen by locale — same convention as the rest of this
 * codebase's ar/en content (e.g. MenuItem.nameArSnapshot/nameEnSnapshot):
 * two fixed strings picked at build time, not a runtime translation engine.
 */
function copyFor(locale: string): Copy {
  if (locale?.toLowerCase().startsWith('ar')) {
    return {
      dir: 'rtl',
      lang: 'ar',
      subject: `إعادة تعيين كلمة المرور - ${BRAND_NAME}`,
      greeting: (name) => `مرحباً ${name}،`,
      body1: 'تلقينا طلباً لإعادة تعيين كلمة المرور الخاصة بحسابك في تطبيق كبدة زمان.',
      cta: 'إعادة تعيين كلمة المرور',
      expiry: 'ستنتهي صلاحية هذا الرابط خلال 15 دقيقة ولا يمكن استخدامه أكثر من مرة.',
      ignore:
        'إذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة بأمان — لن يتم تغيير كلمة المرور الخاصة بك.',
      fallback: 'إذا لم يعمل الزر أعلاه، انسخ الرابط التالي والصقه في متصفحك:',
    };
  }
  return {
    dir: 'ltr',
    lang: 'en',
    subject: `Reset your password - ${BRAND_NAME}`,
    greeting: (name) => `Hi ${name},`,
    body1: `We received a request to reset your ${BRAND_NAME} account password.`,
    cta: 'Reset your password',
    expiry: 'This link expires in 15 minutes and can only be used once.',
    ignore:
      "If you didn't request this, you can safely ignore this email — your password will not be changed.",
    fallback: "If the button above doesn't work, copy and paste this link into your browser:",
  };
}

export function buildPasswordResetEmail(
  params: BuildPasswordResetEmailParams,
): PasswordResetEmailContent {
  const copy = copyFor(params.locale);
  const safeName = escapeHtml(params.name);
  const safeLink = escapeHtml(params.resetLink);

  const html = `<!doctype html>
<html dir="${copy.dir}" lang="${copy.lang}">
  <body style="margin:0;padding:24px;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;">
      <tr>
        <td style="background:#b1361f;padding:20px;text-align:center;">
          <span style="color:#ffffff;font-size:20px;font-weight:bold;">${BRAND_NAME}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:24px;color:#222222;font-size:15px;line-height:1.5;">
          <p>${copy.greeting(safeName)}</p>
          <p>${copy.body1}</p>
          <p style="text-align:center;margin:32px 0;">
            <a href="${safeLink}" style="background:#b1361f;color:#ffffff;padding:12px 28px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:bold;">${copy.cta}</a>
          </p>
          <p style="color:#666666;font-size:13px;">${copy.expiry}</p>
          <p style="color:#666666;font-size:13px;">${copy.ignore}</p>
          <p style="color:#999999;font-size:12px;word-break:break-all;margin-top:24px;">${copy.fallback}<br/>${safeLink}</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    copy.greeting(params.name),
    '',
    copy.body1,
    '',
    `${copy.cta}: ${params.resetLink}`,
    '',
    copy.expiry,
    copy.ignore,
  ].join('\n');

  return { subject: copy.subject, html, text };
}
