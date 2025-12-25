/**
 * Test setup and fixtures.
 *
 * Provides utilities for creating temporary git repositories
 * and cleaning them up after tests.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Create a temporary directory for testing.
 */
export function createTempDir(prefix = 'dataplane-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Remove a directory recursively.
 */
export function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Initialize a git repository in a directory.
 */
export function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: 'pipe' });

  // Create initial commit
  const readmePath = path.join(dir, 'README.md');
  fs.writeFileSync(readmePath, '# Test Repository\n');
  execSync('git add .', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "Initial commit"', { cwd: dir, stdio: 'pipe' });
}

/**
 * Create a test file and commit it.
 */
export function commitFile(
  dir: string,
  filename: string,
  content: string,
  message: string
): string {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content);
  execSync('git add .', { cwd: dir, stdio: 'pipe' });
  execSync(`git commit -m "${message}"`, { cwd: dir, stdio: 'pipe' });
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
}

/**
 * Get the current HEAD commit.
 */
export function getHead(dir: string): string {
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
}

/**
 * Test fixture that creates a temporary git repo and cleans it up.
 */
export interface TestRepo {
  path: string;
  cleanup: () => void;
}

export function createTestRepo(): TestRepo {
  const dir = createTempDir();
  initGitRepo(dir);

  // Create .dataplane directory for database
  fs.mkdirSync(path.join(dir, '.dataplane'), { recursive: true });

  return {
    path: dir,
    cleanup: () => removeTempDir(dir),
  };
}
