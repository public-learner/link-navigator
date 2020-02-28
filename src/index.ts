import { EventEmitter } from 'events';
import * as gaxios from 'gaxios';
import * as http from 'http';
import enableDestroy = require('server-destroy');
import PQueue, { DefaultAddOptions } from 'p-queue';

import { getLinks } from './links';
import { URL } from 'url';
import PriorityQueue from 'p-queue/dist/priority-queue';

const finalhandler = require('finalhandler');
const serveStatic = require('serve-static');

export interface CheckOptions {
  concurrency?: number;
  port?: number;
  path: string;
  recurse?: boolean;
  linksToSkip?: string[] | ((link: string) => Promise<boolean>);
}

export enum LinkState {
  OK = 'OK',
  BROKEN = 'BROKEN',
  SKIPPED = 'SKIPPED',
}

export interface LinkResult {
  url: string;
  status?: number;
  state: LinkState;
  parent?: string;
}

export interface CrawlResult {
  passed: boolean;
  links: LinkResult[];
}

interface CrawlOptions {
  url: URL;
  parent?: string;
  crawl: boolean;
  results: LinkResult[];
  cache: Set<string>;
  checkOptions: CheckOptions;
  queue: PQueue<PriorityQueue, DefaultAddOptions>;
}

/**
 * Instance class used to perform a crawl job.
 */
export class LinkChecker extends EventEmitter {
  /**
   * Crawl a given url or path, and return a list of visited links along with
   * status codes.
   * @param options Options to use while checking for 404s
   */
  async check(options: CheckOptions) {
    options.linksToSkip = options.linksToSkip || [];
    let server: http.Server | undefined;
    if (!options.path.startsWith('http')) {
      const port = options.port || 5000 + Math.round(Math.random() * 1000);
      server = await this.startWebServer(options.path, port);
      enableDestroy(server);
      options.path = `http://localhost:${port}`;
    }

    const queue = new PQueue({
      concurrency: options.concurrency || 100,
    });

    const results = new Array<LinkResult>();
    queue.add(async () => {
      await this.crawl({
        url: new URL(options.path),
        crawl: true,
        checkOptions: options,
        results,
        cache: new Set(),
        queue,
      });
    });
    await queue.onIdle();

    const result = {
      links: results,
      passed: results.filter(x => x.state === LinkState.BROKEN).length === 0,
    };
    if (server) {
      server.destroy();
    }
    return result;
  }

  /**
   * Spin up a local HTTP server to serve static requests from disk
   * @param root The local path that should be mounted as a static web server
   * @param port The port on which to start the local web server
   * @private
   * @returns Promise that resolves with the instance of the HTTP server
   */
  private startWebServer(root: string, port: number): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      const serve = serveStatic(root);
      const server = http
        .createServer((req, res) => serve(req, res, finalhandler(req, res)))
        .listen(port, () => resolve(server))
        .on('error', reject);
    });
  }

  /**
   * Crawl a given url with the provided options.
   * @pram opts List of options used to do the crawl
   * @private
   * @returns A list of crawl results consisting of urls and status codes
   */
  private async crawl(opts: CrawlOptions): Promise<void> {
    // Check to see if we've already scanned this url
    if (opts.cache.has(opts.url.href)) {
      return;
    }
    opts.cache.add(opts.url.href);

    // explicitly skip non-http[s] links before making the request
    const proto = opts.url.protocol;
    if (proto !== 'http:' && proto !== 'https:') {
      const r = {
        url: opts.url.href,
        status: 0,
        state: LinkState.SKIPPED,
        parent: opts.parent,
      };
      opts.results.push(r);
      this.emit('link', r);
      return;
    }

    // Check for a user-configured function to filter out links
    if (
      typeof opts.checkOptions.linksToSkip === 'function' &&
      (await opts.checkOptions.linksToSkip(opts.url.href))
    ) {
      const result: LinkResult = {
        url: opts.url.href,
        state: LinkState.SKIPPED,
        parent: opts.parent,
      };
      opts.results.push(result);
      this.emit('link', result);
      return;
    }

    // Check for a user-configured array of link regular expressions that should be skipped
    if (Array.isArray(opts.checkOptions.linksToSkip)) {
      const skips = opts.checkOptions.linksToSkip
        .map(linkToSkip => {
          return new RegExp(linkToSkip).test(opts.url.href);
        })
        .filter(match => !!match);

      if (skips.length > 0) {
        const result: LinkResult = {
          url: opts.url.href,
          state: LinkState.SKIPPED,
          parent: opts.parent,
        };
        opts.results.push(result);
        this.emit('link', result);
        return;
      }
    }

    // Perform a HEAD or GET request based on the need to crawl
    let status = 0;
    let state = LinkState.BROKEN;
    let data = '';
    let shouldRecurse = false;
    try {
      let res = await gaxios.request<string>({
        method: opts.crawl ? 'GET' : 'HEAD',
        url: opts.url.href,
        responseType: opts.crawl ? 'text' : 'stream',
        validateStatus: () => true,
      });

      // If we got an HTTP 405, the server may not like HEAD. GET instead!
      if (res.status === 405) {
        res = await gaxios.request<string>({
          method: 'GET',
          url: opts.url.href,
          responseType: 'stream',
          validateStatus: () => true,
        });
      }

      // Assume any 2xx status is 👌
      status = res.status;
      if (res.status >= 200 && res.status < 300) {
        state = LinkState.OK;
      }
      data = res.data;
      shouldRecurse = isHtml(res);
    } catch (err) {
      // request failure: invalid domain name, etc.
    }
    const result: LinkResult = {
      url: opts.url.href,
      status,
      state,
      parent: opts.parent,
    };
    opts.results.push(result);
    this.emit('link', result);

    // If we need to go deeper, scan the next level of depth for links and crawl
    if (opts.crawl && shouldRecurse) {
      this.emit('pagestart', opts.url);
      const urlResults = getLinks(data, opts.url.href);
      for (const result of urlResults) {
        // if there was some sort of problem parsing the link while
        // creating a new URL obj, treat it as a broken link.
        if (!result.url) {
          const r = {
            url: result.link,
            status: 0,
            state: LinkState.BROKEN,
            parent: opts.url.href,
          };
          opts.results.push(r);
          this.emit('link', r);
          continue;
        }

        let crawl = (opts.checkOptions.recurse! &&
          result.url &&
          result.url.href.startsWith(opts.checkOptions.path)) as boolean;

        // only crawl links that start with the same host
        if (crawl) {
          try {
            const pathUrl = new URL(opts.checkOptions.path);
            crawl = result.url!.host === pathUrl.host;
          } catch {}
        }

        // Ensure the url hasn't already been touched, largely to avoid a
        // very large queue length and runaway memory consumption
        if (!opts.cache.has(result.url.href)) {
          opts.queue.add(async () => {
            await this.crawl({
              url: result.url!,
              crawl,
              cache: opts.cache,
              results: opts.results,
              checkOptions: opts.checkOptions,
              queue: opts.queue,
              parent: opts.url.href,
            });
          });
        }
      }
    }
  }
}

/**
 * Convenience method to perform a scan.
 * @param options CheckOptions to be passed on
 */
export async function check(options: CheckOptions) {
  const checker = new LinkChecker();
  const results = await checker.check(options);
  return results;
}

/**
 * Checks to see if a given source is HTML.
 * @param {object} response Page response.
 * @returns {boolean}
 */
function isHtml(response: gaxios.GaxiosResponse): boolean {
  const contentType = response.headers['content-type'] || '';
  return (
    !!contentType.match(/text\/html/g) ||
    !!contentType.match(/application\/xhtml\+xml/g)
  );
}
