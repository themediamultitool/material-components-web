/*
 * Copyright 2018 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const colors = require('colors');
const request = require('request-promise-native');

const mdcProto = require('../proto/mdc.pb').mdc.proto;
const cbtProto = require('../proto/cbt.pb').cbt.proto;
const seleniumProto = require('../proto/selenium.pb').selenium.proto;

const {UserAgent} = mdcProto;
const {FormFactorType, OsVendorType, BrowserVendorType, BrowserVersionType} = UserAgent;
const {CbtAccount, CbtActiveTestCounts, CbtConcurrencyStats} = cbtProto;
const {RawCapabilities} = seleniumProto;

const DiffBaseParser = require('./diff-base-parser');
const Duration = require('./duration');

const MDC_CBT_USERNAME = process.env.MDC_CBT_USERNAME;
const MDC_CBT_AUTHKEY = process.env.MDC_CBT_AUTHKEY;
const REST_API_BASE_URL = 'https://crossbrowsertesting.com/api/v3';
const SELENIUM_SERVER_URL = `http://${MDC_CBT_USERNAME}:${MDC_CBT_AUTHKEY}@hub.crossbrowsertesting.com:80/wd/hub`;
const {ExitCode, SELENIUM_STALLED_TIME_MS} = require('./constants');

/** @type {?Promise<!Array<!cbt.proto.CbtDevice>>} */
let allBrowsersPromise;

class CbtApi {
  constructor() {
    /**
     * @type {!DiffBaseParser}
     * @private
     */
    this.diffBaseParser_ = new DiffBaseParser();

    this.validateEnvVars_();
  }

  getSeleniumServerUrl() {
    return SELENIUM_SERVER_URL;
  }

  /** @private */
  validateEnvVars_() {
    if (!MDC_CBT_USERNAME) {
      console.error(`
ERROR: Required environment variable 'MDC_CBT_USERNAME' is not set.

Please add the following to your ~/.bash_profile or ~/.bashrc file:

    export MDC_CBT_USERNAME='...'
    export MDC_CBT_AUTHKEY='...'

Credentials can be found on the CBT account page:
https://crossbrowsertesting.com/account
`);
      process.exit(ExitCode.MISSING_ENV_VAR);
    }

    if (!MDC_CBT_AUTHKEY) {
      console.error(`
ERROR: Required environment variable 'MDC_CBT_AUTHKEY' is not set.

Please add the following to your ~/.bash_profile or ~/.bashrc file:

    export MDC_CBT_USERNAME='...'
    export MDC_CBT_AUTHKEY='...'

Credentials can be found on the CBT Account page:
https://crossbrowsertesting.com/account
`);
      process.exit(ExitCode.MISSING_ENV_VAR);
    }
  }

  /**
   * @return {!Promise<!cbt.proto.CbtConcurrencyStats>}
   */
  async fetchConcurrencyStats() {
    const [accountJson, activesJson] = await Promise.all([
      this.sendRequest_('GET', '/account'),
      this.sendRequest_('GET', '/account/activeTestCounts'),
    ]);

    const account = CbtAccount.fromObject(accountJson);
    const actives = CbtActiveTestCounts.fromObject(activesJson);

    return CbtConcurrencyStats.create({
      max_minutes: account.subscription.package.package_minutes,
      used_minutes: Math.ceil(account.subscription.usage.team.automated.total),

      max_concurrent_selenium_tests: account.subscription.package.max_concurrent_selenium,
      active_concurrent_selenium_tests: actives.team.automated,

      max_screenshot_count_per_test: account.subscription.package.max_screenshot_count_per_test,
    });
  }

  /**
   * @return {!Promise<!Array<!cbt.proto.CbtDevice>>}
   */
  async fetchAvailableDevices() {
    if (allBrowsersPromise) {
      return allBrowsersPromise;
    }

    console.log('Fetching browsers from CBT...');

    allBrowsersPromise = this.sendRequest_('GET', '/selenium/browsers');

    return allBrowsersPromise;
  }

  /**
   * @param {string} seleniumSessionId
   * @param {!Array<!mdc.proto.Screenshot>} changedScreenshots
   * @return {!Promise<void>}
   */
  async setTestScore({seleniumSessionId, changedScreenshots}) {
    await this.sendRequest_('PUT', `/selenium/${seleniumSessionId}`, {
      action: 'set_score',
      score: changedScreenshots.length === 0 ? 'pass' : 'fail',
    });
  }

  /**
   * @param {!mdc.proto.ReportMeta} meta
   * @param {!mdc.proto.UserAgent} userAgent
   * @return {!Promise<!selenium.proto.RawCapabilities>}
   */
  async getDesiredCapabilities({meta, userAgent}) {
    // TODO(acdvorak): Create a type for this
    /** @type {{device: !cbt.proto.CbtDevice, browser: !cbt.proto.CbtBrowser}} */
    const matchingCbtUserAgent = await this.getMatchingCbtUserAgent_(userAgent);

    const {cbtBuildName, cbtTestName} = await this.getCbtTestNameAndBuildNameForReport_(meta);

    /** @type {!selenium.proto.RawCapabilities} */
    const defaultCaps = {
      name: `${cbtTestName} - `,
      build: cbtBuildName,

      // TODO(acdvorak): Expose these as CLI flags
      record_video: true,
      record_network: true,
    };

    /** @type {!selenium.proto.RawCapabilities} */
    const deviceCaps = matchingCbtUserAgent.device.caps;

    /** @type {!selenium.proto.RawCapabilities} */
    const browserCaps = matchingCbtUserAgent.browser.caps;

    return RawCapabilities.create(Object.assign({}, defaultCaps, deviceCaps, browserCaps));
  }

  /**
   * @param {!mdc.proto.UserAgent} userAgent
   * @return {!Promise<{device: !cbt.proto.CbtDevice, browser: !cbt.proto.CbtBrowser}>}
   * @private
   */
  async getMatchingCbtUserAgent_(userAgent) {
    /** @type {!Array<!cbt.proto.CbtDevice>} */
    const allCbtDevices = await this.fetchAvailableDevices();

    const formFactorMap = {
      [FormFactorType.DESKTOP]: ['desktop'],
      [FormFactorType.MOBILE]: ['mobile'],
    };

    const osVendorMap = {
      [OsVendorType.ANDROID]: ['Android'],
      [OsVendorType.IOS]: ['iPhone', 'iPad'],
      [OsVendorType.MAC]: ['Mac'],
      [OsVendorType.WINDOWS]: ['Windows'],
    };

    const browserVendorMap = {
      [BrowserVendorType.CHROME]: ['Chrome', 'Chrome Mobile'],
      [BrowserVendorType.EDGE]: ['Microsoft Edge'],
      [BrowserVendorType.FIREFOX]: ['Firefox'],
      [BrowserVendorType.IE]: ['Internet Explorer'],
      [BrowserVendorType.SAFARI]: ['Safari', 'Mobile Safari'],
    };

    const requiredFormFactors = formFactorMap[userAgent.form_factor_type];
    const requiredOsVendors = osVendorMap[userAgent.os_vendor_type];
    const requiredBrowserVendors = browserVendorMap[userAgent.browser_vendor_type];

    /** @type {!Set<string>} */
    const allBrowserApiNames = new Set();
    for (const cbtDevice of allCbtDevices) {
      for (const cbtBrowser of cbtDevice.browsers) {
        allBrowserApiNames.add(cbtBrowser.api_name);
      }
    }

    /** @type {!Array<{device: !cbt.proto.CbtDevice, browser: !cbt.proto.CbtBrowser}>} */
    const matchingCbtUserAgents = [];

    for (const cbtDevice of allCbtDevices) {
      const isMatchingDevice =
        requiredFormFactors.includes(cbtDevice.device) &&
        requiredOsVendors.includes(cbtDevice.type);

      if (!isMatchingDevice) {
        continue;
      }

      for (const cbtBrowser of cbtDevice.browsers) {
        if (!requiredBrowserVendors.includes(cbtBrowser.type)) {
          continue;
        }

        // Skip 32-bit browsers when a 64-bit version is also available
        if (allBrowserApiNames.has(cbtBrowser.api_name + 'x64')) {
          continue;
        }

        matchingCbtUserAgents.push({
          device: cbtDevice,
          browser: cbtBrowser,
        });
      }
    }

    /**
     * @param {string} version1 e.g., "6"
     * @param {string} version2 e.g., "6.0.2"
     * @return {number} Negative if `version1` is less than `version2`;
     *   positive if `version1` is greater than `version2`;
     *   otherwise zero if they are equal.
     */
    function compareVersions(version1, version2) {
      const v1 = parseVersionNumber(version1);
      const v2 = parseVersionNumber(version2);

      // Ensure both arrays are the same length by padding the shorter array with `0`
      v1.forEach((num, idx) => v2[idx] = v2[idx] || 0);
      v2.forEach((num, idx) => v1[idx] = v1[idx] || 0);

      // Subtract each element in v2 from the element with the same index in v1
      const deltas = v1.map((num, idx) => num - v2[idx]);

      // Return the first non-zero delta
      return deltas.filter((num) => num !== 0)[0] || 0;
    }

    /**
     * @param {string} version
     * @return {number[]}
     */
    function parseVersionNumber(version) {
      const numeric = String(version)
        .replace(/ 64-bit$/i, '')
        .replace(/ Beta$/i, '')
        .replace(/ Preview$/i, '')
        .replace(/ Home$/i, '')
        .replace(/ Service Pack \d$/i, '')
        .replace(/^(?:Windows )?XP ?/i, '5.1')
        .replace(/^(?:Windows )?Vista ?/i, '6.0')
        .replace(/^(?:Windows|Win) ?/i, '')
        .replace(/^(?:Mac OS X|Mac OSX|MacOS|OSX|Mac) ?/i, '')
        .replace(/(?:\.0+)+$/g, '')
      ;
      return numeric.split('.').map(Number);
    }

    matchingCbtUserAgents
      .sort((a, b) => {
        return (
          compareVersions(a.device.version, b.device.version) ||
          compareVersions(a.browser.version, b.browser.version) ||
          (a.device.sort_order - b.device.sort_order)
        );
      })
      .reverse()
    ;

    // Exact
    if (userAgent.browser_version_type === BrowserVersionType.EXACT) {
      return matchingCbtUserAgents.find((cbtUserAgent) => {
        const curBrowserVersion = parseVersionNumber(cbtUserAgent.browser.version);
        const requiredBrowserVersion = parseVersionNumber(userAgent.browser_version_value);
        return requiredBrowserVersion.every((number, index) => number === curBrowserVersion[index]);
      });
    }

    // Previous
    if (userAgent.browser_version_type === BrowserVersionType.PREVIOUS) {
      return matchingCbtUserAgents[1];
    }

    // Latest
    return matchingCbtUserAgents[0];
  }

  /**
   * @param {!mdc.proto.ReportMeta} meta
   * @return {{cbtBuildName: string, cbtTestName: string}}
   * @private
   */
  async getCbtTestNameAndBuildNameForReport_(meta) {
    /** @type {?mdc.proto.GitRevision} */
    const travisGitRev = await this.diffBaseParser_.getTravisGitRevision();
    if (travisGitRev) {
      return this.getCbtTestNameAndBuildNameForGitRev_(travisGitRev);
    }

    const snapshotDiffBase = meta.snapshot_diff_base;
    const snapshotGitRev = snapshotDiffBase.git_revision;
    if (snapshotGitRev) {
      return this.getCbtTestNameAndBuildNameForGitRev_(snapshotGitRev);
    }

    const serialized = JSON.stringify(meta, null, 2);
    throw new Error(`Unable to generate CBT test/build name for metadata:\n${serialized}`);
  }

  /**
   * @param {!mdc.proto.GitRevision} gitRev
   * @return {{cbtBuildName: string, cbtTestName: string}}
   * @private
   */
  getCbtTestNameAndBuildNameForGitRev_(gitRev) {
    const nameParts = [
      gitRev.author.email,
      gitRev.commit ? gitRev.commit.substr(0, 7) : null,
      gitRev.branch ? gitRev.branch : null,
      gitRev.tag ? gitRev.tag : null,
      gitRev.pr_number ? `PR #${gitRev.pr_number}` : null,
    ].filter((part) => part);
    return {
      cbtTestName: nameParts.slice(0, -1).join(' - '),
      cbtBuildName: nameParts.slice(-1)[0],
    };
  }

  /**
   * @return {!Promise<void>}
   */
  async killStalledSeleniumTests() {
    // NOTE: This only returns Selenium tests running on the authenticated CBT user's account.
    // It does NOT return Selenium tests running under other users.
    /** @type {!CbtSeleniumListResponse} */
    const listResponse = await this.sendRequest_('GET', '/selenium?active=true&num=100');

    const activeSeleniumTestIds = listResponse.selenium.map((test) => test.selenium_test_id);

    /** @type {!Array<!CbtSeleniumInfoResponse>} */
    const infoResponses = await Promise.all(activeSeleniumTestIds.map((seleniumTestId) => {
      return this.sendRequest_('GET', `/selenium/${seleniumTestId}`);
    }));

    const stalledSeleniumTestIds = [];

    for (const infoResponse of infoResponses) {
      const lastCommand = infoResponse.commands[infoResponse.commands.length - 1];
      if (!lastCommand) {
        continue;
      }

      const commandTimestampMs = new Date(lastCommand.date_issued).getTime();
      if (!Duration.hasElapsed(SELENIUM_STALLED_TIME_MS, commandTimestampMs)) {
        continue;
      }

      stalledSeleniumTestIds.push(infoResponse.selenium_test_id);
    }

    await this.killSeleniumTests(stalledSeleniumTestIds);
  }

  /**
   * @param {!Array<string>} seleniumTestIds
   * @param {boolean=} silent
   * @return {!Promise<void>}
   */
  async killSeleniumTests(seleniumTestIds, silent = false) {
    await Promise.all(seleniumTestIds.map((seleniumTestId) => {
      if (!silent) {
        console.log(`${colors.red('Killing')} zombie Selenium test ${colors.bold(seleniumTestId)}`);
      }
      return this.sendRequest_('DELETE', `/selenium/${seleniumTestId}`);
    }));
  }

  /**
   * @param {string} method
   * @param {string} endpoint
   * @param {!Object=} body
   * @return {!Promise<!Object<string, *>|!Array<*>>}
   * @private
   */
  async sendRequest_(method, endpoint, body = undefined) {
    return request({
      method,
      uri: `${REST_API_BASE_URL}${endpoint}`,
      auth: {
        username: MDC_CBT_USERNAME,
        password: MDC_CBT_AUTHKEY,
      },
      body,
      json: true, // Automatically stringify the request body and parse the response body as JSON
    });
  }
}

module.exports = CbtApi;
