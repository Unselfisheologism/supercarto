/** Raised for any malformed or unsupported SCR input. */
export class ScrError extends Error {
  override readonly name = 'ScrError';
  /** 1-based line number, when known. */
  readonly line?: number;

  constructor(message: string, line?: number) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.line = line;
  }
}
