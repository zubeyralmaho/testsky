import type { InfoListItem, PlaygroundResult } from '../types';

// tracking popup tip
export const trackingTip = 'Limit popup to current tab';

// deep locate tip
export const deepLocateTip = 'Deep Locate';

// deep think tip (for aiAct planning)
export const deepThinkTip = 'Deep Think';

// screenshot included tip
export const screenshotIncludedTip = 'Include screenshot in request';

// dom included tip
export const domIncludedTip = 'Include DOM info in request';

// Android device options tips
export const imeStrategyTip = 'IME strategy';
export const screenshotStrategyTip = 'Screenshot strategy';
export const autoDismissKeyboardTip = 'Auto dismiss keyboard';
export const keyboardDismissStrategyTip = 'Keyboard dismiss strategy';
export const alwaysRefreshScreenInfoTip = 'Always refresh screen info';

export const apiMetadata = {
  aiAct: {
    group: 'interaction',
    title: 'Auto Planning: plan the steps and execute',
  },
  aiTap: { group: 'interaction', title: 'Click an element' },
  aiDoubleClick: { group: 'interaction', title: 'Double-click an element' },
  aiHover: { group: 'interaction', title: 'Hover over an element' },
  aiInput: { group: 'interaction', title: 'Input text into an element' },
  aiRightClick: { group: 'interaction', title: 'Right-click an element' },
  aiKeyboardPress: { group: 'interaction', title: 'Press keyboard keys' },
  aiScroll: { group: 'interaction', title: 'Scroll the page or element' },
  aiLocate: { group: 'interaction', title: 'Locate an element on the page' },
  aiQuery: {
    group: 'extraction',
    title: 'Extract data directly from the UI',
  },
  aiBoolean: { group: 'extraction', title: 'Get true/false answer' },
  aiNumber: { group: 'extraction', title: 'Extract numeric value' },
  aiString: { group: 'extraction', title: 'Extract text value' },
  aiAsk: { group: 'extraction', title: 'Ask a question about the UI' },
  aiAssert: { group: 'validation', title: 'Assert a condition is true' },
  aiWaitFor: { group: 'validation', title: 'Wait for a condition to be met' },
};

export const defaultMainButtons = ['aiAct', 'aiTap', 'aiQuery', 'aiAssert'];

// welcome message template
export const getWelcomeMessageTemplate = (
  targetName = 'web page',
): Omit<InfoListItem, 'id' | 'timestamp'> => ({
  type: 'system',
  content: `
      Welcome to the testsky Playground!

      Tell the ${targetName} what to do in plain words -- tap a button, fill in a form, read a value, check that something is there -- and watch testsky do it, with the same planner, memory and checks a test run uses.

      Type an instruction below to start.
    `,
  loading: false,
  result: undefined,
  replayScriptsInfo: null,
  replayCounter: 0,
  loadingProgressText: '',
  verticalMode: false,
});

// keep backward compatibility
export const WELCOME_MESSAGE_TEMPLATE: Omit<InfoListItem, 'id' | 'timestamp'> =
  getWelcomeMessageTemplate();

// blank result template
export const BLANK_RESULT: PlaygroundResult = {
  result: undefined,
  dump: null,
  reportHTML: null,
  report: null,
  error: null,
};
