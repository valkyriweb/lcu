import { before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureMetadata } from '../metadata.mjs';

export function metadataFixture(fixture) {
  const previous = process.env.HOME;
  let home;
  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'lcu-metadata-test-'));
    process.env.HOME = home;
    await captureMetadata([process.execPath, fixture]);
  });
  after(() => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
}
