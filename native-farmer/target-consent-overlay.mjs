const HEALTH_DATA_CONSENT_TITLE = 'Health Data Consent';
const CONTINUE_SHOPPING_LABEL = 'Continue shopping';

const visible = async (locator) => {
  try { return await locator.isVisible(); }
  catch { return false; }
};

// Target can place this consent sheet over an otherwise healthy PDP. The backdrop consumes pointer
// events, so every add-to-cart click times out even though the button is present underneath. Keep
// the match deliberately exact: a generic consent/cookie clicker is too risky on a checkout path.
export async function dismissTargetHealthDataConsent(page, {
  clickTimeoutMs = 4000,
  settleTimeoutMs = 3000,
} = {}) {
  const title = page.getByText(HEALTH_DATA_CONSENT_TITLE, { exact: true }).first();
  if (!(await visible(title))) return { found: false, dismissed: false };

  const continueButton = page.getByRole('button', {
    name: CONTINUE_SHOPPING_LABEL,
    exact: true,
  }).first();

  try {
    await continueButton.click({ timeout: clickTimeoutMs });
    await title.waitFor({ state: 'hidden', timeout: settleTimeoutMs }).catch(() => {});
    return { found: true, dismissed: !(await visible(title)) };
  } catch (error) {
    return {
      found: true,
      dismissed: false,
      error: String(error?.message || error).split('\n')[0],
    };
  }
}
