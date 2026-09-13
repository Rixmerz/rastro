// CAPTCHA / 2FA / bot-block detection, run after an action settles.

import type { Page } from 'playwright-core';

export async function detectBlocked(page: Page): Promise<string | undefined> {
  const hasCaptcha = await page
    .evaluate(() => {
      const re = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare/i;
      const iframes = Array.from(document.querySelectorAll('iframe'));
      if (iframes.some((f) => re.test(f.getAttribute('src') ?? '') || re.test(f.getAttribute('title') ?? ''))) {
        return true;
      }
      return document.querySelector('.g-recaptcha, .h-captcha, .cf-turnstile') !== null;
    })
    .catch(() => false);
  if (hasCaptcha) return 'captcha';

  const has2fa = await page
    .evaluate(() => {
      const re = /otp|2fa|totp|verification.?code/i;
      const inputs = Array.from(document.querySelectorAll('input'));
      return inputs.some((el) => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || el.hidden) return false;
        if (el.getAttribute('autocomplete') === 'one-time-code') return true;
        return re.test(el.name || '') || re.test(el.id || '');
      });
    })
    .catch(() => false);
  if (has2fa) return '2fa';

  const isBotBlock = await page
    .evaluate(() => {
      const re = /access denied|are you a robot|verify you are human|unusual traffic/i;
      const text = `${document.title} ${document.body?.innerText ?? ''}`;
      if (!re.test(text)) return false;
      const interactive = document.querySelectorAll(
        'a,button,input,select,textarea,[role="button"],[role="link"]',
      );
      return interactive.length <= 3;
    })
    .catch(() => false);
  if (isBotBlock) return 'bot-block';

  return undefined;
}
