/**
 * Shell utilities — lightweight wrappers for common shell operations.
 */

import { execFileSync } from 'node:child_process';

/**
 * Check whether a command exists on the system PATH.
 *
 * @param {string} cmd - Command name to check
 * @returns {boolean}
 */
export function commandExists(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
