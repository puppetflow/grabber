import browser from 'webextension-polyfill';

const STANDALONE_ONBOARDED_KEY = 'puppetflow_grabber_standalone_onboarded';
const POPUP_PATH = 'src/popup/index.html';

const resetOnboarding = document.querySelector<HTMLButtonElement>('#reset-onboarding')!;

resetOnboarding.addEventListener('click', async () => {
  resetOnboarding.disabled = true;
  await browser.storage.local.remove(STANDALONE_ONBOARDED_KEY);
  await browser.action.setPopup({ popup: POPUP_PATH });
  resetOnboarding.textContent = 'Onboarding restored';
});
