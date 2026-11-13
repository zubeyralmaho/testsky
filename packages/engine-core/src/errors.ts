/**
 * The failures that are somebody's to fix, not ours to retry.
 *
 * A phone that is locked, asleep behind a PIN, or not authorised for debugging
 * needs a person to do one thing. Printing a stack trace at them buries the
 * one sentence that matters, so these carry an instruction and the CLI prints
 * them bare.
 */
export class DeviceNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceNotReadyError";
  }
}
