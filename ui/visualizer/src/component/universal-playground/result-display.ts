import { dataExtractionAPIs, validationAPIs } from '@midscene/playground';

// testsky: a Locate answers in words too -- where testsky would press, and
// what the tree alone would say -- so its output shows beside the replay.
const outputAndReportAPIs = [...dataExtractionAPIs, ...validationAPIs, 'aiAct', 'aiLocate'];

export function shouldShowOutputAlongsideReport(actionType?: string): boolean {
  return actionType !== undefined && outputAndReportAPIs.includes(actionType);
}
