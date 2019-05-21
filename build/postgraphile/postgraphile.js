"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = require("pg");
const events_1 = require("events");
const postgraphile_core_1 = require("postgraphile-core");
const createPostGraphileHttpRequestHandler_1 = require("./http/createPostGraphileHttpRequestHandler");
const exportPostGraphileSchema_1 = require("./schema/exportPostGraphileSchema");
const pluginHook_1 = require("./pluginHook");
const chalk_1 = require("chalk");
const withPostGraphileContext_1 = require("./withPostGraphileContext");
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// tslint:disable-next-line no-any
function isPlainObject(obj) {
    if (!obj || typeof obj !== 'object' || String(obj) !== '[object Object]')
        return false;
    const proto = Object.getPrototypeOf(obj);
    if (proto === null || proto === Object.prototype) {
        return true;
    }
    return false;
}
/**
 * Creates a PostGraphile Http request handler by first introspecting the
 * database to get a GraphQL schema, and then using that to create the Http
 * request handler.
 */
function getPostgraphileSchemaBuilder(pgPool, schema, incomingOptions) {
    if (incomingOptions.live && incomingOptions.subscriptions == null) {
        // live implies subscriptions
        incomingOptions.subscriptions = true;
    }
    const pluginHook = pluginHook_1.pluginHookFromOptions(incomingOptions);
    const options = pluginHook('postgraphile:options', incomingOptions, {
        pgPool,
        schema,
    });
    // Check for a jwtSecret without a jwtPgTypeIdentifier
    // a secret without a token identifier prevents JWT creation
    if (options.jwtSecret && !options.jwtPgTypeIdentifier) {
        // tslint:disable-next-line no-console
        console.warn('WARNING: jwtSecret provided, however jwtPgTypeIdentifier (token identifier) not provided.');
    }
    if (options.handleErrors && (options.extendedErrors || options.showErrorStack)) {
        throw new Error(`You cannot combine 'handleErrors' with the other error options`);
    }
    // Creates the Postgres schemas array.
    const pgSchemas = Array.isArray(schema) ? schema : [schema];
    const _emitter = options['_emitter'] || new events_1.EventEmitter();
    // Creates a promise which will resolve to a GraphQL schema. Connects a
    // client from our pool to introspect the database.
    //
    // This is not a constant because when we are in watch mode, we want to swap
    // out the `gqlSchema`.
    let gqlSchema;
    const gqlSchemaPromise = createGqlSchema();
    return {
        _emitter,
        getGraphQLSchema: () => (gqlSchema ? Promise.resolve(gqlSchema) : gqlSchemaPromise),
        options,
    };
    async function createGqlSchema() {
        let attempts = 0;
        while (true) {
            try {
                if (options.watchPg) {
                    await postgraphile_core_1.watchPostGraphileSchema(pgPool, pgSchemas, options, newSchema => {
                        gqlSchema = newSchema;
                        _emitter.emit('schemas:changed');
                        exportGqlSchema(gqlSchema);
                    });
                    if (!gqlSchema) {
                        throw new Error("Consistency error: watchPostGraphileSchema promises to call the callback before the promise resolves; but this hasn't happened");
                    }
                }
                else {
                    gqlSchema = await postgraphile_core_1.createPostGraphileSchema(pgPool, pgSchemas, options);
                    exportGqlSchema(gqlSchema);
                }
                if (attempts > 0) {
                    // tslint:disable-next-line no-console
                    console.error(`Schema ${attempts > 15 ? 'eventually' : attempts > 5 ? 'finally' : 'now'} generated successfully`);
                }
                return gqlSchema;
            }
            catch (error) {
                attempts++;
                const delay = Math.min(100 * Math.pow(attempts, 2), 30000);
                const exitOnFail = !options.retryOnInitFail;
                // If we fail to build our schema, log the error and either exit or retry shortly
                logSeriousError(error, 'building the initial schema' + (attempts > 1 ? ` (attempt ${attempts})` : ''), exitOnFail
                    ? 'Exiting because `retryOnInitFail` is not set.'
                    : `We'll try again in ${delay}ms.`);
                if (exitOnFail) {
                    process.exit(34);
                }
                // Retry shortly
                await sleep(delay);
            }
        }
    }
    async function exportGqlSchema(newGqlSchema) {
        try {
            await exportPostGraphileSchema_1.default(newGqlSchema, options);
        }
        catch (error) {
            // If we exit cleanly; let calling scripts know there was a problem.
            process.exitCode = 35;
            // If we fail to export our schema, log the error.
            logSeriousError(error, 'exporting the schema');
        }
    }
}
exports.getPostgraphileSchemaBuilder = getPostgraphileSchemaBuilder;
function postgraphile(poolOrConfig, schemaOrOptions, maybeOptions) {
    let schema;
    // These are the raw options we're passed in; getPostgraphileSchemaBuilder
    // must process them with `pluginHook` before we can rely on them.
    let incomingOptions;
    // If the second argument is a string or array, it is the schemas so set the
    // `schema` value and try to use the third argument (or a default) for
    // `incomingOptions`.
    if (typeof schemaOrOptions === 'string' || Array.isArray(schemaOrOptions)) {
        schema = schemaOrOptions;
        incomingOptions = maybeOptions || {};
    }
    // If the second argument is null or an object then use default `schema`
    // and set incomingOptions to second or third argument (or default).
    else if (typeof schemaOrOptions === 'object') {
        schema = 'public';
        incomingOptions = schemaOrOptions || maybeOptions || {};
    }
    // Otherwise if the second argument is present it's invalid: throw an error.
    else if (arguments.length > 1) {
        throw new Error('The second argument to postgraphile was invalid... did you mean to set a schema?');
    }
    // No schema or options specified, use defaults.
    else {
        schema = 'public';
        incomingOptions = {};
    }
    if (typeof poolOrConfig === 'undefined' && arguments.length >= 1) {
        throw new Error('The first argument to postgraphile was `undefined`... did you mean to set pool options?');
    }
    // Do some things with `poolOrConfig` so that in the end, we actually get a
    // Postgres pool.
    const pgPool = toPgPool(poolOrConfig);
    pgPool.on('error', err => {
        /*
         * This handler is required so that client connection errors don't bring
         * the server down (via `unhandledError`).
         *
         * `pg` will automatically terminate the client and remove it from the
         * pool, so we don't actually need to take any action here, just ensure
         * that the event listener is registered.
         */
        // tslint:disable-next-line no-console
        console.error('PostgreSQL client generated error: ', err.message);
    });
    pgPool.on('connect', pgClient => {
        // Enhance our Postgres client with debugging stuffs.
        withPostGraphileContext_1.debugPgClient(pgClient);
    });
    const { getGraphQLSchema, options, _emitter } = getPostgraphileSchemaBuilder(pgPool, schema, incomingOptions);
    return createPostGraphileHttpRequestHandler_1.default(Object.assign({}, (typeof poolOrConfig === 'string' ? { ownerConnectionString: poolOrConfig } : {}), options, { getGqlSchema: getGraphQLSchema, pgPool,
        _emitter }));
}
exports.default = postgraphile;
function logSeriousError(error, when, nextSteps) {
    // tslint:disable-next-line no-console
    console.error(`A ${chalk_1.default.bold('serious error')} occurred when ${chalk_1.default.bold(when)}. ${nextSteps ? nextSteps + ' ' : ''}Error details:\n\n${error.stack}\n`);
}
function hasPoolConstructor(obj) {
    return (
    // tslint:disable-next-line no-any
    (obj && typeof obj.constructor === 'function' && obj.constructor === pg_1.Pool.super_) ||
        false);
}
function constructorName(obj) {
    return ((obj &&
        typeof obj.constructor === 'function' &&
        obj.constructor.name &&
        String(obj.constructor.name)) ||
        null);
}
// tslint:disable-next-line no-any
function toPgPool(poolOrConfig) {
    if (quacksLikePgPool(poolOrConfig)) {
        // If it is already a `Pool`, just use it.
        return poolOrConfig;
    }
    if (typeof poolOrConfig === 'string') {
        // If it is a string, let us parse it to get a config to create a `Pool`.
        return new pg_1.Pool({ connectionString: poolOrConfig });
    }
    else if (!poolOrConfig) {
        // Use an empty config and let the defaults take over.
        return new pg_1.Pool({});
    }
    else if (isPlainObject(poolOrConfig)) {
        // The user handed over a configuration object, pass it through
        return new pg_1.Pool(poolOrConfig);
    }
    else {
        throw new Error('Invalid connection string / Pool ');
    }
}
// tslint:disable-next-line no-any
function quacksLikePgPool(pgConfig) {
    if (pgConfig instanceof pg_1.Pool)
        return true;
    if (hasPoolConstructor(pgConfig))
        return true;
    // A diagnosis of exclusion
    if (!pgConfig || typeof pgConfig !== 'object')
        return false;
    if (constructorName(pgConfig) !== 'Pool' && constructorName(pgConfig) !== 'BoundPool')
        return false;
    if (!pgConfig['Client'])
        return false;
    if (!pgConfig['options'])
        return false;
    if (typeof pgConfig['connect'] !== 'function')
        return false;
    if (typeof pgConfig['end'] !== 'function')
        return false;
    if (typeof pgConfig['query'] !== 'function')
        return false;
    return true;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicG9zdGdyYXBoaWxlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc3JjL3Bvc3RncmFwaGlsZS9wb3N0Z3JhcGhpbGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSwyQkFBc0M7QUFHdEMsbUNBQXNDO0FBQ3RDLHlEQUFzRjtBQUN0RixzR0FBK0Y7QUFDL0YsZ0ZBQXlFO0FBQ3pFLDZDQUFxRDtBQUVyRCxpQ0FBMEI7QUFDMUIsdUVBQTBEO0FBRTFELE1BQU0sS0FBSyxHQUFHLENBQUMsRUFBVSxFQUFFLEVBQUUsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLFVBQVUsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQztBQUU5RSxrQ0FBa0M7QUFDbEMsU0FBUyxhQUFhLENBQUMsR0FBUTtJQUM3QixJQUFJLENBQUMsR0FBRyxJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVEsSUFBSSxNQUFNLENBQUMsR0FBRyxDQUFDLEtBQUssaUJBQWlCO1FBQUUsT0FBTyxLQUFLLENBQUM7SUFDdkYsTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUN6QyxJQUFJLEtBQUssS0FBSyxJQUFJLElBQUksS0FBSyxLQUFLLE1BQU0sQ0FBQyxTQUFTLEVBQUU7UUFDaEQsT0FBTyxJQUFJLENBQUM7S0FDYjtJQUNELE9BQU8sS0FBSyxDQUFDO0FBQ2YsQ0FBQztBQVdEOzs7O0dBSUc7QUFDSCxTQUFnQiw0QkFBNEIsQ0FJMUMsTUFBWSxFQUNaLE1BQThCLEVBQzlCLGVBQXVEO0lBRXZELElBQUksZUFBZSxDQUFDLElBQUksSUFBSSxlQUFlLENBQUMsYUFBYSxJQUFJLElBQUksRUFBRTtRQUNqRSw2QkFBNkI7UUFDN0IsZUFBZSxDQUFDLGFBQWEsR0FBRyxJQUFJLENBQUM7S0FDdEM7SUFDRCxNQUFNLFVBQVUsR0FBRyxrQ0FBcUIsQ0FBQyxlQUFlLENBQUMsQ0FBQztJ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