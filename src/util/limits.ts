/**
 * Limits shared by the agent manager, the script service and the Obscura connection budget
 * (src/obscura/process.ts): every browser they open holds one CDP connection.
 */

/** Sub-agent runs that may be paused on a question to the host at once; each keeps its private browser open. */
export const MAX_WAITING = 10;

/** Script runs at a time (script_run and the automation agent's script tests); the rest wait in order. */
export const SCRIPT_MAX_RUNS = 4;
