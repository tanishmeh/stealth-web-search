/**
 * Errors whose message is meant for the agent. Tool handlers throw these and
 * the tool wrapper turns them into `isError: true` results with the message
 * as-is (prefixed with "Error: "), without logging a stack trace.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export class ElementNotFoundError extends ToolError {
  constructor(target: string) {
    super(`Element not found: ${target}`);
    this.name = 'ElementNotFoundError';
  }
}

export class StaleRefError extends ToolError {
  constructor(ref: string) {
    super(
      `Element ref '${ref}' is no longer valid (the page changed or navigated). Call browser_snapshot to get fresh refs.`,
    );
    this.name = 'StaleRefError';
  }
}

export class UnknownRefError extends ToolError {
  constructor(ref: string) {
    super(`Unknown element ref '${ref}'. Call browser_snapshot (or browser_interactive_elements) first and use a ref from its output.`);
    this.name = 'UnknownRefError';
  }
}

export class JavaScriptError extends ToolError {
  constructor(description: string) {
    super(`JavaScript error: ${description}`);
    this.name = 'JavaScriptError';
  }
}

export class NavigationError extends ToolError {
  constructor(url: string, reason: string) {
    super(`Navigation to ${url} failed: ${reason}`);
    this.name = 'NavigationError';
  }
}
