// *****************************************************************************
// Copyright (C) 2022 Ericsson and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
// *****************************************************************************

import type { FilterFactory, OVSXRequestFilter, OVSXResultFilter } from './ovsx-router-filters';
import { OVSXClient, VSXQueryOptions, VSXQueryResult, VSXSearchOptions, VSXSearchResult } from './ovsx-types';
import type { MaybePromise } from './types';

export interface OVSXRouterConfig {
    /**
     * Registry aliases that will be used for routing.
     */
    registries?: {
        [alias: string]: string
    }
    /**
     * The registry/ies to use by default.
     */
    use: string | string[]
    /**
     * todo
     */
    filters?: {
        /**
         * todo
         */
        requests?: OVSXRouterRule[]
        /**
         * todo
         */
        results?: OVSXRouterRule[]
    }
}

export interface OVSXRouterRule {
    [condition: string]: unknown
    use?: string | string[] | null
}

/**
 * @internal
 */
export interface OVSXParsedRule<T> {
    filters: T[]
    use: string[]
}

/**
 * Route and agglomerate queries according to {@link routerConfig}.
 * {@link ruleFactories} is the actual logic used to evaluate the config.
 * Each rule implementation will be ran sequentially over each configured rule.
 */
export class OVSXRouterClient implements OVSXClient {

    static async FromConfig(
        routerConfig: OVSXRouterConfig,
        getClient: (uri: string) => OVSXClient,
        requestFilterFactories: FilterFactory<OVSXRequestFilter>[] = [],
        resultFilterFactories: FilterFactory<OVSXResultFilter>[] = []
    ): Promise<OVSXRouterClient> {
        const [
            requestFilters,
            resultFilters
        ] = await Promise.all([
            Array.isArray(routerConfig.filters?.requests) ? this.ParseRule(routerConfig.filters!.requests, requestFilterFactories, routerConfig.registries) : [],
            Array.isArray(routerConfig.filters?.results) ? this.ParseRule(routerConfig.filters!.results, resultFilterFactories, routerConfig.registries) : []
        ]);
        return new this(
            this.ParseUse(routerConfig.use, routerConfig.registries),
            getClient,
            requestFilters,
            resultFilters
        );
    }

    protected static async ParseRule<T>(rules: OVSXRouterRule[], filterFactories: FilterFactory<T>[], aliases?: Record<string, string>): Promise<OVSXParsedRule<T>[]> {
        return Promise.all(rules.map(async ({ use, ...conditions }) => {
            const remainingKeys = new Set(Object.keys(conditions));
            const filters = await mapNonNull(filterFactories, ruleFactory => ruleFactory(conditions, remainingKeys));
            if (remainingKeys.size > 0) {
                throw new Error(`unknown conditions: ${Array.from(remainingKeys).join(', ')}`);
            }
            return {
                filters,
                use: this.ParseUse(use, aliases)
            };
        }));
    }

    protected static ParseUse(use: string | string[] | null | undefined, aliases?: Record<string, string>): string[] {
        if (typeof use === 'string') {
            return [alias(use)];
        } else if (Array.isArray(use)) {
            return use.filter(value => typeof value === 'string').map(alias);
        } else {
            return [];
        }
        function alias(aliasOrUri: string): string {
            return aliases?.[aliasOrUri] ?? aliasOrUri;
        }
    }

    constructor(
        protected useDefault: string[],
        protected getClient: (uri: string) => OVSXClient,
        protected requestFilters: OVSXParsedRule<OVSXRequestFilter>[],
        protected resultFilters: OVSXParsedRule<OVSXResultFilter>[]
    ) { }

    async search(searchOptions?: VSXSearchOptions): Promise<VSXSearchResult> {
        for (const { filters, use } of this.requestFilters) {
            const test = await mapNonNull(filters, filter => filter.filterSearchOptions?.(searchOptions));
            if (test.length === 0 || test.some(value => !value)) {
                continue;
            }
            if (use.length > 0) {
                return this.mergedSearch(use, searchOptions);
            }
            return {
                extensions: [],
                offset: searchOptions?.offset ?? 0
            };
        }
        return this.mergedSearch(this.useDefault, searchOptions);
    }

    async query(queryOptions: VSXQueryOptions = {}): Promise<VSXQueryResult> {
        for (const { filters, use } of this.requestFilters) {
            const test = await mapNonNull(filters, filter => filter.filterQueryOptions?.(queryOptions));
            if (test.length === 0 || test.some(value => !value)) {
                continue;
            }
            if (use.length > 0) {
                return this.mergedQuery(use, queryOptions);
            }
            return {
                extensions: []
            };
        }
        return this.mergedQuery(this.useDefault, queryOptions);
    }

    protected async mergedQuery(registries: string[], queryOptions?: VSXQueryOptions): Promise<VSXQueryResult> {
        return this.mergeQueryResults(await createMapping(registries, registry => this.getClient(registry).query(queryOptions)));
    }

    protected async mergedSearch(registries: string[], searchOptions?: VSXSearchOptions): Promise<VSXSearchResult> {
        // do not mutate the original value passed as parameter, if any
        searchOptions &&= { ...searchOptions };
        if (typeof searchOptions?.size === 'number') {
            searchOptions.size = Math.min(1, Math.floor(searchOptions.size / registries.length));
        }
        const result = await this.mergeSearchResults(await createMapping(registries, registry => this.getClient(registry).search(searchOptions)));
        if (typeof searchOptions?.size === 'number') {
            result.extensions = result.extensions.slice(0, searchOptions.size);
        }
        return result;
    }

    protected async mergeSearchResults(results: Map<string, VSXSearchResult>): Promise<VSXSearchResult> {
        const extensions = interleave(await Promise.all(
            Array.from(results, ([sourceUri, result]) => mapNonNull(result.extensions, async extension => {
                for (const { filters, use } of this.resultFilters) {
                    const test = await mapNonNull(filters, filter => filter.filterExtension?.(extension));
                    if (test.length === 0 || test.some(value => !value)) {
                        continue;
                    }
                    if (use.includes(sourceUri)) {
                        return extension;
                    }
                    return;
                }
                return extension;
            }))
        ));
        return {
            extensions,
            offset: 0
        };
    }

    protected async mergeQueryResults(results: Map<string, VSXQueryResult>): Promise<VSXQueryResult> {
        const extensions = (await Promise.all(
            Array.from(results, ([sourceUri, result]) => mapNonNull(result.extensions, async extension => {
                for (const { filters, use } of this.resultFilters) {
                    const test = await mapNonNull(filters, filter => filter.filterExtension?.(extension));
                    if (test.length === 0 || test.some(value => !value)) {
                        continue;
                    }
                    if (use.includes(sourceUri)) {
                        return extension;
                    }
                    return;
                }
                return extension;
            }))
        )).flat();
        return {
            extensions
        };
    }
}

/**
 * Create a map where the keys are each element from {@link values} and the
 * values are the result of a mapping function applied on the key.
 */
async function createMapping<T, U>(values: T[], map: (value: T) => MaybePromise<U>, thisArg?: unknown): Promise<Map<T, U>> {
    return new Map(await Promise.all(values.map(async value => [value, await map.call(thisArg, value)] as [T, U])));
}

/**
 * Asynchronously map the {@link values} array using the {@link map}
 * function, then remove all null elements.
 */
async function mapNonNull<T, U>(values: T[], map: (value: T) => MaybePromise<U>, thisArg?: unknown): Promise<NonNullable<U>[]> {
    return (await Promise.all(values.map(map, thisArg))).filter(nonNullable);
}

/**
 * @example
 * interleave([[1, 2, 3], [4, 5], [6, 7, 8]]) === [1, 4, 6, 2, 5, 7, 3, 8]
 */
function interleave<T>(arrays: T[][]): T[] {
    const interleaved: T[] = [];
    const length = Math.max(...arrays.map(array => array.length));
    for (let i = 0; i < length; i++) {
        for (const array of arrays) {
            if (i < array.length) {
                interleaved.push(array[i]);
            }
        }
    }
    return interleaved;
}

function nonNullable<T>(value: T): value is NonNullable<T> {
    // eslint-disable-next-line no-null/no-null
    return typeof value !== 'undefined' && value !== null;
}
