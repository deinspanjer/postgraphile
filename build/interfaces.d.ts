/// <reference types="node" />
import { GraphQLError, GraphQLSchema, SourceLocation, DocumentNode } from 'graphql';
import { IncomingMessage, ServerResponse } from 'http';
import { PluginHookFn } from './postgraphile/pluginHook';
import { Pool } from 'pg';
import { Plugin, PostGraphileCoreOptions } from 'postgraphile-core';
import jwt = require('jsonwebtoken');
import { EventEmitter } from 'events';
/**
 * A narrower type than `any` that won’t swallow errors from assumptions about
 * code.
 *
 * For example `(x as any).anything()` is ok. That function then returns `any`
 * as well so the problem compounds into `(x as any).anything().else()` and the
 * problem just goes from there. `any` is a type black hole that swallows any
 * useful type information and shouldn’t be used unless you know what you’re
 * doing.
 *
 * With `mixed` you must *prove* the type is what you want to use.
 *
 * The `mixed` type is identical to the `mixed` type in Flow.
 *
 * @see https://github.com/Microsoft/TypeScript/issues/9999
 * @see https://flowtype.org/docs/builtins.html#mixed
 */
export declare type mixed = {} | string | number | boolean | undefined | null;
export declare type Middleware = (req: IncomingMessage, res: ServerResponse, next: (err?: Error) => void) => void;
export interface PostGraphileOptions<Request extends IncomingMessage = IncomingMessage, Response extends ServerResponse = ServerResponse> extends PostGraphileCoreOptions {
    watchPg?: boolean;
    retryOnInitFail?: boolean;
    ownerConnectionString?: string;
    subscriptions?: boolean;
    live?: boolean;
    websocketMiddlewares?: Array<Middleware>;
    pgDefaultRole?: string;
    dynamicJson?: boolean;
    setofFunctionsContainNulls?: boolean;
    classicIds?: boolean;
    disableDefaultMutations?: boolean;
    ignoreRBAC?: boolean;
    ignoreIndexes?: boolean;
    includeExtensionResources?: boolean;
    showErrorStack?: boolean | 'json';
    extendedErrors?: Array<string>;
    handleErrors?: (errors: ReadonlyArray<GraphQLError>, req: Request, res: Response) => Array<GraphQLErrorExtended>;
    appendPlugins?: Array<Plugin>;
    prependPlugins?: Array<Plugin>;
    replaceAllPlugins?: Array<Plugin>;
    skipPlugins?: Array<Plugin>;
    readCache?: string;
    writeCache?: string;
    exportJsonSchemaPath?: string;
    exportGqlSchemaPath?: string;
    sortExport?: boolean;
    graphqlRoute?: string;
    graphiqlRoute?: string;
    externalUrlBase?: string;
    graphiql?: boolean;
    graphiqlAuthorizationEventOrigin?: string;
    enhanceGraphiql?: boolean;
    enableCors?: boolean;
    bodySizeLimit?: string;
    enableQueryBatching?: boolean;
    jwtSecret?: string;
    jwtVerifyOptions?: jwt.VerifyOptions;
    jwtRole?: Array<string>;
    jwtPgTypeIdentifier?: string;
    jwtAudiences?: Array<string>;
    legacyRelations?: 'only' | 'deprecated' | 'omit';
    legacyJsonUuid?: boolean;
    disableQueryLog?: boolean;
    pgSettings?: {
        [key: string]: mixed;
    } | ((req: Request) => Promise<{
        [key: string]: mixed;
    }>);
    additionalGraphQLContextFromRequest?: (req: Request, res: Response) => Promise<{}>;
    pluginHook?: PluginHookFn;
    simpleCollections?: 'omit' | 'both' | 'only';
    queryCacheMaxSize?: number;
}
export interface CreateRequestHandlerOptions extends PostGraphileOptions {
    getGqlSchema: () => Promise<GraphQLSchema>;
    pgPool: Pool;
    _emitter: EventEmitter;
}
export interface GraphQLFormattedErrorExtended {
    message: string;
    locations: ReadonlyArray<SourceLocation> | void;
    path: ReadonlyArray<string | number> | void;
    extensions?: {
        [s: string]: any;
    };
}
export declare type GraphQLErrorExtended = GraphQLError & {
    extensions: {
        exception: {
            hint: string;
            detail: string;
            code: string;
        };
    };
};
/**
 * A request handler for one of many different `http` frameworks.
 */
export interface HttpRequestHandler<Request extends IncomingMessage = IncomingMessage, Response extends ServerResponse = ServerResponse> {
    (req: Request, res: Response, next?: (error?: mixed) => void): Promise<void>;
    (ctx: {
        req: Request;
        res: Response;
    }, next: () => void): Promise<void>;
    formatError: (e: GraphQLError) => GraphQLFormattedErrorExtended;
    getGraphQLSchema: () => Promise<GraphQLSchema>;
    pgPool: Pool;
    withPostGraphileContextFromReqRes: (req: Request, res: Response, moreOptions: any, fn: (ctx: mixed) => any) => Promise<any>;
    options: CreateRequestHandlerOptions;
    handleErrors: (errors: ReadonlyArray<GraphQLError>, req: Request, res: Response) => Array<GraphQLErrorExtended>;
}
/**
 * Options passed to the `withPostGraphileContext` function
 */
export interface WithPostGraphileContextOptions {
    pgPool: Pool;
    jwtToken?: string;
    jwtSecret?: string;
    jwtAudiences?: Array<string>;
    jwtRole?: Array<string>;
    jwtVerifyOptions?: jwt.VerifyOptions;
    pgDefaultRole?: string;
    pgSettings?: {
        [key: string]: mixed;
    };
    queryDocumentAst?: DocumentNode;
    operationName?: string;
    pgForceTransaction?: boolean;
    singleStatement?: boolean;
    variables?: any;
}