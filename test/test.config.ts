import * as assert from 'assert';
import * as path from 'path';
import { getConfig, Flags } from '../src/config';
const assertRejects = require('assert-rejects');

describe('config', () => {
  it('should allow passing no config', async () => {
    const cfg: Flags = {
      format: 'json',
      recurse: true,
      silent: true,
      skip: '🌳',
    };
    const config = await getConfig(cfg);
    assert.deepStrictEqual(config, cfg);
  });

  it('should throw with a reasonable message if the path doesnt exist', async () => {
    const cfg = {
      config: '/path/does/not/exist',
    };
    await assertRejects(getConfig(cfg), /ENOENT: no such file or directory/);
  });

  it('should allow reading from a config file', async () => {
    const configPath = path.resolve(
      'test/fixtures/config/linkinator.config.json'
    );
    const expected = require(configPath);
    const config = await getConfig({ config: configPath });
    delete config.config;
    assert.deepStrictEqual(config, expected);
  });

  it('should merge config settings from the CLI and object', async () => {
    const configPath = path.resolve(
      'test/fixtures/config/linkinator.config.json'
    );
    const expected = require(configPath);
    expected.skip = 'loo';
    const config = await getConfig({
      config: configPath,
      skip: 'loo',
    });
    delete config.config;
    assert.deepStrictEqual(config, expected);
  });
});
