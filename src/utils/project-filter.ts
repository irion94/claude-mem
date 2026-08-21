/**
 * Project Filter Utility
 *
 * Provides glob-based path matching for project exclusion.
 * Supports: ~ (home), * (any chars except /), ** (any path), ? (single char)
 */

import { homedir } from 'os';
import path from 'path';
import { OBSERVER_SESSIONS_DIR } from '../shared/paths.js';

function resolvePath(inputPath: string): string {
  const trimmed = inputPath.trim();
  const expanded = trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')
    ? homedir() + trimmed.slice(1)
    : trimmed;
  return path.resolve(expanded);
}

/** Return true when cwd is the claude-mem data directory or one of its descendants. */
export function isSelfObserverCwd(cwd: string, dataDir: string): boolean {
  const resolvedCwd = resolvePath(cwd);
  const roots = [resolvePath(dataDir), resolvePath(OBSERVER_SESSIONS_DIR)];

  return roots.some(root => resolvedCwd === root || resolvedCwd.startsWith(root + path.sep));
}

/**
 * Convert a glob pattern to a regular expression
 * Supports: ~ (home dir), * (any non-slash), ** (any path), ? (single char)
 */
function globToRegex(pattern: string): RegExp {
  // Expand ~ to home directory
  let expanded = pattern.startsWith('~')
    ? homedir() + pattern.slice(1)
    : pattern;

  // Normalize path separators to forward slashes
  expanded = expanded.replace(/\\/g, '/');

  // Escape regex special characters except * and ?
  let regex = expanded.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  // Convert glob patterns to regex:
  // ** matches any path (including /)
  // * matches any characters except /
  // ? matches single character except /
  regex = regex
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')  // Temporary placeholder
    .replace(/\*/g, '[^/]*')              // * = any non-slash
    .replace(/\?/g, '[^/]')               // ? = single non-slash
    .replace(/<<<GLOBSTAR>>>/g, '.*');    // ** = anything

  return new RegExp(`^${regex}$`);
}

/**
 * Check if a path matches any of the exclusion patterns
 *
 * @param projectPath - Current working directory (absolute path)
 * @param exclusionPatterns - Comma-separated glob patterns (e.g., "~/kunden/*,/tmp/*")
 * @returns true if path should be excluded
 */
export function isProjectExcluded(projectPath: string, exclusionPatterns: string): boolean {
  if (!exclusionPatterns || !exclusionPatterns.trim()) {
    return false;
  }

  // Normalize cwd path separators
  const normalizedProjectPath = projectPath.replace(/\\/g, '/');

  // Parse comma-separated patterns
  const patternList = exclusionPatterns
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  for (const pattern of patternList) {
    try {
      const regex = globToRegex(pattern);
      if (regex.test(normalizedProjectPath)) {
        return true;
      }
    } catch (error: unknown) {
      // Invalid pattern, skip it
      console.warn(`[project-filter] Invalid exclusion pattern "${pattern}":`, error instanceof Error ? error.message : String(error));
      continue;
    }
  }

  return false;
}
