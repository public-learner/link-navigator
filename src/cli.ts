#!/usr/bin/env node

import * as meow from 'meow';
import * as updateNotifier from 'update-notifier';
import chalk = require('chalk');
import {LinkChecker, LinkState, LinkResult, CheckOptions} from './index';
import {promisify} from 'util';
import {Flags, getConfig} from './config';
import {Format, Logger, LogLevel} from './logger';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const toCSV = promisify(require('jsonexport'));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../package.json');
updateNotifier({pkg}).notify();

/* eslint-disable no-process-exit */

const cli = meow(
  `
    Usage
      $ linkinator LOCATION [ --arguments ]

    Positional arguments

      LOCATION
        Required. Either the URLs or the paths on disk to check for broken links.

    Flags

      --concurrency
        The number of connections to make simultaneously. Defaults to 100.

      --config
          Path to the config file to use. Looks for \`linkinator.config.json\` by default.

      --format, -f
          Return the data in CSV or JSON format.

      --help
          Show this command.

      --markdown
          Automatically parse and scan markdown if scanning from a location on disk.

      --recurse, -r
          Recursively follow links on the same root domain.

      --server-root
          When scanning a locally directory, customize the location on disk
          where the server is started.  Defaults to the path passed in [LOCATION].

      --skip, -s
          List of urls in regexy form to not include in the check.

      --timeout
          Request timeout in ms.  Defaults to 0 (no timeout).

      --verbosity
          Override the default verbosity for this command. Available options are
          'debug', 'info', 'warning', 'error', and 'none'.  Defaults to 'warning'.

    Examples
      $ linkinator docs/
      $ linkinator https://www.google.com
      $ linkinator . --recurse
      $ linkinator . --skip www.googleapis.com
      $ linkinator . --format CSV
`,
  {
    flags: {
      config: {type: 'string'},
      concurrency: {type: 'number'},
      recurse: {type: 'boolean', alias: 'r'},
      skip: {type: 'string', alias: 's'},
      format: {type: 'string', alias: 'f'},
      silent: {type: 'boolean'},
      timeout: {type: 'number'},
      markdown: {type: 'boolean'},
      serverRoot: {type: 'string'},
      verbosity: {type: 'string'},
    },
    booleanDefault: undefined,
  }
);

let flags: Flags;

async function main() {
  if (cli.input.length < 1) {
    cli.showHelp();
    return;
  }
  flags = await getConfig(cli.flags);

  const start = Date.now();
  const verbosity = parseVerbosity(cli.flags);
  const format = parseFormat(cli.flags);
  const logger = new Logger(verbosity, format);

  logger.error(`🏊‍♂️ crawling ${cli.input}`);

  const checker = new LinkChecker();
  checker.on('link', (link: LinkResult) => {
    let state = '';
    switch (link.state) {
      case LinkState.BROKEN:
        state = `[${chalk.red(link.status!.toString())}]`;
        logger.error(`${state} ${chalk.gray(link.url)}`);
        break;
      case LinkState.OK:
        state = `[${chalk.green(link.status!.toString())}]`;
        logger.warn(`${state} ${chalk.gray(link.url)}`);
        break;
      case LinkState.SKIPPED:
        state = `[${chalk.grey('SKP')}]`;
        logger.info(`${state} ${chalk.gray(link.url)}`);
        break;
    }
  });
  const opts: CheckOptions = {
    path: cli.input,
    recurse: flags.recurse,
    timeout: Number(flags.timeout),
    markdown: flags.markdown,
    concurrency: Number(flags.concurrency),
    serverRoot: flags.serverRoot,
  };
  if (flags.skip) {
    opts.linksToSkip = flags.skip.split(' ').filter(x => !!x);
  }
  const result = await checker.check(opts);
  if (format === Format.JSON) {
    console.log(JSON.stringify(result, null, 2));
    return;
  } else if (format === Format.CSV) {
    const csv = await toCSV(result.links);
    console.log(csv);
    return;
  } else {
    // Build a collection scanned links, collated by the parent link used in
    // the scan.  For example:
    // {
    //   "./README.md": [
    //     {
    //       url: "https://img.shields.io/npm/v/linkinator.svg",
    //       status: 200
    //       ....
    //     }
    //   ],
    // }
    const parents = result.links.reduce((acc, curr) => {
      const parent = curr.parent || '';
      if (!acc[parent]) {
        acc[parent] = [];
      }
      acc[parent].push(curr);
      return acc;
    }, {} as {[index: string]: LinkResult[]});

    Object.keys(parents).forEach(parent => {
      // prune links based on verbosity
      const links = parents[parent].filter(link => {
        if (verbosity === LogLevel.NONE) {
          return false;
        }
        if (link.state === LinkState.BROKEN) {
          return true;
        }
        if (link.state === LinkState.OK) {
          if (verbosity <= LogLevel.WARNING) {
            return true;
          }
        }
        if (link.state === LinkState.SKIPPED) {
          if (verbosity <= LogLevel.INFO) {
            return true;
          }
        }
        return false;
      });
      if (links.length === 0) {
        return;
      }
      logger.error(chalk.blue(parent));
      links.forEach(link => {
        let state = '';
        switch (link.state) {
          case LinkState.BROKEN:
            state = `[${chalk.red(link.status!.toString())}]`;
            logger.error(`  ${state} ${chalk.gray(link.url)}`);
            logger.debug(JSON.stringify(link.failureDetails, null, 2));
            break;
          case LinkState.OK:
            state = `[${chalk.green(link.status!.toString())}]`;
            logger.warn(`  ${state} ${chalk.gray(link.url)}`);
            break;
          case LinkState.SKIPPED:
            state = `[${chalk.grey('SKP')}]`;
            logger.info(`  ${state} ${chalk.gray(link.url)}`);
            break;
        }
      });
    });
  }

  const total = (Date.now() - start) / 1000;

  if (!result.passed) {
    const borked = result.links.filter(x => x.state === LinkState.BROKEN);
    logger.error(
      chalk.bold(
        `${chalk.red('ERROR')}: Detected ${
          borked.length
        } broken links. Scanned ${chalk.yellow(
          result.links.length.toString()
        )} links in ${chalk.cyan(total.toString())} seconds.`
      )
    );
    process.exit(1);
  }

  logger.error(
    chalk.bold(
      `🤖 Successfully scanned ${chalk.green(
        result.links.length.toString()
      )} links in ${chalk.cyan(total.toString())} seconds.`
    )
  );
}

function parseVerbosity(flags: typeof cli.flags): LogLevel {
  if (flags.silent && flags.verbosity) {
    throw new Error(
      'The SILENT and VERBOSITY flags cannot both be defined. Please consider using VERBOSITY only.'
    );
  }
  if (flags.silent) {
    return LogLevel.ERROR;
  }
  if (!flags.verbosity) {
    return LogLevel.WARNING;
  }
  const verbosity = flags.verbosity.toUpperCase();
  const options = Object.values(LogLevel);
  if (!options.includes(verbosity)) {
    throw new Error(
      `Invalid flag: VERBOSITY must be one of [${options.join(',')}]`
    );
  }
  return LogLevel[verbosity as keyof typeof LogLevel];
}

function parseFormat(flags: typeof cli.flags): Format {
  if (!flags.format) {
    return Format.TEXT;
  }
  flags.format = flags.format.toUpperCase();
  const options = Object.values(Format);
  if (!options.includes(flags.format)) {
    throw new Error("Invalid flag: FORMAT must be 'TEXT', 'JSON', or 'CSV'.");
  }
  return Format[flags.format as keyof typeof Format];
}

main();
