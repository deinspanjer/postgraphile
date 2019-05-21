"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const createDebugger = require("debug");
const jwt = require("jsonwebtoken");
const graphql_1 = require("graphql");
const sql = require("pg-sql2");
const pgClientFromContext_1 = require("../postgres/inventory/pgClientFromContext");
const pluginHook_1 = require("./pluginHook");
const postgraphile_core_1 = require("postgraphile-core");
const undefinedIfEmpty = (o) => o && (!Array.isArray(o) || o.length) ? o : undefined;
const debugPg = createDebugger('postgraphile:postgres');
const debugPgError = createDebugger('postgraphile:postgres:error');
const debugPgNotice = createDebugger('postgraphile:postgres:notice');
/**
 * Formats an error/notice from `pg` and feeds it into a `debug` function.
 */
function debugPgErrorObject(debugFn, object) {
    debugFn('%s%s: %s%s%s', object.severity || 'ERROR', object.code ? `[${object.code}]` : '', object.message || object, object.where ? ` | WHERE: ${object.where}` : '', object.hint ? ` | HINT: ${object.hint}` : '');
}
const simpleWithPgClientCache = new WeakMap();
function simpleWithPgClient(pgPool) {
    const cached = simpleWithPgClientCache.get(pgPool);
    if (cached) {
        return cached;
    }
    const func = async (cb) => {
        const pgClient = await pgPool.connect();
        try {
            return await cb(pgClient);
        }
        finally {
            pgClient.release();
        }
    };
    simpleWithPgClientCache.set(pgPool, func);
    return func;
}
const withDefaultPostGraphileContext = async (options, callback) => {
    const { pgPool, jwtToken, jwtSecret, jwtAudiences, jwtRole = ['role'], jwtVerifyOptions, pgDefaultRole, pgSettings, queryDocumentAst, operationName, pgForceTransaction, singleStatement, } = options;
    let operation;
    if (!pgForceTransaction && queryDocumentAst) {
        // tslint:disable-next-line
        for (let i = 0, l = queryDocumentAst.definitions.length; i < l; i++) {
            const definition = queryDocumentAst.definitions[i];
            if (definition.kind === graphql_1.Kind.OPERATION_DEFINITION) {
                if (!operationName && operation) {
                    throw new Error('Multiple operations present in GraphQL query, you must specify an `operationName` so we know which one to execute.');
                }
                else if (!operationName || (definition.name && definition.name.value === operationName)) {
                    operation = definition;
                }
            }
        }
    }
    // Warning: this is only set if pgForceTransaction is falsy
    const operationType = operation != null ? operation.operation : null;
    const { role: pgRole, localSettings, jwtClaims } = getSettingsForPgClientTransaction({
        jwtToken,
        jwtSecret,
        jwtAudiences,
        jwtRole,
        jwtVerifyOptions,
        pgDefaultRole,
        pgSettings,
    });
    const sqlSettings = [];
    if (localSettings.length > 0) {
        // Later settings should win, so we're going to loop backwards and not
        // add settings for keys we've already seen.
        const seenKeys = [];
        // TODO:perf: looping backwards is slow
        for (let i = localSettings.length - 1; i >= 0; i--) {
            const [key, value] = localSettings[i];
            if (seenKeys.indexOf(key) < 0) {
                seenKeys.push(key);
                // Make sure that the third config is always `true` so that we are only
                // ever setting variables on the transaction.
                // Also, we're using `unshift` to undo the reverse-looping we're doing
                sqlSettings.unshift(sql.fragment `set_config(${sql.value(key)}, ${sql.value(value)}, true)`);
            }
        }
    }
    const sqlSettingsQuery = sqlSettings.length > 0 ? sql.compile(sql.query `select ${sql.join(sqlSettings, ', ')}`) : null;
    // If we can avoid transactions, we get greater performance.
    const needTransaction = pgForceTransaction ||
        !!sqlSettingsQuery ||
        (operationType !== 'query' && operationType !== 'subscription');
    // Now we've caught as many errors as we can at this stage, let's create a DB connection.
    const withAuthenticatedPgClient = !needTransaction
        ? simpleWithPgClient(pgPool)
        : async (cb) => {
            // Connect a new Postgres client
            const pgClient = await pgPool.connect();
            // Begin our transaction
            await pgClient.query('begin');
            try {
                // If there is at least one local setting, load it into the database.
                if (sqlSettingsQuery) {
                    await pgClient.query(sqlSettingsQuery);
                }
                // Use the client, wait for it to be finished with, then go to 'finally'
                return await cb(pgClient);
            }
            finally {
                // Cleanup our Postgres client by ending the transaction and releasing
                // the client back to the pool. Always do this even if the query fails.
                try {
                    await pgClient.query('commit');
                }
                finally {
                    pgClient.release();
                }
            }
        };
    if (singleStatement) {
        // TODO:v5: remove this workaround
        /*
         * This is a workaround for subscriptions; the GraphQL context is allocated
         * for the entire duration of the subscription, however hogging a pgClient
         * for more than a few milliseconds (let alone hours!) is a no-no. So we
         * fake a PG client that will set up the transaction each time `query` is
         * called. It's a very thin/dumb wrapper, so it supports nothing but
         * `query`.
         */
        const fakePgClient = {
            query(textOrQueryOptions, values, // tslint:disable-line no-any
            cb) {
                if (!textOrQueryOptions) {
                    throw new Error('Incompatible call to singleStatement - no statement passed?');
                }
                else if (typeof textOrQueryOptions === 'object') {
                    if (values || cb) {
                        throw new Error('Incompatible call to singleStatement - expected no callback');
                    }
                }
                else if (typeof textOrQueryOptions !== 'string') {
                    throw new Error('Incompatible call to singleStatement - bad query');
                }
                else if (values && !Array.isArray(values)) {
                    throw new Error('Incompatible call to singleStatement - bad values');
                }
                else if (cb) {
                    throw new Error('Incompatible call to singleStatement - expected to return promise');
                }
                // Generate an authenticated client on the fly
                return withAuthenticatedPgClient(pgClient => pgClient.query(textOrQueryOptions, values));
            },
        }; // tslint:disable-line no-any
        return callback({
            [pgClientFromContext_1.$$pgClient]: fakePgClient,
            pgRole,
            jwtClaims,
        });
    }
    else {
        return withAuthenticatedPgClient(pgClient => callback({
            [pgClientFromContext_1.$$pgClient]: pgClient,
            pgRole,
            jwtClaims,
        }));
    }
};
/**
 * Creates a PostGraphile context object which should be passed into a GraphQL
 * execution. This function will also connect a client from a Postgres pool and
 * setup a transaction in that client.
 *
 * This function is intended to wrap a call to GraphQL-js execution like so:
 *
 * ```js
 * const result = await withPostGraphileContext({
 *   pgPool,
 *   jwtToken,
 *   jwtSecret,
 *   pgDefaultRole,
 * }, async context => {
 *   return await graphql(
 *     schema,
 *     query,
 *     null,
 *     { ...context },
 *     variables,
 *     operationName,
 *   );
 * });
 * ```
 */
const withPostGraphileContext = async (options, callback) => {
    const pluginHook = pluginHook_1.pluginHookFromOptions(options);
    const withContext = pluginHook('withPostGraphileContext', withDefaultPostGraphileContext, {
        options,
    });
    return withContext(options, callback);
};
exports.default = withPostGraphileContext;
/**
 * Sets up the Postgres client transaction by decoding the JSON web token and
 * doing some other cool things.
 */
// THIS METHOD SHOULD NEVER RETURN EARLY. If this method returns early then it
// may skip the super important step of setting the role on the Postgres
// client. If this happens it’s a huge security vulnerability. Never using the
// keyword `return` in this function is a good first step. You can still throw
// errors, however, as this will stop the request execution.
function getSettingsForPgClientTransaction({ jwtToken, jwtSecret, jwtAudiences, jwtRole, jwtVerifyOptions, pgDefaultRole, pgSettings, }) {
    // Setup our default role. Once we decode our token, the role may change.
    let role = pgDefaultRole;
    let jwtClaims = {};
    // If we were provided a JWT token, let us try to verify it. If verification
    // fails we want to throw an error.
    if (jwtToken) {
        // Try to run `jwt.verify`. If it fails, capture the error and re-throw it
        // as a 403 error because the token is not trustworthy.
        try {
            // If a JWT token was defined, but a secret was not provided to the server or
            // secret had unsupported type, throw a 403 error.
            if (!Buffer.isBuffer(jwtSecret) && typeof jwtSecret !== 'string') {
                // tslint:disable-next-line no-console
                console.error('ERROR: `jwtToken` was provided, but `jwtSecret` was not set to a string or buffer - rejecting request.');
                throw new Error('Not allowed to provide a JWT token.');
            }
            if (jwtAudiences != null && jwtVerifyOptions && 'audience' in jwtVerifyOptions)
                throw new Error(`Provide either 'jwtAudiences' or 'jwtVerifyOptions.audience' but not both`);
            const claims = jwt.verify(jwtToken, jwtSecret, Object.assign({}, jwtVerifyOptions, { audience: jwtAudiences ||
                    (jwtVerifyOptions && 'audience' in jwtVerifyOptions
                        ? undefinedIfEmpty(jwtVerifyOptions.audience)
                        : ['postgraphile']) }));
            if (typeof claims === 'string') {
                throw new Error('Invalid JWT payload');
            }
            // jwt.verify returns `object | string`; but the `object` part is really a map
            jwtClaims = claims;
            const roleClaim = getPath(jwtClaims, jwtRole);
            // If there is a `role` property in the claims, use that instead of our
            // default role.
            if (typeof roleClaim !== 'undefined') {
                if (typeof roleClaim !== 'string')
                    throw new Error(`JWT \`role\` claim must be a string. Instead found '${typeof jwtClaims['role']}'.`);
                role = roleClaim;
            }
        }
        catch (error) {
            // In case this error is thrown in an HTTP context, we want to add status code
            // Note. jwt.verify will add a name key to its errors. (https://github.com/auth0/node-jsonwebtoken#errors--codes)
            error.statusCode =
                'name' in error && error.name === 'TokenExpiredError'
                    ? // The correct status code for an expired ( but otherwise acceptable token is 401 )
                        401
                    : // All other authentication errors should get a 403 status code.
                        403;
            throw error;
        }
    }
    // Instantiate a map of local settings. This map will be transformed into a
    // Sql query.
    const localSettings = [];
    // Set the custom provided settings before jwt claims and role are set
    // this prevents an accidentional overwriting
    if (pgSettings && typeof pgSettings === 'object') {
        for (const key in pgSettings) {
            if (pgSettings.hasOwnProperty(key) && isPgSettingValid(pgSettings[key])) {
                if (key === 'role') {
                    role = String(pgSettings[key]);
                }
                else {
                    localSettings.push([key, String(pgSettings[key])]);
                }
            }
        }
    }
    // If there is a rule, we want to set the root `role` setting locally
    // to be our role. The role may only be null if we have no default role.
    if (typeof role === 'string') {
        localSettings.push(['role', role]);
    }
    // If we have some JWT claims, we want to set those claims as local
    // settings with the namespace `jwt.claims`.
    for (const key in jwtClaims) {
        if (jwtClaims.hasOwnProperty(key)) {
            const rawValue = jwtClaims[key];
            // Unsafe to pass raw object/array to pg.query -> set_config; instead JSONify
            const value = rawValue != null && typeof rawValue === 'object' ? JSON.stringify(rawValue) : rawValue;
            if (isPgSettingValid(value)) {
                localSettings.push([`jwt.claims.${key}`, String(value)]);
            }
        }
    }
    return {
        localSettings,
        role,
        jwtClaims: jwtToken ? jwtClaims : null,
    };
}
const $$pgClientOrigQuery = Symbol();
/**
 * Adds debug logging funcionality to a Postgres client.
 *
 * @private
 */
// tslint:disable no-any
function debugPgClient(pgClient) {
    // If Postgres debugging is enabled, enhance our query function by adding
    // a debug statement.
    if (!pgClient[$$pgClientOrigQuery]) {
        // Set the original query method to a key on our client. If that key is
        // already set, use that.
        pgClient[$$pgClientOrigQuery] = pgClient.query;
        if (debugPgNotice.enabled) {
            pgClient.on('notice', (msg) => {
                debugPgErrorObject(debugPgNotice, msg);
            });
        }
        const logError = (error) => {
            if (error.name && error['severity']) {
                debugPgErrorObject(debugPgError, error);
            }
            else {
                debugPgError('%O', error);
            }
        };
        if (debugPg.enabled || debugPgError.enabled) {
            // tslint:disable-next-line only-arrow-functions
            pgClient.query = function (...args) {
                const [a, b, c] = args;
                // If we understand it (and it uses the promises API), log it out
                if ((typeof a === 'string' && !c && (!b || Array.isArray(b))) ||
                    (typeof a === 'object' && !b && !c)) {
                    // Debug just the query text. We don’t want to debug variables because
                    // there may be passwords in there.
                    debugPg('%s', postgraphile_core_1.formatSQLForDebugging(a && a.text ? a.text : a));
                    const promiseResult = pgClient[$$pgClientOrigQuery].apply(this, args);
                    // Report the error with our Postgres debugger.
                    promiseResult.catch(logError);
                    return promiseResult;
                }
                else {
                    // We don't understand it (e.g. `pgPool.query`), just let it happen.
                    return pgClient[$$pgClientOrigQuery].apply(this, args);
                }
            };
        }
    }
    return pgClient;
}
exports.debugPgClient = debugPgClient;
/**
 * Safely gets the value at `path` (array of keys) of `inObject`.
 *
 * @private
 */
function getPath(inObject, path) {
    let object = inObject;
    // From https://github.com/lodash/lodash/blob/master/.internal/baseGet.js
    let index = 0;
    const length = path.length;
    while (object && index < length) {
        object = object[path[index++]];
    }
    return index && index === length ? object : undefined;
}
/**
 * Check if a pgSetting is a string or a number.
 * Null and Undefined settings are not valid and will be ignored.
 * pgSettings of other types throw an error.
 *
 * @private
 */
function isPgSettingValid(pgSetting) {
    if (pgSetting === undefined || pgSetting === null) {
        return false;
    }
    const typeOfPgSetting = typeof pgSetting;
    if (typeOfPgSetting === 'string' ||
        typeOfPgSetting === 'number' ||
        typeOfPgSetting === 'boolean') {
        return true;
    }
    // TODO: booleans!
    throw new Error(`Error converting pgSetting: ${typeof pgSetting} needs to be of type string, number or boolean.`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2l0aFBvc3RHcmFwaGlsZUNvbnRleHQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvcG9zdGdyYXBoaWxlL3dpdGhQb3N0R3JhcGhpbGVDb250ZXh0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBQUEsd0NBQXlDO0FBQ3pDLG9DQUFxQztBQUVyQyxxQ0FBeUU7QUFDekUsK0JBQStCO0FBQy9CLG1GQUF1RTtBQUN2RSw2Q0FBcUQ7QUFFckQseURBQTBEO0FBRTFELE1BQU0sZ0JBQWdCLEdBQUcsQ0FDdkIsQ0FBNEMsRUFDVSxFQUFFLENBQ3hELENBQUMsSUFBSSxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO0FBWXZELE1BQU0sT0FBTyxHQUFHLGNBQWMsQ0FBQyx1QkFBdUIsQ0FBQyxDQUFDO0FBQ3hELE1BQU0sWUFBWSxHQUFHLGNBQWMsQ0FBQyw2QkFBNkIsQ0FBQyxDQUFDO0FBQ25FLE1BQU0sYUFBYSxHQUFHLGNBQWMsQ0FBQyw4QkFBOEIsQ0FBQyxDQUFDO0FBRXJFOztHQUVHO0FBQ0gsU0FBUyxrQkFBa0IsQ0FBQyxPQUFpQyxFQUFFLE1BQWdCO0lBQzdFLE9BQU8sQ0FDTCxjQUFjLEVBQ2QsTUFBTSxDQUFDLFFBQVEsSUFBSSxPQUFPLEVBQzFCLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLElBQUksTUFBTSxDQUFDLElBQUksR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQ3JDLE1BQU0sQ0FBQyxPQUFPLElBQUksTUFBTSxFQUN4QixNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxhQUFhLE1BQU0sQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUMvQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxZQUFZLE1BQU0s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