import './polyfills'
import * as fs from 'fs';
import * as superagent from 'superagent';
import {getJSONFilesInFolderRecursively, isEmptyObj} from './utils';
import {runFunctionalOnLocalhost} from 'loadmill-runner';

export = Loadmill;

namespace Loadmill {
    export interface LoadmillOptions {
        token: string;
    }

    export interface TestDef {
        id: string;
        type: string;
    }

    export interface TestResult extends TestDef {
        url: string;
        passed: boolean;
    }

    export type Configuration = object | string;
    export type ParamsOrCallback = object | Callback;
    export type Callback = {(err: Error | null, result: any): void} | undefined;
}

const TYPE_LOAD = 'load';
const TYPE_FUNCTIONAL = 'functional';

function Loadmill(options: Loadmill.LoadmillOptions) {
    const {
        token,
        _testingServerHost = "www.loadmill.com"
    } = options as any;

    const testingServer = "https://" + _testingServerHost;

    async function _runFolderSync(
        listOfFiles: string[],
        execFunc: (...args) => Promise<string>,
        ...funcArgs) {

        const results: Loadmill.TestResult[] = [];

        for (let file of listOfFiles)  {
            let id = await execFunc(file, ...funcArgs);
            let testResult = await _wait(id);
            results.push(testResult);
            if (!testResult.passed) break;
        }

        return results;
    }

    async function _wait(testDefOrId: string | Loadmill.TestDef, callback?: Loadmill.Callback): Promise<Loadmill.TestResult> {
        let resolve, reject;

        const testDef = typeof testDefOrId === 'string' ? {
            id: testDefOrId,
            type: TYPE_LOAD,
        } : testDefOrId;

        const apiUrl = getTestUrl(testDef,
            testingServer + '/api/tests/', 'trials/', '');

        const webUrl = getTestUrl(testDef,
            testingServer + '/app/', 'functional/', 'test/');

        const intervalId = setInterval(async () => {
                try {
                    const {body: {trialResult, result}} = await superagent.get(apiUrl)
                        .auth(token, '');

                    if (result || trialResult) {
                        clearInterval(intervalId);

                        const testResult = {
                            ...testDef,
                            url: webUrl,
                            passed: testDef.type === TYPE_LOAD ?
                                result === 'done' : isFunctionalPassed(trialResult),
                        };

                        if (callback) {
                            callback(null, testResult);
                        }
                        else {
                            resolve(testResult);
                        }
                    }
                }
                catch (err) {
                    if (testDef.type === TYPE_FUNCTIONAL && err.status === 404) {
                        // 404 for functional could be fine when async - keep going:
                        return;
                    }

                    clearInterval(intervalId);

                    if (callback) {
                        callback(err, null);
                    }
                    else {
                        reject(err);
                    }
                }
            },
            10 * 1000);

        return callback ? null! as Promise<any> : new Promise((_resolve, _reject) => {
            resolve = _resolve;
            reject = _reject;
        });
    }

    async function _runFunctionalLocally(
        config: Loadmill.Configuration,
        paramsOrCallback: Loadmill.ParamsOrCallback,
        callback: Loadmill.Callback) {
        return wrap(
            async () => {
                config = toConfig(config, paramsOrCallback);

                config['async'] = false;

                const trialRes = await runFunctionalOnLocalhost(config);

                if (!isEmptyObj(trialRes.failures)) {
                    console.error('\x1b[31m', 'Test failure response -', '\x1b[0m', `${JSON.stringify(trialRes)}`);
                }
                return {
                    type: TYPE_FUNCTIONAL,
                    passed: isFunctionalPassed(trialRes),
                };
            },
            callback || paramsOrCallback
        );
    }

    async function _runFunctional(
        config: Loadmill.Configuration,
        async: boolean,
        paramsOrCallback: Loadmill.ParamsOrCallback,
        callback: Loadmill.Callback) {

        return wrap(
            async () => {
                config = toConfig(config, paramsOrCallback);

                config['async'] = async;

                const {
                    body: {
                        id,
                        trialResult,
                        incompleteMessage,
                    }
                } = await superagent.post(testingServer + "/api/tests/trials")
                    .send(config)
                    .auth(token, '');

                if (incompleteMessage) {
                    throw Error(incompleteMessage);
                }
                else {
                    return {
                        id,
                        type: TYPE_FUNCTIONAL,
                        url: `${testingServer}/app/functional/${id}`,
                        passed: async ? null : isFunctionalPassed(trialResult),
                    };
                }
            },
            callback || paramsOrCallback
        );
    }

    return {
        run(
            config: Loadmill.Configuration,
            paramsOrCallback?: Loadmill.ParamsOrCallback,
            callback?: Loadmill.Callback): Promise<string> {

            return wrap(
                async () => {
                    config = toConfig(config, paramsOrCallback);

                    const {body: {testId}} = await superagent.post(testingServer + "/api/tests")
                        .send(config)
                        .auth(token, '');

                    await superagent.put(`${testingServer}/api/tests/${testId}/load`)
                        .auth(token, '');

                    return testId;
                },
                callback || paramsOrCallback
            );
        },

        async runFolder(
            folderPath: string,
            paramsOrCallback?: Loadmill.ParamsOrCallback,
            callback?: Loadmill.Callback): Promise<Array<Loadmill.TestResult>> {

            const listOfFiles = getJSONFilesInFolderRecursively(folderPath);
            if (listOfFiles.length === 0) {
                console.log(`No Loadmill test files were found at ${folderPath} - exiting...`);
            }
            return _runFolderSync(listOfFiles, this.run, paramsOrCallback, callback);

        },

        wait(testDefOrId: string | Loadmill.TestDef, callback?: Loadmill.Callback): Promise<Loadmill.TestResult> {
           return _wait(testDefOrId, callback);
        },

        runFunctional(
            config: Loadmill.Configuration,
            paramsOrCallback?: Loadmill.ParamsOrCallback,
            callback?: Loadmill.Callback): Promise<Loadmill.TestResult> {

            return _runFunctional(config, false, paramsOrCallback, callback);
        },

        async runFunctionalFolder(
            folderPath: string,
            paramsOrCallback?: Loadmill.ParamsOrCallback,
            callback?: Loadmill.Callback): Promise<Array<Loadmill.TestResult>> {

            const listOfFiles = getJSONFilesInFolderRecursively(folderPath);
            if (listOfFiles.length === 0) {
                console.log(`No Loadmill test files were found at ${folderPath} - exiting...`);
            }

            return _runFolderSync(listOfFiles, _runFunctional, false, paramsOrCallback, callback);
        },

        async runFunctionalLocally(config: Loadmill.Configuration,
                                   paramsOrCallback?: Loadmill.ParamsOrCallback,
                                   callback?: Loadmill.Callback): Promise<Loadmill.TestResult> {
            return _runFunctionalLocally(config, paramsOrCallback, callback);
        },

        async runFunctionalFolderLocally(
            folderPath: string,
            paramsOrCallback?: Loadmill.ParamsOrCallback,
            callback?: Loadmill.Callback): Promise<Array<Loadmill.TestResult>> {

            const listOfFiles = getJSONFilesInFolderRecursively(folderPath);
            if (listOfFiles.length === 0) {
                console.log(`No Loadmill test files were found at ${folderPath} - exiting...`);
            }

            return _runFolderSync(listOfFiles, _runFunctionalLocally, paramsOrCallback, callback);
        },

        runAsyncFunctional(
            config: Loadmill.Configuration,
            paramsOrCallback?: Loadmill.ParamsOrCallback,
            callback?: Loadmill.Callback): Promise<Loadmill.TestResult> {

            return _runFunctional(config,true, paramsOrCallback, callback);
        },
    };
}

function isFunctionalPassed(trialResult) {
    return !!trialResult && Object.keys(trialResult.failures || {}).length === 0;
}

function getTestUrl({id, type}: Loadmill.TestDef, prefix: string, funcSuffix: string, loadSuffix: string) {
    const suffix = type === TYPE_FUNCTIONAL ? funcSuffix : loadSuffix;
    return `${prefix}${suffix}${id}`
}

function wrap(asyncFunction, paramsOrCallback?: Loadmill.ParamsOrCallback) {
    const promise = asyncFunction();

    if (typeof paramsOrCallback === 'function') {
        promise.then(res => paramsOrCallback(null, res))
            .catch(err => paramsOrCallback(err, null));
    }
    else {
        return promise;
    }
}

function toConfig(config: any | string, paramsOrCallback?: Loadmill.ParamsOrCallback) {
    if (typeof config === 'string') {
        let text = fs.readFileSync(config).toString();
        config = JSON.parse(text);
    }

    if (typeof paramsOrCallback === 'object' && paramsOrCallback != null) {
        let parameters = config.parameters;

        if (!parameters) {
            config.parameters = paramsOrCallback;
        }
        else if (typeof parameters.push === 'function') {
            parameters.push(paramsOrCallback);
        }
        else {
            config.parameters = [parameters, paramsOrCallback];
        }
    }

    return config;
}
