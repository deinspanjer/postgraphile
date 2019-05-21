"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/* tslint:disable:no-any */
const graphql_1 = require("graphql");
const extendedFormatError_1 = require("../extendedFormatError");
const koaMiddleware_1 = require("./koaMiddleware");
const pluginHook_1 = require("../pluginHook");
const setupServerSentEvents_1 = require("./setupServerSentEvents");
const withPostGraphileContext_1 = require("../withPostGraphileContext");
const lru_1 = require("@graphile/lru");
const chalk_1 = require("chalk");
const Debugger = require("debug"); // tslint:disable-line variable-name
const httpError = require("http-errors");
const parseUrl = require("parseurl");
const finalHandler = require("finalhandler");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const noop = () => {
    /* noop */
};
const { createHash } = crypto;
/**
 * The favicon file in `Buffer` format. We can send a `Buffer` directly to the
 * client.
 *
 * @type {Buffer}
 */
const favicon_ico_1 = require("../../assets/favicon.ico");
/**
 * The GraphiQL HTML file as a string. We need it to be a string, because we
 * will use a regular expression to replace some variables.
 */
const graphiql_html_1 = require("../../assets/graphiql.html");
const subscriptions_1 = require("./subscriptions");
/**
 * When writing JSON to the browser, we need to be careful that it doesn't get
 * interpretted as HTML.
 */
const JS_ESCAPE_LOOKUP = {
    '<': '\\u003c',
    '>': '\\u003e',
    '/': '\\u002f',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029',
};
function safeJSONStringify(obj) {
    return JSON.stringify(obj).replace(/[<>\/\u2028\u2029]/g, chr => JS_ESCAPE_LOOKUP[chr]);
}
/**
 * When people webpack us up, e.g. for lambda, if they don't want GraphiQL then
 * they can seriously reduce bundle size by omitting the assets.
 */
const shouldOmitAssets = process.env.POSTGRAPHILE_OMIT_ASSETS === '1';
// Used by `createPostGraphileHttpRequestHandler`
let lastString;
let lastHash;
const calculateQueryHash = (queryString) => {
    if (queryString !== lastString) {
        lastString = queryString;
        lastHash = createHash('sha1')
            .update(queryString)
            .digest('base64');
    }
    return lastHash;
};
// Fast way of checking if an object is empty,
// faster than `Object.keys(value).length === 0`.
// NOTE: we don't need a `hasOwnProperty` call here because isEmpty is called
// with an `Object.create(null)` object, so it has no no-own properties.
/* tslint:disable forin */
function isEmpty(value) {
    for (const _key in value) {
        return false;
    }
    return true;
}
exports.isEmpty = isEmpty;
/* tslint:enable forin */
const isPostGraphileDevelopmentMode = process.env.POSTGRAPHILE_ENV === 'development';
const debugGraphql = Debugger('postgraphile:graphql');
const debugRequest = Debugger('postgraphile:request');
/**
 * We need to be able to share the withPostGraphileContext logic between HTTP
 * and websockets
 */
function withPostGraphileContextFromReqResGenerator(options) {
    const { pgSettings, jwtSecret, additionalGraphQLContextFromRequest } = options;
    return async (req, res, moreOptions, fn) => {
        const jwtToken = jwtSecret ? getJwtToken(req) : null;
        const additionalContext = typeof additionalGraphQLContextFromRequest === 'function'
            ? await additionalGraphQLContextFromRequest(req, res)
            : null;
        return withPostGraphileContext_1.default(Object.assign({}, options, { jwtToken, pgSettings: typeof pgSettings === 'function' ? await pgSettings(req) : pgSettings }, moreOptions), context => {
            const graphqlContext = additionalContext
                ? Object.assign({}, additionalContext, context) : context;
            return fn(graphqlContext);
        });
    };
}
/**
 * Creates a GraphQL request handler that can support many different `http` frameworks, including:
 *
 * - Native Node.js `http`.
 * - `connect`.
 * - `express`.
 * - `koa` (2.0).
 */
function createPostGraphileHttpRequestHandler(options) {
    const MEGABYTE = 1024 * 1024;
    const { getGqlSchema, pgPool, pgSettings, pgDefaultRole, queryCacheMaxSize = 50 * MEGABYTE, extendedErrors, showErrorStack, watchPg, disableQueryLog, enableQueryBatching, } = options;
    const subscriptions = !!options.subscriptions;
    const live = !!options.live;
    const enhanceGraphiql = options.enhanceGraphiql === false ? false : !!options.enhanceGraphiql || subscriptions || live;
    const graphiqlAuthorizationEventOrigin = options.graphiqlAuthorizationEventOrigin;
    const enableCors = !!options.enableCors || isPostGraphileDevelopmentMode;
    const graphiql = options.graphiql === true;
    if (options['absoluteRoutes']) {
        throw new Error('Sorry - the `absoluteRoutes` setting has been replaced with `externalUrlBase` which solves the issue in a cleaner way. Please update your settings. Thank you for testing a PostGraphile pre-release 🙏');
    }
    // Using let because we might override it on the first request.
    let externalUrlBase = options.externalUrlBase;
    if (externalUrlBase && externalUrlBase.endsWith('/')) {
        throw new Error('externalUrlBase must not end with a slash (`/`)');
    }
    const pluginHook = pluginHook_1.pluginHookFromOptions(options);
    const origGraphiqlHtml = pluginHook('postgraphile:graphiql:html', graphiql_html_1.default, { options });
    if (pgDefaultRole && typeof pgSettings === 'function') {
        throw new Error('pgDefaultRole cannot be combined with pgSettings(req) - please remove pgDefaultRole and instead always return a `role` key from pgSettings(req).');
    }
    if (pgDefaultRole &&
        pgSettings &&
        typeof pgSettings === 'object' &&
        Object.keys(pgSettings)
            .map(s => s.toLowerCase())
            .indexOf('role') >= 0) {
        throw new Error('pgDefaultRole cannot be combined with pgSettings.role - please use one or the other.');
    }
    if (graphiql && shouldOmitAssets) {
        throw new Error('Cannot enable GraphiQL when POSTGRAPHILE_OMIT_ASSETS is set');
    }
    // Gets the route names for our GraphQL endpoint, and our GraphiQL endpoint.
    const graphqlRoute = options.graphqlRoute || '/graphql';
    const graphiqlRoute = graphiql ? options.graphiqlRoute || '/graphiql' : null;
    const streamRoute = `${graphqlRoute}/stream`;
    // Throw an error of the GraphQL and GraphiQL routes are the same.
    if (graphqlRoute === graphiqlRoute)
        throw new Error(`Cannot use the same route, '${graphqlRoute}', for both GraphQL and GraphiQL. Please use different routes.`);
    // Formats an error using the default GraphQL `formatError` function, and
    // custom formatting using some other options.
    const formatError = (error) => {
        // Get the appropriate formatted error object, including any extended error
        // fields if the user wants them.
        const formattedError = extendedErrors && extendedErrors.length
            ? extendedFormatError_1.extendedFormatError(error, extendedErrors)
            : graphql_1.formatError(error);
        // If the user wants to see the error’s stack, let’s add it to the
        // formatted error.
        if (showErrorStack)
            formattedError['stack'] =
                error.stack != null && showErrorStack === 'json' ? error.stack.split('\n') : error.stack;
        return formattedError;
    };
    const DEFAULT_HANDLE_ERRORS = (errors) => errors.map(formatError);
    const handleErrors = options.handleErrors || DEFAULT_HANDLE_ERRORS;
    function convertKoaBodyParserToConnect(req, _res, next) {
        if (req._koaCtx && req._koaCtx.request && req._koaCtx.request.body) {
            req._body = true;
            req.body = req._koaCtx.request.body;
        }
        next();
    }
    // Define a list of middlewares that will get run before our request handler.
    // Note though that none of these middlewares will intercept a request (i.e.
    // not call `next`). Middlewares that handle a request like favicon
    // middleware will result in a promise that never resolves, and we don’t
    // want that.
    const bodyParserMiddlewares = [
        // Convert koa body to connect-compatible body
        convertKoaBodyParserToConnect,
        // Parse JSON bodies.
        bodyParser.json({ limit: options.bodySizeLimit }),
        // Parse URL encoded bodies (forms).
        bodyParser.urlencoded({ extended: false, limit: options.bodySizeLimit }),
        // Parse `application/graphql` content type bodies as text.
        bodyParser.text({ type: 'application/graphql', limit: options.bodySizeLimit }),
    ];
    // We'll turn this into one function now so it can be better JIT optimised
    const bodyParserMiddlewaresComposed = bodyParserMiddlewares.reduce((parent, fn) => {
        return (req, res, next) => {
            parent(req, res, error => {
                if (error) {
                    return next(error);
                }
                fn(req, res, next);
            });
        };
    }, (_req, _res, next) => next());
    // And we really want that function to be await-able
    const parseBody = (req, res) => new Promise((resolve, reject) => {
        bodyParserMiddlewaresComposed(req, res, (error) => {
            if (error) {
                reject(error);
            }
            else {
                resolve();
            }
        });
    });
    // We only need to calculate the graphiql HTML once; but we need to receive the first request to do so.
    let graphiqlHtml;
    const withPostGraphileContextFromReqRes = withPostGraphileContextFromReqResGenerator(options);
    const staticValidationRules = pluginHook('postgraphile:validationRules:static', graphql_1.specifiedRules, {
        options,
    });
    const queryCache = new lru_1.default({
        maxLength: Math.ceil(queryCacheMaxSize / 100000),
    });
    let lastGqlSchema;
    const parseQuery = (gqlSchema, queryString) => {
        if (gqlSchema !== lastGqlSchema) {
            queryCache.reset();
            lastGqlSchema = gqlSchema;
        }
        // Only cache queries that are less than 100kB, we don't want DOS attacks
        // attempting to exhaust our memory.
        const canCache = queryCacheMaxSize > 0 && queryString.length < 100000;
        const hash = canCache ? calculateQueryHash(queryString) : null;
        const result = canCache ? queryCache.get(hash) : null;
        if (result) {
            return result;
        }
        else {
            const source = new graphql_1.Source(queryString, 'GraphQL Http Request');
            let queryDocumentAst;
            // Catch an errors while parsing so that we can set the `statusCode` to
            // 400. Otherwise we don’t need to parse this way.
            try {
                queryDocumentAst = graphql_1.parse(source);
            }
            catch (error) {
                error.statusCode = 400;
                throw error;
            }
            if (debugRequest.enabled)
                debugRequest('GraphQL query is parsed.');
            // Validate our GraphQL query using given rules.
            const validationErrors = graphql_1.validate(gqlSchema, queryDocumentAst, staticValidationRules);
            const cacheResult = {
                queryDocumentAst,
                validationErrors,
                length: queryString.length,
            };
            if (canCache) {
                queryCache.set(hash, cacheResult);
            }
            return cacheResult;
        }
    };
    let firstRequestHandler = (req, pathname) => {
        // Never be called again
        firstRequestHandler = null;
        if (externalUrlBase == null) {
            // User hasn't specified externalUrlBase; let's try and guess it
            const { pathname: originalPathname = '' } = parseUrl.original(req) || {};
            if (originalPathname !== pathname && originalPathname.endsWith(pathname)) {
                // We were mounted on a subpath (e.g. `app.use('/path/to', postgraphile(...))`).
                // Figure out our externalUrlBase for ourselves.
                externalUrlBase = originalPathname.substr(0, originalPathname.length - pathname.length);
            }
            // Make sure we have a string, at least
            externalUrlBase = externalUrlBase || '';
        }
        // Takes the original GraphiQL HTML file and replaces the default config object.
        graphiqlHtml = origGraphiqlHtml
            ? origGraphiqlHtml.replace(/<\/head>/, `  <script>window.POSTGRAPHILE_CONFIG=${safeJSONStringify({
                graphqlUrl: `${externalUrlBase}${graphqlRoute}`,
                streamUrl: watchPg ? `${externalUrlBase}${graphqlRoute}/stream` : null,
                enhanceGraphiql,
                graphiqlAuthorizationEventOrigin,
                subscriptions,
            })};</script>\n  </head>`)
            : null;
        if (subscriptions) {
            const server = req && req.connection && req.connection['server'];
            if (!server) {
                // tslint:disable-next-line no-console
                console.warn("Failed to find server to add websocket listener to, you'll need to call `enhanceHttpServerWithSubscriptions` manually");
            }
            else {
                // Relying on this means that a normal request must come in before an
                // upgrade attempt. It's better to call it manually.
                subscriptions_1.enhanceHttpServerWithSubscriptions(server, middleware);
            }
        }
    };
    /*
     * If we're not in watch mode, then avoid the cost of `await`ing the schema
     * on every tick by having it available once it was generated.
     */
    let theOneAndOnlyGraphQLSchema = null;
    if (!watchPg) {
        getGqlSchema()
            .then(schema => {
            theOneAndOnlyGraphQLSchema = schema;
        })
            .catch(noop);
    }
    /**
     * The actual request handler. It’s an async function so it will return a
     * promise when complete. If the function doesn’t handle anything, it calls
     * `next` to let the next middleware try and handle it.
     */
    const requestHandler = async (incomingReq, res, next) => {
        // You can use this hook either to modify the incoming request or to tell
        // PostGraphile not to handle the request further (return null). NOTE: if
        // you return `null` from this hook then you are also responsible for
        // calling `next()` (should that be required).
        const req = pluginHook('postgraphile:http:handler', incomingReq, {
            options,
            res,
            next,
        });
        if (req == null) {
            return;
        }
        // Add our CORS headers to be good web citizens (there are perf
        // implications though so be careful!)
        //
        // Always enable CORS when developing PostGraphile because GraphiQL will be
        // on port 5783.
        if (enableCors)
            addCORSHeaders(res);
        const { pathname = '' } = parseUrl(req) || {};
        // Certain things depend on externalUrlBase, which we guess if the user
        // doesn't supply it, so we calculate them on the first request. After
        // first request, this function becomes a NOOP
        if (firstRequestHandler)
            firstRequestHandler(req, pathname);
        const isGraphqlRoute = pathname === graphqlRoute;
        // ========================================================================
        // Serve GraphiQL and Related Assets
        // ========================================================================
        if (!shouldOmitAssets && graphiql && !isGraphqlRoute) {
            // ======================================================================
            // Favicon
            // ======================================================================
            // If this is the favicon path and it has not yet been handled, let us
            // serve our GraphQL favicon.
            if (pathname === '/favicon.ico') {
                // If this is the wrong method, we should let the client know.
                if (!(req.method === 'GET' || req.method === 'HEAD')) {
                    res.statusCode = req.method === 'OPTIONS' ? 200 : 405;
                    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
                    res.end();
                    return;
                }
                // Otherwise we are good and should pipe the favicon to the browser.
                res.statusCode = 200;
                res.setHeader('Cache-Control', 'public, max-age=86400');
                res.setHeader('Content-Type', 'image/x-icon');
                // End early if the method is `HEAD`.
                if (req.method === 'HEAD') {
                    res.end();
                    return;
                }
                res.end(favicon_ico_1.default);
                return;
            }
            // ======================================================================
            // GraphiQL Watch Stream
            // ======================================================================
            // Setup an event stream so we can broadcast events to graphiql, etc.
            if (pathname === streamRoute || pathname === '/_postgraphile/stream') {
                if (!watchPg || req.headers.accept !== 'text/event-stream') {
                    res.statusCode = 405;
                    res.end();
                    return;
                }
                setupServerSentEvents_1.default(req, res, options);
                return;
            }
            // ======================================================================
            // GraphiQL HTML
            // ======================================================================
            // If this is the GraphiQL route, show GraphiQL and stop execution.
            if (pathname === graphiqlRoute) {
                // If we are developing PostGraphile, instead just redirect.
                if (isPostGraphileDevelopmentMode) {
                    res.statusCode = 302;
                    res.setHeader('Location', 'http://localhost:5783');
                    res.end();
                    return;
                }
                // If using the incorrect method, let the user know.
                if (!(req.method === 'GET' || req.method === 'HEAD')) {
                    res.statusCode = req.method === 'OPTIONS' ? 200 : 405;
                    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
                    res.end();
                    return;
                }
                res.statusCode = 200;
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                if (graphiqlAuthorizationEventOrigin) {
                    res.setHeader('X-Frame-Options', `allow-from ${graphiqlAuthorizationEventOrigin}`);
                    res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${graphiqlAuthorizationEventOrigin}`);
                }
                else {
                    console.log('did not set up ', options);
                    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
                    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
                }
                // End early if the method is `HEAD`.
                if (req.method === 'HEAD') {
                    res.end();
                    return;
                }
                // Actually renders GraphiQL.
                res.end(graphiqlHtml);
                return;
            }
        }
        // Don’t handle any requests if this is not the correct route.
        if (!isGraphqlRoute)
            return next();
        // ========================================================================
        // Execute GraphQL Queries
        // ========================================================================
        // If we didn’t call `next` above, all requests will return 200 by default!
        res.statusCode = 200;
        if (watchPg) {
            // Inform GraphiQL and other clients that they can subscribe to events
            // (such as the schema being updated) at the following URL
            res.setHeader('X-GraphQL-Event-Stream', `${externalUrlBase}${graphqlRoute}/stream`);
        }
        // Don’t execute our GraphQL stuffs for `OPTIONS` requests.
        if (req.method === 'OPTIONS') {
            res.statusCode = 200;
            res.end();
            return;
        }
        // The `result` will be used at the very end in our `finally` block.
        // Statements inside the `try` will assign to `result` when they get
        // a result. We also keep track of `params`.
        let paramsList;
        let results = [];
        const queryTimeStart = !disableQueryLog && process.hrtime();
        let pgRole;
        if (debugRequest.enabled)
            debugRequest('GraphQL query request has begun.');
        let returnArray = false;
        // This big `try`/`catch`/`finally` block represents the execution of our
        // GraphQL query. All errors thrown in this block will be returned to the
        // client as GraphQL errors.
        try {
            // First thing we need to do is get the GraphQL schema for this request.
            // It should never really change unless we are in watch mode.
            const gqlSchema = theOneAndOnlyGraphQLSchema || (await getGqlSchema());
            // Note that we run our middleware after we make sure we are on the
            // correct route. This is so that if our middleware modifies the `req` or
            // `res` objects, only we downstream will see the modifications.
            //
            // We also run our middleware inside the `try` so that we get the GraphQL
            // error reporting style for syntax errors.
            await parseBody(req, res);
            // If this is not one of the correct methods, throw an error.
            if (req.method !== 'POST') {
                res.setHeader('Allow', 'POST, OPTIONS');
                throw httpError(405, 'Only `POST` requests are allowed.');
            }
            // Get the parameters we will use to run a GraphQL request. `params` may
            // include:
            //
            // - `query`: The required GraphQL query string.
            // - `variables`: An optional JSON object containing GraphQL variables.
            // - `operationName`: The optional name of the GraphQL operation we will
            //   be executing.
            const body = req.body;
            paramsList = typeof body === 'string' ? { query: body } : body;
            // Validate our paramsList object a bit.
            if (paramsList == null)
                throw httpError(400, 'Must provide an object parameters, not nullish value.');
            if (typeof paramsList !== 'object')
                throw httpError(400, `Expected parameter object, not value of type '${typeof paramsList}'.`);
            if (Array.isArray(paramsList)) {
                if (!enableQueryBatching) {
                    throw httpError(501, 'Batching queries as an array is currently unsupported. Please provide a single query object.');
                }
                else {
                    returnArray = true;
                }
            }
            else {
                paramsList = [paramsList];
            }
            paramsList = pluginHook('postgraphile:httpParamsList', paramsList, {
                options,
                req,
                res,
                returnArray,
                httpError,
            });
            results = await Promise.all(paramsList.map(async (params) => {
                let queryDocumentAst = null;
                let result;
                const meta = Object.create(null);
                try {
                    if (!params)
                        throw httpError(400, 'Invalid query structure.');
                    const { query, operationName } = params;
                    let { variables } = params;
                    if (!query)
                        throw httpError(400, 'Must provide a query string.');
                    // If variables is a string, we assume it is a JSON string and that it
                    // needs to be parsed.
                    if (typeof variables === 'string') {
                        // If variables is just an empty string, we should set it to null and
                        // ignore it.
                        if (variables === '') {
                            variables = null;
                        }
                        else {
                            // Otherwise, let us try to parse it as JSON.
                            try {
                                variables = JSON.parse(variables);
                            }
                            catch (error) {
                                error.statusCode = 400;
                                throw error;
                            }
                        }
                    }
                    // Throw an error if `variables` is not an object.
                    if (variables != null && typeof variables !== 'object')
                        throw httpError(400, `Variables must be an object, not '${typeof variables}'.`);
                    // Throw an error if `operationName` is not a string.
                    if (operationName != null && typeof operationName !== 'string')
                        throw httpError(400, `Operation name must be a string, not '${typeof operationName}'.`);
                    let validationErrors;
                    ({ queryDocumentAst, validationErrors } = parseQuery(gqlSchema, query));
                    if (validationErrors.length === 0) {
                        // You are strongly encouraged to use
                        // `postgraphile:validationRules:static` if possible - you should
                        // only use this one if you need access to variables.
                        const moreValidationRules = pluginHook('postgraphile:validationRules', [], {
                            options,
                            req,
                            res,
                            variables,
                            operationName,
                            meta,
                        });
                        if (moreValidationRules.length) {
                            validationErrors = graphql_1.validate(gqlSchema, queryDocumentAst, moreValidationRules);
                        }
                    }
                    // If we have some validation errors, don’t execute the query. Instead
                    // send the errors to the client with a `400` code.
                    if (validationErrors.length > 0) {
                        result = { errors: validationErrors, statusCode: 400 };
                    }
                    else if (!queryDocumentAst) {
                        throw new Error('Could not process query');
                    }
                    else {
                        if (debugRequest.enabled)
                            debugRequest('GraphQL query is validated.');
                        // Lazily log the query. If this debugger isn’t enabled, don’t run it.
                        if (debugGraphql.enabled)
                            debugGraphql('%s', graphql_1.print(queryDocumentAst)
                                .replace(/\s+/g, ' ')
                                .trim());
                        result = await withPostGraphileContextFromReqRes(req, res, {
                            singleStatement: false,
                            queryDocumentAst,
                            variables,
                            operationName,
                        }, (graphqlContext) => {
                            pgRole = graphqlContext.pgRole;
                            return graphql_1.execute(gqlSchema, queryDocumentAst, null, graphqlContext, variables, operationName);
                        });
                    }
                }
                catch (error) {
                    result = {
                        errors: [error],
                        statusCode: error.status || error.statusCode || 500,
                    };
                    // If the status code is 500, let’s log our error.
                    if (result.statusCode === 500)
                        // tslint:disable-next-line no-console
                        console.error(error.stack);
                }
                finally {
                    // Format our errors so the client doesn’t get the full thing.
                    if (result && result.errors) {
                        result.errors = handleErrors(result.errors, req, res);
                    }
                    if (!isEmpty(meta)) {
                        result.meta = meta;
                    }
                    result = pluginHook('postgraphile:http:result', result, {
                        options,
                        returnArray,
                        queryDocumentAst,
                        req,
                        pgRole,
                    });
                    // Log the query. If this debugger isn’t enabled, don’t run it.
                    if (!disableQueryLog && queryDocumentAst) {
                        // To appease TypeScript
                        const definitelyQueryDocumentAst = queryDocumentAst;
                        // We must reference this before it's deleted!
                        const resultStatusCode = result.statusCode;
                        const timeDiff = queryTimeStart && process.hrtime(queryTimeStart);
                        setImmediate(() => {
                            const prettyQuery = graphql_1.print(definitelyQueryDocumentAst)
                                .replace(/\s+/g, ' ')
                                .trim();
                            const errorCount = (result.errors || []).length;
                            const ms = timeDiff[0] * 1e3 + timeDiff[1] * 1e-6;
                            let message;
                            if (resultStatusCode === 401) {
                                // Users requested that JWT errors were raised differently:
                                //
                                //   https://github.com/graphile/postgraphile/issues/560
                                message = chalk_1.default.red(`401 authentication error`);
                            }
                            else if (resultStatusCode === 403) {
                                message = chalk_1.default.red(`403 forbidden error`);
                            }
                            else {
                                message = chalk_1.default[errorCount === 0 ? 'green' : 'red'](`${errorCount} error(s)`);
                            }
                            // tslint:disable-next-line no-console
                            console.log(`${message} ${pgRole != null ? `as ${chalk_1.default.magenta(pgRole)} ` : ''}in ${chalk_1.default.grey(`${ms.toFixed(2)}ms`)} :: ${prettyQuery}`);
                        });
                    }
                    if (debugRequest.enabled)
                        debugRequest('GraphQL query has been executed.');
                }
                return result;
            }));
        }
        catch (error) {
            // Set our status code and send the client our results!
            if (res.statusCode === 200)
                res.statusCode = error.status || error.statusCode || 500;
            // Overwrite entire response
            returnArray = false;
            results = [{ errors: [error] }];
            // If the status code is 500, let’s log our error.
            if (res.statusCode === 500)
                // tslint:disable-next-line no-console
                console.error(error.stack);
        }
        finally {
            // Finally, we send the client the results.
            if (!returnArray) {
                if (res.statusCode === 200 && results[0].statusCode) {
                    res.statusCode = results[0].statusCode;
                }
                results[0].statusCode = undefined;
            }
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            const { statusCode, result } = pluginHook('postgraphile:http:end', {
                statusCode: res.statusCode,
                result: returnArray ? results : results[0],
            }, {
                options,
                returnArray,
                req,
                res,
            });
            if (statusCode) {
                res.statusCode = statusCode;
            }
            res.end(JSON.stringify(result));
            if (debugRequest.enabled)
                debugRequest('GraphQL ' + (returnArray ? 'queries' : 'query') + ' request finished.');
        }
    };
    /**
     * A polymorphic request handler that should detect what `http` framework is
     * being used and specifically handle that framework.
     *
     * Supported frameworks include:
     *
     * - Native Node.js `http`.
     * - `connect`.
     * - `express`.
     * - `koa` (2.0).
     */
    const middleware = (a, b, c) => {
        // If are arguments look like the arguments to koa middleware, this is
        // `koa` middleware.
        if (koaMiddleware_1.isKoaApp(a, b)) {
            // Set the correct `koa` variable names…
            const ctx = a;
            const next = b;
            return koaMiddleware_1.middleware(ctx, next, requestHandler);
        }
        else {
            // Set the correct `connect` style variable names. If there was no `next`
            // defined (likely the case if the client is using `http`) we use the
            // final handler.
            const req = a;
            const res = b;
            const next = c || finalHandler(req, res);
            // Execute our request handler. If the request errored out, call `next` with the error.
            requestHandler(req, res, next).catch(next);
        }
    };
    middleware.getGraphQLSchema = getGqlSchema;
    middleware.formatError = formatError;
    middleware.pgPool = pgPool;
    middleware.withPostGraphileContextFromReqRes = withPostGraphileContextFromReqRes;
    middleware.handleErrors = handleErrors;
    middleware.options = options;
    const hookedMiddleware = pluginHook('postgraphile:middleware', middleware, {
        options,
    });
    // Sanity check:
    if (!hookedMiddleware.getGraphQLSchema) {
        throw new Error("Hook for 'postgraphile:middleware' has not copied over the helpers; e.g. missing `Object.assign(newMiddleware, oldMiddleware)`");
    }
    return hookedMiddleware;
}
exports.default = createPostGraphileHttpRequestHandler;
/**
 * Adds CORS to a request. See [this][1] flowchart for an explanation of how
 * CORS works. Note that these headers are set for all requests, CORS
 * algorithms normally run a preflight request using the `OPTIONS` method to
 * get these headers.
 *
 * Note though, that enabling CORS will incur extra costs when it comes to the
 * preflight requests. It is much better if you choose to use a proxy and
 * bypass CORS altogether.
 *
 * [1]: http://www.html5rocks.com/static/images/cors_server_flowchart.png
 */
function addCORSHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'HEAD, GET, POST');
    res.setHeader('Access-Control-Allow-Headers', [
        'Origin',
        'X-Requested-With',
        // Used by `express-graphql` to determine whether to expose the GraphiQL
        // interface (`text/html`) or not.
        'Accept',
        // Used by PostGraphile for auth purposes.
        'Authorization',
        // Used by GraphQL Playground and other Apollo-enabled servers
        'X-Apollo-Tracing',
        // The `Content-*` headers are used when making requests with a body,
        // like in a POST request.
        'Content-Type',
        'Content-Length',
    ].join(', '));
    res.setHeader('Access-Control-Expose-Headers', ['X-GraphQL-Event-Stream'].join(', '));
}
function createBadAuthorizationHeaderError() {
    return httpError(400, 'Authorization header is not of the correct bearer scheme format.');
}
/**
 * Parses the `Bearer` auth scheme token out of the `Authorization` header as
 * defined by [RFC7235][1].
 *
 * ```
 * Authorization = credentials
 * credentials   = auth-scheme [ 1*SP ( token68 / #auth-param ) ]
 * token68       = 1*( ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/" )*"="
 * ```
 *
 * [1]: https://tools.ietf.org/html/rfc7235
 *
 * @private
 */
const authorizationBearerRex = /^\s*bearer\s+([a-z0-9\-._~+/]+=*)\s*$/i;
/**
 * Gets the JWT token from the Http request’s headers. Specifically the
 * `Authorization` header in the `Bearer` format. Will throw an error if the
 * header is in the incorrect format, but will not throw an error if the header
 * does not exist.
 *
 * @private
 * @param {IncomingMessage} request
 * @returns {string | null}
 */
function getJwtToken(request) {
    const { authorization } = request.headers;
    if (Array.isArray(authorization))
        throw createBadAuthorizationHeaderError();
    // If there was no authorization header, just return null.
    if (authorization == null)
        return null;
    const match = authorizationBearerRex.exec(authorization);
    // If we did not match the authorization header with our expected format,
    // throw a 400 error.
    if (!match)
        throw createBadAuthorizationHeaderError();
    // Return the token from our match.
    return match[1];
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY3JlYXRlUG9zdEdyYXBoaWxlSHR0cFJlcXVlc3RIYW5kbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vc3JjL3Bvc3RncmFwaGlsZS9odHRwL2NyZWF0ZVBvc3RHcmFwaGlsZUh0dHBSZXF1ZXN0SGFuZGxlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLDJCQUEyQjtBQUMzQixxQ0FXaUI7QUFDakIsZ0VBQTZEO0FBRTdELG1EQUF3RTtBQUN4RSw4Q0FBc0Q7QUFFdEQsbUVBQTREO0FBQzVELHdFQUFpRTtBQUVqRSx1Q0FBZ0M7QUFFaEMsaUNBQTBCO0FBQzFCLGtDQUFtQyxDQUFDLG9DQUFvQztBQUN4RSx5Q0FBMEM7QUFDMUMscUNBQXNDO0FBQ3RDLDZDQUE4QztBQUM5QywwQ0FBMkM7QUFDM0MsaUNBQWtDO0FBRWxDLE1BQU0sSUFBSSxHQUFHLEdBQUcsRUFBRTtJQUNoQixVQUFVO0FBQ1osQ0FBQyxDQUFDO0FBRUYsTUFBTSxFQUFFLFVBQVUsRUFBRSxHQUFHLE1BQU0sQ0FBQztBQUU5Qjs7Ozs7R0FLRztBQUNILDBEQUErQztBQUUvQzs7O0dBR0c7QUFDSCw4REFBMEQ7QUFDMUQsbURBQXFFO0FBRXJFOzs7R0FHRztBQUNILE1BQU0sZ0JBQWdCLEdBQUc7SUFDdkIsR0FBRyxFQUFFLFNBQVM7SUFDZCxHQUFHLEVBQUUsU0FBUztJQUNkLEdBQUcsRUFBRSxTQUFTO0lBQ2QsUUFBUSxFQUFFLFNBQVM7SUFDbkIsUUFBUSxFQUFFLFNBQVM7Q0FDcEIsQ0FBQztBQUNGLFNBQVMsaUJBQWlCLENBQUMsR0FBTztJQUNoQyxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsT0FBTyxDQUFDLHFCQUFxQixFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUMsZ0JBQWdCLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUMxRixDQUFDO0FBRUQ7OztHQUdHO0FBQ0gsTUFBTSxnQkFBZ0IsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLHdCQUF3QixLQUFLLEdBQUcsQ0FBQztBQUV0RSxpREFBaUQ7QUFDakQsSUFBSSxVQUFrQixDQUFDO0FBQ3ZCLElBQUksUUFBZ0IsQ0FBQztBQUNyQixNQUFNLGtCQUFrQixHQUFHLENBQUMsV0FBbUIsRUFBVSxFQUFFO0lBQ3pELElBQUksV0FBVyxLQUFLLFVBQVUsRUFBRTtRQUM5QixVQUFVLEdBQUcsV0FBVyxDQUFDO1FBQ3pCLFFBQVEsR0FBRyxVQUFVLENBQUMsTUFBTSxDQUFDO2FBQzFCLE1BQU0sQ0FBQyxXQUFXLENBQUM7YUFDbkIsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0tBQ3JCO0lBQ0QsT0FBTyxRQUFRLENBQUM7QUFDbEIsQ0FBQyxDQUFDO0FBRUYsOENBQThDO0FBQzlDLGlEQUFpRDtBQUNqRCw2RUFBNkU7QUFDN0Usd0VBQXdFO0FBQ3hFLDBCQUEwQjtBQUMxQixTQUFnQixPQUFPLENBQUMsS0FBVTtJQUNoQyxLQUFLLE1BQU0sSUFBSSxJQUFJLEtBQUssRUFBRTtRQUN4QixPQUFPLEtBQUssQ0FBQztLQUNkO0lBQ0QsT0FBTyxJQUFJLENBQUM7QUFDZCxDQUFDO0FBTEQsMEJBS0M7QUFDRCx5QkFBeUI7QUFFekIsTUFBTSw2QkFBNkIsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGdCQUFnQixLQUFLLGFBQWEsQ0FBQztBQUVyRixNQUFNLFlBQVksR0FBRyxRQUFRLENBQUMsc0JBQXNCLENBQUMsQ0FBQztBQUN0RCxNQUFNLFlBQVksR0FBRyxRQUFRLENBQUMsc0JBQXNCLENBQUMsQ0FBQztBQUV0RDs7O0dBR0c7QUFDSCxTQUFTLDBDQUEwQyxDQUNqRCxPQUFvQztJQU9wQyxNQUFNLEVBQUUsVUFBVSxFQUFFLFNBQVMsRUFBRSxtQ0FBbUMsRUFBRSxHQUFHLE9BQU8sQ0FBQztJQUMvRSxPQUFPLEtBQUssRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLFdBQVcsRUFBRSxFQUFFLEVBQUUsRUFBRTtRQUN6QyxNQUFNLFFBQVEsR0FBRyxTQUFTLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO1FBQ3JELE1BQU0saUJBQWlCLEdBQ3JCLE9BQU8sbUNBQW1DLEtBQUssVUFBVTtZQUN2RCxDQUFDLENBQUMsTUFBTSxtQ0FBbUMsQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDO1lBQ3JELENBQUMsQ0FBQyxJQUFJLENBQUM7UUFDWCxPQUFPLGlDQUF1QixtQkFFdkIsT0FBTyxJQUNWLFFBQVEsRUFDUixVQUFVLEVBQUUsT0FBTyxVQUFVLEtBQUssVUFBVSxDQUFDLENBQUMsQ0FBQyxNQUFNLFVBQVUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxJQUM5RSxXQUFXLEdBRWhCLE9BQU8sQ0FBQyxFQUFFO1lBQ1IsTUFBTSxjQUFjLEdBQUcsaUJBQWlCO2dCQUN0QyxDQUFDLG1CQUFNLGlCQUFpQixFQUFNLE9BQWtCLEVBQ2hELENBQUMsQ0FBQyxPQUFPLENBQUM7WUFDWixPQUFPLEVBQUUsQ0FBQyxjQUFjLENBQUMsQ0FBQztRQUM1QixDQUFDLENBQ0YsQ0FBQztJQUNKLENBQUMsQ0FBQztBQUNKLENBQUM7QUFFRDs7Ozs7OztHQU9HO0FBQ0gsU0FBd0Isb0NBQW9DLENBQzFELE9BQW9DO0lBRXBDLE1BQU0sUUFBUSxHQUFHLElBQUksR0FBRyxJQUFJLENBQUM7SUFDN0IsTUFBTSxFQUNKLFlBQVksRUFDWixNQUFNLEVBQ04sVUFBVSxFQUNWLGFBQWEsRUFDYixpQkFBaUIsR0FBRyxFQUFFLEdBQUcsUUFBUSxFQUNqQyxjQUFjLEVBQ2QsY0FBYyxFQUNkLE9BQU8sRUFDUCxlQUFlLEVBQ2YsbUJBQW1CLEdBQ3BCLEdBQUcsT0FBTyxDQUFDO0lBQ1osTUFBTSxhQUFhLEdBQUcsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxhQUFhLENBQUM7SUFDOUMsTUFBTSxJQUFJLEdBQUcsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUM7SUFDNUIsTUFBTSxlQUFlLEdBQ25CLE9BQU8sQ0FBQyxlQUFlLEtBQUssS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsZUFBZSxJQUFJLGFBQWEsSUFBSSxJQUFJLENBQUM7SUFDakcsTUFBTSxnQ0FBZ0MsR0FBRyxPQUFPLENBQUMsZ0NBQWdDLENBQUM7SUFDbEYsTUFBTSxVQUFVLEdBQUcsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxVQUFVLElBQUksNkJBQTZCLENBQUM7SUFDekUsTUFBTSxRQUFRLEdBQUcsT0FBTyxDQUFDLFFBQVEsS0FBSyxJQUFJLENBQUM7SUFDM0MsSUFBSSxPQUFPLENBQUMsZ0JBQWdCLENBQUMsRUFBRTtRQUM3QixNQUFNLElBQUksS0FBSyxDQUNiLHlNQUF5TSxDQUMxTSxDQUFDO0tBQ0g7SUFFRCwrREFBK0Q7SUFDL0QsSUFBSSxlQUFlLEdBQUcsT0FBTyxDQUFDLGVBQWUsQ0FBQztJQUM5QyxJQUFJLGVBQWUsSUFBSSxlQUFlLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxFQUFFO1FBQ3BELE1BQU0sSUFBSSxLQUFLLENBQUMsaURBQWlELENBQUMsQ0FBQztLQUNwRTtJQUVELE1BQU0sVUFBVSxHQUFHLGtDQUFxQixDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBRWxELE1BQU0sZ0JBQWdCLEdBQUcsVUFBVSxDQUFDLDRCQUE0QixFQUFFLHVCQUFnQixFQUFFLEVBQUUsT0FBTyxFQUFFLENBQUMsQ0FBQztJQUVqRyxJQUFJLGFBQWEsSUFBSSxPQUFPLFVBQVUsS0FBSyxVQUFVLEVBQUU7UUFDckQsTUFBTSxJQUFJLEtBQUssQ0FDYixrSkFBa0osQ0FDbkosQ0FBQztLQUNIO0lBQ0QsSUFDRSxhQUFhO1FBQ2IsVUFBVTtRQUNWLE9BQU8sVUFBVSxLQUFLLFFBQVE7UUFDOUIsTUFBTSxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUM7YUFDcEIsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLFdBQVcsRUFBRSxDQUFDO2FBQ3pCLE9BQU8sQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLEVBQ3ZCO1FBQ0EsTUFBTSxJQUFJLEtBQUssQ0FDYixzRkFBc0YsQ0FDdkYsQ0FBQztLQUNIO0lBQ0QsSUFBSSxRQUFRLElBQUksZ0JBQWdCLEVBQUU7UUFDaEMsTUFBTSxJQUFJLEtBQUssQ0FBQyw2REFBNkQsQ0FBQyxDQUFDO0tBQ2hGO0lBRUQsNEVBQTRFO0lBQzVFLE1BQU0sWUFBWSxHQUFHLE9BQU8sQ0FBQyxZQUFZLElBQUksVUFBVSxDQUFDO0lBQ3hELE1BQU0sYUFBYSxHQUFHLFFBQVEsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLGFBQWEsSUFBSSxXQUFXLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUM3RSxNQUFNLFdBQVcsR0FBRyxHQUFHLFlBQVksU0FBUyxDQUFDO0lBRTdDLGtFQUFrRTtJQUNsRSxJQUFJLFlBQVksS0FBSyxhQUFhO1FBQ2hDLE1BQU0sSUFBSSxLQUFLLENBQ2IsK0JBQStCLFlBQVksZ0VBQWdFLENBQzVHLENBQUM7SUFFSix5RUFBeUU7SUFDekUsOENBQThDO0lBQzlDLE1BQU0sV0FBVyxHQUFHLENBQUMsS0FBbUIsRUFBRSxFQUFFO1FBQzFDLDJFQUEyRTtRQUMzRSxpQ0FBaUM7UUFDakMsTUFBTSxjQUFjLEdBQ2xCLGNBQWMsSUFBSSxjQUFjLENBQUMsTUFBTTtZQUNyQyxDQUFDLENBQUMseUNBQW1CLENBQUMsS0FBSyxFQUFFLGNBQWMsQ0FBQztZQUM1QyxDQUFDLENBQUMscUJBQWtCLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFaEMsa0VBQWtFO1FBQ2xFLG1CQUFtQjtRQUNuQixJQUFJLGNBQWM7WUFDZixjQUF5QixDQUFDLE9BQU8sQ0FBQztnQkFDakMsS0FBSyxDQUFDLEtBQUssSUFBSSxJQUFJLElBQUksY0FBYyxLQUFLLE1BQU0sQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUM7UUFFN0YsT0FBTyxjQUFjLENBQUM7SUFDeEIsQ0FBQyxDQUFDO0lBRUYsTUFBTSxxQkFBcUIsR0FBRyxDQUFDLE1BQTJCLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsV0FBVyxDQUFDLENBQUM7SUFDdkYsTUFBTSxZQUFZLEdBQUcsT0FBTyxDQUFDLFlBQVksSUFBSSxxQkFBcUIsQ0FBQztJQUVuRSxTQUFTLDZCQUE2QixDQUFDLEdBQVEsRUFBRSxJQUFTLEVBQUUsSUFBUztRQUNuRSxJQUFJLEdBQUcsQ0FBQyxPQUFPLElBQUksR0FBRyxDQUFDLE9BQU8sQ0FBQyxPQUFPLElBQUksR0FBRyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFO1lBQ2xFLEdBQUcsQ0FBQyxLQUFLLEdBQUcsSUFBSSxDQUFDO1lBQ2pCLEdBQUcsQ0FBQyxJQUFJLEdBQUcsR0FBRyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDO1NBQ3JDO1FBQ0QsSUFBSSxFQUFFLENBQUM7SUFDVCxDQUFDO0lBRUQsNkVBQTZFO0lBQzdFLDRFQUE0RTtJQUM1RSxtRUFBbUU7SUFDbkUsd0VBQXdFO0lBQ3hFLGFBQWE7SUFDYixNQUFNLHFCQUFxQixHQUFHO1FBQzVCLDhDQUE4QztRQUM5Qyw2QkFBNkI7UUFDN0IscUJBQXFCO1FBQ3JCLFVBQVUsQ0FBQyxJQUFJLENBQUMsRUFBRSxLQUFLLEVBQUUsT0FBTyxDQUFDLGFBQWEsRUFBRSxDQUFDO1FBQ2pELG9DQUFvQztRQUNwQyxVQUFVLENBQUMsVUFBVSxDQUFDLEVBQUUsUUFBUSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsT0FBTyxDQUFDLGFBQWEsRUFBRSxDQUFDO1FBQ3hFLDJEQUEyRDtRQUMzRCxVQUFVLENBQUMsSUFBSSxDQUFDLEVBQUUsSUFBSSxFQUFFLHFCQUFxQixFQUFFLEtBQUssRUFBRSxPQUFPLENBQUMsYUFBYSxFQUFFLENBQUM7S0FDL0UsQ0FBQztJQUVGLDBFQUEwRTtJQUMxRSxNQUFNLDZCQUE2QixHQUFHLHFCQUFxQixDQUFDLE1BQU0sQ0FDaEUsQ0FDRSxNQUF3RixFQUN4RixFQUFvRixFQUNBLEVBQUU7UUFDdEYsT0FBTyxDQUFDLEdBQUcsRUFBRSxHQUFHLEVBQUUsSUFBSSxFQUFFLEVBQUU7WUFDeEIsTUFBTSxDQUFDLEdBQUcsRUFBRSxHQUFHLEVBQUUsS0FBSyxDQUFDLEVBQUU7Z0JBQ3ZCLElBQUksS0FBSyxFQUFFO29CQUNULE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO2lCQUNwQjtnQkFDRCxFQUFFLENBQUMsR0FBRyxFQUFFLEdBQUcsRUFBRSxJQUFJLENBQUMsQ0FBQztZQUNyQixDQUFDLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQztJQUNKLENBQUMsRUFDRCxDQUFDLElBQXFCLEVBQUUsSUFBb0IsRUFBRSxJQUEyQixFQUFFLEVBQUUsQ0FBQyxJQUFJLEVBQUUsQ0FDckYsQ0FBQztJQUVGLG9EQUFvRDtJQUNwRCxNQUFNLFNBQVMsR0FBRyxDQUFDLEdBQW9CLEVBQUUsR0FBbUIsRUFBRSxFQUFFLENBQzlELElBQUksT0FBTyxDQUFDLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxFQUFFO1FBQzlCLDZCQUE2QixDQUFDLEdBQUcsRUFBRSxHQUFHLEVBQUUsQ0FBQyxLQUFZLEVBQUUsRUFBRTtZQUN2RCxJQUFJLEtBQUssRUFBRTtnQkFDVCxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7YUFDZjtpQkFBTTtnQkFDTCxPQUFPLEVBQUUsQ0FBQzthQUNYO1FBQ0gsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDLENBQUMsQ0FBQztJQUVMLHVHQUF1RztJQUN2RyxJQUFJLFlBQTJCLENBQUM7SUFFaEMsTUFBTSxpQ0FBaUMsR0FBRywwQ0FBMEMsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUU5RixNQUFNLHFCQUFxQixHQUFHLFVBQVUsQ0FBQyxxQ0FBcUMsRUFBRSx3QkFBYyxFQUFFO1FBQzlGLE9BQU87S0FDUixDQUFDLENBQUM7SUFTSCxNQUFNLFVBQVUsR0FBRyxJQUFJLGFBQUcsQ0FBQztRQUN6QixTQUFTLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxpQkFBaUIsR0FBRyxNQUFNLENBQUM7S0FDakQsQ0FBQyxDQUFDO0lBRUgsSUFBSSxhQUE0QixDQUFDO0lBQ2pDLE1BQU0sVUFBVSxHQUFHLENBQ2pCLFNBQXdCLEVBQ3hCLFdBQW1CLEVBSW5CLEVBQUU7UUFDRixJQUFJLFNBQVMsS0FBSyxhQUFhLEVBQUU7WUFDL0IsVUFBVSxDQUFDLEtBQUssRUFBRSxDQUFDO1lBQ25CLGFBQWEsR0FBRyxTQUFTLENBQUM7U0FDM0I7UUFFRCx5RUFBeUU7UUFDekUsb0NBQW9DO1FBQ3BDLE1BQU0sUUFBUSxHQUFHLGlCQUFpQixHQUFHLENBQUMsSUFBSSxXQUFXLENBQUMsTUFBTSxHQUFHLE1BQU0sQ0FBQztRQUV0RSxNQUFNLElBQUksR0FBRyxRQUFRLENBQUMsQ0FBQyxDQUFDLGtCQUFrQixDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7UUFDL0QsTUFBTSxNQUFNLEdBQUcsUUFBUSxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLElBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7UUFDdkQsSUFBSSxNQUFNLEVBQUU7WUFDVixPQUFPLE1BQU0sQ0FBQztTQUNmO2FBQU07WUFDTCxNQUFNLE1BQU0sR0FBRyxJQUFJLGdCQUFNLENBQUMsV0FBVyxFQUFFLHNCQUFzQixDQUFDLENBQUM7WUFDL0QsSUFBSSxnQkFBcUMsQ0FBQztZQUUxQyx1RUFBdUU7WUFDdkUsa0RBQWtEO1lBQ2xELElBQUk7Z0JBQ0YsZ0JBQWdCLEdBQUcsZUFBWSxDQUFDLE1BQU0sQ0FBQyxDQUFDO2FBQ3pDO1lBQUMsT0FBTyxLQUFLLEVBQUU7Z0JBQ2QsS0FBSyxDQUFDLFVBQVUsR0FBRyxHQUFHLENBQUM7Z0JBQ3ZCLE1BQU0sS0FBSyxDQUFDO2FBQ2I7WUFFRCxJQUFJLFlBQVksQ0FBQyxPQUFPO2dCQUFFLFlBQVksQ0FBQywwQkFBMEIsQ0FBQyxDQUFDO1lBRW5FLGdEQUFnRDtZQUNoRCxNQUFNLGdCQUFnQixHQUFHLGtCQUFlLENBQUMsU0FBUyxFQUFFLGdCQUFnQixFQUFFLHFCQUFxQixDQUFDLENBQUM7WUFDN0YsTUFBTSxXQUFXLEdBQWU7Z0JBQzlCLGdCQUFnQjtnQkFDaEIsZ0JBQWdCO2dCQUNoQixNQUFNLEVBQUUsV0FBVyxDQUFDLE1BQU07YUFDM0IsQ0FBQztZQUNGLElBQUksUUFBUSxFQUFFO2dCQUNaLFVBQVUsQ0FBQyxHQUFHLENBQUMsSUFBSyxFQUFFLFdBQVcsQ0FBQyxDQUFDO2FBQ3BDO1lBQ0QsT0FBTyxXQUFXLENBQUM7U0FDcEI7SUFDSCxDQUFDLENBQUM7SUFFRixJQUFJLG1CQUFtQixHQUE4RCxDQUNuRixHQUFHLEVBQ0gsUUFBUSxFQUNSLEVBQUU7UUFDRix3QkFBd0I7UUFDeEIsbUJBQW1CLEdBQUcsSUFBSSxDQUFDO1FBRTNCLElBQUksZUFBZSxJQUFJLElBQUksRUFBRTtZQUMzQixnRUFBZ0U7WUFDaEUsTUFBTSxFQUFFLFFBQVEsRUFBRSxnQkFBZ0IsR0FBRyxFQUFFLEVBQUUsR0FBRyxRQUFRLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUN6RSxJQUFJLGdCQUFnQixLQUFLLFFBQVEsSUFBSSxnQkFBZ0IsQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDLEVBQUU7Z0JBQ3hFLGdGQUFnRjtnQkFDaEYsZ0RBQWdEO2dCQUNoRCxlQUFlLEdBQUcsZ0JBQWdCLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxnQkFBZ0IsQ0FBQyxNQUFNLEdBQUcsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDO2FBQ3pGO1lBQ0QsdUNBQXVDO1lBQ3ZDLGVBQWUsR0FBRyxlQUFlLElBQUksRUFBRSxDQUFDO1NBQ3pDO1FBRUQsZ0ZBQWdGO1FBQ2hGLFlBQVksR0FBRyxnQkFBZ0I7WUFDN0IsQ0FBQyxDQUFDLGdCQUFnQixDQUFDLE9BQU8sQ0FDdEIsVUFBVSxFQUNWLHdDQUF3QyxpQkFBaUIsQ0FBQztnQkFDeEQsVUFBVSxFQUFFLEdBQUcsZUFBZSxHQUFHLFlBQVksRUFBRTtnQkFDL0MsU0FBUyxFQUFFLE9BQU8sQ0FBQyxDQUFDLENBQUMsR0FBRyxlQUFlLEdBQUcsWUFBWSxTQUFTLENBQUMsQ0FBQyxDQUFDLElBQUk7Z0JBQ3RFLGVBQWU7Z0JBQ2YsZ0NBQWdDO2dCQUNoQyxhQUFhO2FBQ2QsQ0FBQyx1QkFBdUIsQ0FDMUI7WUFDSCxDQUFDLENBQUMsSUFBSSxDQUFDO1FBRVQsSUFBSSxhQUFhLEVBQUU7WUFDakIsTUFBTSxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxVQUFVLElBQUksR0FBRyxDQUFDLFVBQVUsQ0FBQyxRQUFRLENBQUMsQ0FBQztZQUNqRSxJQUFJLENBQUMsTUFBTSxFQUFFO2dCQUNYLHNDQUFzQztnQkFDdEMsT0FBTyxDQUFDLElBQUksQ0FDVix1SEFBdUgsQ0FDeEgsQ0FBQzthQUNIO2lCQUFNO2dCQUNMLHFFQUFxRTtnQkFDckUsb0RBQW9EO2dCQUNwRCxrREFBa0MsQ0FBQyxNQUFNLEVBQUUsVUFBVSxDQUFDLENBQUM7YUFDeEQ7U0FDRjtJQUNILENBQUMsQ0FBQztJQUVGOzs7T0FHRztJQUNILElBQUksMEJBQTBCLEdBQXlCLElBQUksQ0FBQztJQUM1RCxJQUFJLENBQUMsT0FBTyxFQUFFO1FBQ1osWUFBWSxFQUFFO2FBQ1gsSUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFFO1lBQ2IsMEJBQTBCLEdBQUcsTUFBTSxDQUFDO1FBQ3RDLENBQUMsQ0FBQzthQUNELEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztLQUNoQjtJQUVEOzs7O09BSUc7SUFDSCxNQUFNLGNBQWMsR0FBRyxLQUFLLEVBQzFCLFdBQTRCLEVBQzVCLEdBQW1CLEVBQ25CLElBQTJCLEVBQzNCLEVBQUU7UUFDRix5RUFBeUU7UUFDekUseUVBQXlFO1FBQ3pFLHFFQUFxRTtRQUNyRSw4Q0FBOEM7UUFDOUMsTUFBTSxHQUFHLEdBQUcsVUFBVSxDQUFDLDJCQUEyQixFQUFFLFdBQVcsRUFBRTtZQUMvRCxPQUFPO1lBQ1AsR0FBRztZQUNILElBQUk7U0FDTCxDQUFDLENBQUM7UUFDSCxJQUFJLEdBQUcsSUFBSSxJQUFJLEVBQUU7WUFDZixPQUFPO1NBQ1I7UUFFRCwrREFBK0Q7UUFDL0Qsc0NBQXNDO1FBQ3RDLEVBQUU7UUFDRiwyRUFBMkU7UUFDM0UsZ0JBQWdCO1FBQ2hCLElBQUksVUFBVTtZQUFFLGNBQWMsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUVwQyxNQUFNLEVBQUUsUUFBUSxHQUFHLEVBQUUsRUFBRSxHQUFHLFFBQVEsQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLENBQUM7UUFFOUMsdUVBQXVFO1FBQ3ZFLHNFQUFzRTtRQUN0RSw4Q0FBOEM7UUFDOUMsSUFBSSxtQkFBbUI7WUFBRSxtQkFBbUIsQ0FBQyxHQUFHLEVBQUUsUUFBUSxDQUFDLENBQUM7UUFFNUQsTUFBTSxjQUFjLEdBQUcsUUFBUSxLQUFLLFlBQVksQ0FBQztRQUVqRCwyRUFBMkU7UUFDM0Usb0NBQW9DO1FBQ3BDLDJFQUEyRTtRQUUzRSxJQUFJLENBQUMsZ0JBQWdCLElBQUksUUFBUSxJQUFJLENBQUMsY0FBYyxFQUFFO1lBQ3BELHlFQUF5RTtZQUN6RSxVQUFVO1lBQ1YseUVBQXlFO1lBRXpFLHNFQUFzRTtZQUN0RSw2QkFBNkI7WUFDN0IsSUFBSSxRQUFRLEtBQUssY0FBYyxFQUFFO2dCQUMvQiw4REFBOEQ7Z0JBQzlELElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEtBQUssS0FBSyxJQUFJLEdBQUcsQ0FBQyxNQUFNLEtBQUssTUFBTSxDQUFDLEVBQUU7b0JBQ3BELEdBQUcsQ0FBQyxVQUFVLEdBQUcsR0FBRyxDQUFDLE1BQU0sS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDO29CQUN0RCxHQUFHLENBQUMsU0FBUyxDQUFDLE9BQU8sRUFBRSxvQkFBb0IsQ0FBQyxDQUFDO29CQUM3QyxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7b0JBQ1YsT0FBTztpQkFDUjtnQkFFRCxvRUFBb0U7Z0JBQ3BFLEdBQUcsQ0FBQyxVQUFVLEdBQUcsR0FBRyxDQUFDO2dCQUNyQixHQUFHLENBQUMsU0FBUyxDQUFDLGVBQWUsRUFBRSx1QkFBdUIsQ0FBQyxDQUFDO2dCQUN4RCxHQUFHLENBQUMsU0FBUyxDQUFDLGNBQWMsRUFBRSxjQUFjLENBQUMsQ0FBQztnQkFFOUMscUNBQXFDO2dCQUNyQyxJQUFJLEdBQUcsQ0FBQyxNQUFNLEtBQUssTUFBTSxFQUFFO29CQUN6QixHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7b0JBQ1YsT0FBTztpQkFDUjtnQkFFRCxHQUFHLENBQUMsR0FBRyxDQUFDLHFCQUFPLENBQUMsQ0FBQztnQkFDakIsT0FBTzthQUNSO1lBRUQseUVBQXlFO1lBQ3pFLHdCQUF3QjtZQUN4Qix5RUFBeUU7WUFFekUscUVBQXFFO1lBQ3JFLElBQUksUUFBUSxLQUFLLFdBQVcsSUFBSSxRQUFRLEtBQUssdUJBQXVCLEVBQUU7Z0JBQ3BFLElBQUksQ0FBQyxPQUFPLElBQUksR0FBRyxDQUFDLE9BQU8sQ0FBQyxNQUFNLEtBQUssbUJBQW1CLEVBQUU7b0JBQzFELEdBQUcsQ0FBQyxVQUFVLEdBQUcsR0FBRyxDQUFDO29CQUNyQixHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7b0JBQ1YsT0FBTztpQkFDUjtnQkFDRCwrQkFBcUIsQ0FBQyxHQUFHLEVBQUUsR0FBRyxFQUFFLE9BQU8sQ0FBQyxDQUFDO2dCQUN6QyxPQUFPO2FBQ1I7WUFFRCx5RUFBeUU7WUFDekUsZ0JBQWdCO1lBQ2hCLHlFQUF5RTtZQUV6RSxtRUFBbUU7WUFDbkUsSUFBSSxRQUFRLEtBQUssYUFBYSxFQUFFO2dCQUM5Qiw0REFBNEQ7Z0JBQzVELElBQUksNkJBQTZCLEVBQUU7b0JBQ2pDLEdBQUcsQ0FBQyxVQUFVLEdBQUcsR0FBRyxDQUFDO29CQUNyQixHQUFHLENBQUMsU0FBUyxDQUFDLFVBQVUsRUFBRSx1QkFBdUIsQ0FBQyxDQUFDO29CQUNuRCxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7b0JBQ1YsT0FBTztpQkFDUjtnQkFFRCxvREFBb0Q7Z0JBQ3BELElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEtBQUssS0FBSyxJQUFJLEdBQUcsQ0FBQyxNQUFNLEtBQUssTUFBTSxDQUFDLEVBQUU7b0JBQ3BELEdBQUcsQ0FBQyxVQUFVLEdBQUcsR0FBRyxDQUFDLE1BQU0sS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDO29CQUN0RCxHQUFHLENBQUMsU0FBUyxDQUFDLE9BQU8sRUFBRSxvQkFBb0IsQ0FBQyxDQUFDO29CQUM3QyxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7b0JBQ1YsT0FBTztpQkFDUjtnQkFFRCxHQUFHLENBQUMsVUFBVSxHQUFHLEdBQUcsQ0FBQztnQkFDckIsR0FBRyxDQUFDLFNBQVMsQ0FBQyxjQUFjLEVBQUUsMEJBQTBCLENBQUMsQ0FBQztnQkFFMUQsSUFBSSxnQ0FBZ0MsRUFBRTtvQkFDcEMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxpQkFBaUIsRUFBRSxjQUFjLGdDQUFnQyxFQUFFLENBQUMsQ0FBQztvQkFDbkYsR0FBRyxDQUFDLFNBQVMsQ0FBQyx5QkFBeUIsRUFBRSwwQkFBMEIsZ0NBQWdDLEVBQUUsQ0FBQyxDQUFDO2lCQUN4RztxQkFBTTtvQkFDTCxPQUFPLENBQUMsR0FBRyxDQUFDLGlCQUFpQixFQUFFLE9BQU8sQ0FBQyxDQUFDO29CQUN4QyxHQUFHLENBQUMsU0FBUyxDQUFDLGlCQUFpQixFQUFFLFlBQVksQ0FBQyxDQUFDO29CQUMvQyxHQUFHLENBQUMsU0FBUyxDQUFDLHlCQUF5QixFQUFFLHdCQUF3QixDQUFDLENBQUM7aUJBQ3BFO2dCQUVELHFDQUFxQztnQkFDckMsSUFBSSxHQUFHLENBQUMsTUFBTSxLQUFLLE1BQU0sRUFBRTtvQkFDekIsR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO29CQUNWLE9BQU87aUJBQ1I7Z0JBRUQsNkJBQTZCO2dCQUM3QixHQUFHLENBQUMsR0FBRyxDQUFDLFlBQVksQ0FBQyxDQUFDO2dCQUN0QixPQUFPO2FBQ1I7U0FDRjtRQUVELDhEQUE4RDtRQUM5RCxJQUFJLENBQUMsY0FBYztZQUFFLE9BQU8sSUFBSSxFQUFFLENBQUM7UUFFbkMsMkVBQTJFO1FBQzNFLDBCQUEwQjtRQUMxQiwyRUFBMkU7UUFFM0UsMkVBQTJFO1FBQzNFLEdBQUcsQ0FBQyxVQUFVLEdBQUcsR0FBRyxDQUFDO1FBQ3JCLElBQUksT0FBTyxFQUFFO1lBQ1gsc0VBQXNFO1lBQ3RFLDBEQUEwRDtZQUMxRCxHQUFHLENBQUMsU0FBUyxDQUFDLHdCQUF3QixFQUFFLEdBQUcsZUFBZSxHQUFHLFlBQVksU0FBUyxDQUFDLENBQUM7U0FDckY7UUFFRCwyREFBMkQ7UUFDM0QsSUFBSSxHQUFHLENBQUMsTUFBTSxLQUFLLFNBQVMsRUFBRTtZQUM1QixHQUFHLENBQUMsVUFBVSxHQUFHLEdBQUcsQ0FBQztZQUNyQixHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7WUFDVixPQUFPO1NBQ1I7UUFFRCxvRUFBb0U7UUFDcEUsb0VBQW9FO1FBQ3BFLDRDQUE0QztRQUM1QyxJQUFJLFVBQWUsQ0FBQztRQUNwQixJQUFJLE9BQU8sR0FJTixFQUFFLENBQUM7UUFDUixNQUFNLGNBQWMsR0FBRyxDQUFDLGVBQWUsSUFBSSxPQUFPLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDNUQsSUFBSSxNQUFjLENBQUM7UUFFbkIsSUFBSSxZQUFZLENBQUMsT0FBTztZQUFFLFlBQVksQ0FBQyxrQ0FBa0MsQ0FBQyxDQUFDO1FBQzNFLElBQUksV0FBVyxHQUFHLEtBQUssQ0FBQztRQUV4Qix5RUFBeUU7UUFDekUseUVBQXlFO1FBQ3pFLDRCQUE0QjtRQUM1QixJQUFJO1lBQ0Ysd0VBQXdFO1lBQ3hFLDZEQUE2RDtZQUM3RCxNQUFNLFNBQVMsR0FBRywwQkFBMEIsSUFBSSxDQUFDLE1BQU0sWUFBWSxFQUFFLENBQUMsQ0FBQztZQUV2RSxtRUFBbUU7WUFDbkUseUVBQXlFO1lBQ3pFLGdFQUFnRTtZQUNoRSxFQUFFO1lBQ0YseUVBQXlFO1lBQ3pFLDJDQUEyQztZQUMzQyxNQUFNLFNBQVMsQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLENBQUM7WUFFMUIsNkRBQTZEO1lBQzdELElBQUksR0FBRyxDQUFDLE1BQU0sS0FBSyxNQUFNLEVBQUU7Z0JBQ3pCLEdBQUcsQ0FBQyxTQUFTLENBQUMsT0FBTyxFQUFFLGVBQWUsQ0FBQyxDQUFDO2dCQUN4QyxNQUFNLFNBQVMsQ0FBQyxHQUFHLEVBQUUsbUNBQW1DLENBQUMsQ0FBQzthQUMzRDtZQUVELHdFQUF3RTtZQUN4RSxXQUFXO1lBQ1gsRUFBRTtZQUNGLGdEQUFnRDtZQUNoRCx1RUFBdUU7WUFDdkUsd0VBQXdFO1lBQ3hFLGtCQUFrQjtZQUNsQixNQUFNLElBQUksR0FBcUIsR0FBVyxDQUFDLElBQUksQ0FBQztZQUNoRCxVQUFVLEdBQUcsT0FBTyxJQUFJLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO1lBRS9ELHdDQUF3QztZQUN4QyxJQUFJLFVBQVUsSUFBSSxJQUFJO2dCQUNwQixNQUFNLFNBQVMsQ0FBQyxHQUFHLEVBQUUsdURBQXVELENBQUMsQ0FBQztZQUNoRixJQUFJLE9BQU8sVUFBVSxLQUFLLFFBQVE7Z0JBQ2hDLE1BQU0sU0FBUyxDQUNiLEdBQUcsRUFDSCxpREFBaUQsT0FBTyxVQUFVLElBQUksQ0FDdkUsQ0FBQztZQUNKLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsRUFBRTtnQkFDN0IsSUFBSSxDQUFDLG1CQUFtQixFQUFFO29CQUN4QixNQUFNLFNBQVMsQ0FDYixHQUFHLEVBQ0gsOEZBQThGLENBQy9GLENBQUM7aUJBQ0g7cUJBQU07b0JBQ0wsV0FBVyxHQUFHLElBQUksQ0FBQztpQkFDcEI7YUFDRjtpQkFBTTtnQkFDTCxVQUFVLEdBQUcsQ0FBQyxVQUFVLENBQUMsQ0FBQzthQUMzQjtZQUNELFVBQVUsR0FBRyxVQUFVLENBQUMsNkJBQTZCLEVBQUUsVUFBVSxFQUFFO2dCQUNqRSxPQUFPO2dCQUNQLEdBQUc7Z0JBQ0gsR0FBRztnQkFDSCxXQUFXO2dCQUNYLFNBQVM7YUFDVixDQUFDLENBQUM7WUFDSCxPQUFPLEdBQUcsTUFBTSxPQUFPLENBQUMsR0FBRyxDQUN6QixVQUFVLENBQUMsR0FBRyxDQUFDLEtBQUssRUFBRSxNQUFXLEVBQUUsRUFBRTtnQkFDbkMsSUFBSSxnQkFBZ0IsR0FBd0IsSUFBSSxDQUFDO2dCQUNqRCxJQUFJLE1BQVcsQ0FBQztnQkFDaEIsTUFBTSxJQUFJLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDakMsSUFBSTtvQkFDRixJQUFJLENBQUMsTUFBTTt3QkFBRSxNQUFNLFNBQVMsQ0FBQyxHQUFHLEVBQUUsMEJBQTBCLENBQUMsQ0FBQztvQkFDOUQsTUFBTSxFQUFFLEtBQUssRUFBRSxhQUFhLEVBQUUsR0FBRyxNQUFNLENBQUM7b0JBQ3hDLElBQUksRUFBRSxTQUFTLEVBQUUsR0FBRyxNQUFNLENBQUM7b0JBQzNCLElBQUksQ0FBQyxLQUFLO3dCQUFFLE1BQU0sU0FBUyxDQUFDLEdBQUcsRUFBRSw4QkFBOEIsQ0FBQyxDQUFDO29CQUVqRSxzRUFBc0U7b0JBQ3RFLHNCQUFzQjtvQkFDdEIsSUFBSSxPQUFPLFNBQVMsS0FBSyxRQUFRLEVBQUU7d0JBQ2pDLHFFQUFxRTt3QkFDckUsYUFBYTt3QkFDYixJQUFJLFNBQVMsS0FBSyxFQUFFLEVBQUU7NEJBQ3BCLFNBQVMsR0FBRyxJQUFJLENBQUM7eUJBQ2xCOzZCQUFNOzRCQUNMLDZDQUE2Qzs0QkFDN0MsSUFBSTtnQ0FDRixTQUFTLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQzs2QkFDbkM7NEJBQUMsT0FBTyxLQUFLLEVBQUU7Z0NBQ2QsS0FBSyxDQUFDLFVBQVUsR0FBRyxHQUFHLENBQUM7Z0NBQ3ZCLE1BQU0sS0FBSyxDQUFDOzZCQUNiO3lCQUNGO3FCQUNGO29CQUVELGtEQUFrRDtvQkFDbEQsSUFBSSxTQUFTLElBQUksSUFBSSxJQUFJLE9BQU8sU0FBUyxLQUFLLFFBQVE7d0JBQ3BELE1BQU0sU0FBUyxDQUFDLEdBQUcsRUFBRSxxQ0FBcUMsT0FBTyxTQUFTLElBQUksQ0FBQyxDQUFDO29CQUVsRixxREFBcUQ7b0JBQ3JELElBQUksYUFBYSxJQUFJLElBQUksSUFBSSxPQUFPLGFBQWEsS0FBSyxRQUFRO3dCQUM1RCxNQUFNLFNBQVMsQ0FDYixHQUFHLEVBQ0gseUNBQXlDLE9BQU8sYUFBYSxJQUFJLENBQ2xFLENBQUM7b0JBRUosSUFBSSxnQkFBNkMsQ0FBQztvQkFDbEQsQ0FBQyxFQUFFLGdCQUFnQixFQUFFLGdCQUFnQixFQUFFLEdBQUcsVUFBVSxDQUFDLFNBQVMsRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFDO29CQUV4RSxJQUFJLGdCQUFnQixDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUU7d0JBQ2pDLHFDQUFxQzt3QkFDckMsaUVBQWlFO3dCQUNqRSxxREFBcUQ7d0JBQ3JELE1BQU0sbUJBQW1CLEdBQUcsVUFBVSxDQUFDLDhCQUE4QixFQUFFLEVBQUUsRUFBRTs0QkFDekUsT0FBTzs0QkFDUCxHQUFHOzRCQUNILEdBQUc7NEJBQ0gsU0FBUzs0QkFDVCxhQUFhOzRCQUNiLElBQUk7eUJBQ0wsQ0FBQyxDQUFDO3dCQUNILElBQUksbUJBQW1CLENBQUMsTUFBTSxFQUFFOzRCQUM5QixnQkFBZ0IsR0FBRyxrQkFBZSxDQUNoQyxTQUFTLEVBQ1QsZ0JBQWdCLEVBQ2hCLG1CQUFtQixDQUNwQixDQUFDO3lCQUNIO3FCQUNGO29CQUVELHNFQUFzRTtvQkFDdEUsbURBQW1EO29CQUNuRCxJQUFJLGdCQUFnQixDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUU7d0JBQy9CLE1BQU0sR0FBRyxFQUFFLE1BQU0sRUFBRSxnQkFBZ0IsRUFBRSxVQUFVLEVBQUUsR0FBRyxFQUFFLENBQUM7cUJBQ3hEO3lCQUFNLElBQUksQ0FBQyxnQkFBZ0IsRUFBRTt3QkFDNUIsTUFBTSxJQUFJLEtBQUssQ0FBQyx5QkFBeUIsQ0FBQyxDQUFDO3FCQUM1Qzt5QkFBTTt3QkFDTCxJQUFJLFlBQVksQ0FBQyxPQUFPOzRCQUFFLFlBQVksQ0FBQyw2QkFBNkIsQ0FBQyxDQUFDO3dCQUV0RSxzRUFBc0U7d0JBQ3RFLElBQUksWUFBWSxDQUFDLE9BQU87NEJBQ3RCLFlBQVksQ0FDVixJQUFJLEVBQ0osZUFBWSxDQUFDLGdCQUFnQixDQUFDO2lDQUMzQixPQUFPLENBQUMsTUFBTSxFQUFFLEdBQUcsQ0FBQztpQ0FDcEIsSUFBSSxFQUFFLENBQ1YsQ0FBQzt3QkFFSixNQUFNLEdBQUcsTUFBTSxpQ0FBaUMsQ0FDOUMsR0FBRyxFQUNILEdBQUcsRUFDSDs0QkFDRSxlQUFlLEVBQUUsS0FBSzs0QkFDdEIsZ0JBQWdCOzRCQUNoQixTQUFTOzRCQUNULGFBQWE7eUJBQ2QsRUFDRCxDQUFDLGNBQW1CLEVBQUUsRUFBRTs0QkFDdEIsTUFBTSxHQUFHLGNBQWMsQ0FBQyxNQUFNLENBQUM7NEJBQy9CLE9BQU8saUJBQWMsQ0FDbkIsU0FBUyxFQUNULGdCQUFpQixFQUNqQixJQUFJLEVBQ0osY0FBYyxFQUNkLFNBQVMsRUFDVCxhQUFhLENBQ2QsQ0FBQzt3QkFDSixDQUFDLENBQ0YsQ0FBQztxQkFDSDtpQkFDRjtnQkFBQyxPQUFPLEtBQUssRUFBRTtvQkFDZCxNQUFNLEdBQUc7d0JBQ1AsTUFBTSxFQUFFLENBQUMsS0FBSyxDQUFDO3dCQUNmLFVBQVUsRUFBRSxLQUFLLENBQUMsTUFBTSxJQUFJLEtBQUssQ0FBQyxVQUFVLElBQUksR0FBRztxQkFDcEQsQ0FBQztvQkFFRixrREFBa0Q7b0JBQ2xELElBQUksTUFBTSxDQUFDLFVBQVUsS0FBSyxHQUFHO3dCQUMzQixzQ0FBc0M7d0JBQ3RDLE9BQU8sQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDO2lCQUM5Qjt3QkFBUztvQkFDUiw4REFBOEQ7b0JBQzlELElBQUksTUFBTSxJQUFJLE1BQU0sQ0FBQyxNQUFNLEVBQUU7d0JBQzNCLE1BQU0sQ0FBQyxNQUFNLEdBQUksWUFBb0IsQ0FBQyxNQUFNLENBQUMsTUFBTSxFQUFFLEdBQUcsRUFBRSxHQUFHLENBQUMsQ0FBQztxQkFDaEU7b0JBQ0QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRTt3QkFDbEIsTUFBTSxDQUFDLElBQUksR0FBRyxJQUFJLENBQUM7cUJBQ3BCO29CQUNELE1BQU0sR0FBRyxVQUFVLENBQUMsMEJBQTBCLEVBQUUsTUFBTSxFQUFFO3dCQUN0RCxPQUFPO3dCQUNQLFdBQVc7d0JBQ1gsZ0JBQWdCO3dCQUNoQixHQUFHO3dCQUNILE1BQU07cUJBR1AsQ0FBQyxDQUFDO29CQUNILCtEQUErRDtvQkFDL0QsSUFBSSxDQUFDLGVBQWUsSUFBSSxnQkFBZ0IsRUFBRTt3QkFDeEMsd0JBQXdCO3dCQUN4QixNQUFNLDBCQUEwQixHQUFHLGdCQUFnQixDQUFDO3dCQUNwRCw4Q0FBOEM7d0JBQzlDLE1BQU0sZ0JBQWdCLEdBQUcsTUFBTSxDQUFDLFVBQVUsQ0FBQzt3QkFDM0MsTUFBTSxRQUFRLEdBQUcsY0FBYyxJQUFJLE9BQU8sQ0FBQyxNQUFNLENBQUMsY0FBYyxDQUFDLENBQUM7d0JBQ2xFLFlBQVksQ0FBQyxHQUFHLEVBQUU7NEJBQ2hCLE1BQU0sV0FBVyxHQUFHLGVBQVksQ0FBQywwQkFBMEIsQ0FBQztpQ0FDekQsT0FBTyxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUM7aUNBQ3BCLElBQUksRUFBRSxDQUFDOzRCQUNWLE1BQU0sVUFBVSxHQUFHLENBQUMsTUFBTSxDQUFDLE1BQU0sSUFBSSxFQUFFLENBQUMsQ0FBQyxNQUFNLENBQUM7NEJBQ2hELE1BQU0sRUFBRSxHQUFHLFFBQVEsQ0FBQyxDQUFDLENBQUMsR0FBRyxHQUFHLEdBQUcsUUFBUSxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQzs0QkFFbEQsSUFBSSxPQUFlLENBQUM7NEJBQ3BCLElBQUksZ0JBQWdCLEtBQUssR0FBRyxFQUFFO2dDQUM1QiwyREFBMkQ7Z0NBQzNELEVBQUU7Z0NBQ0Ysd0RBQXdEO2dDQUN4RCxPQUFPLEdBQUcsZUFBSyxDQUFDLEdBQUcsQ0FBQywwQkFBMEIsQ0FBQyxDQUFDOzZCQUNqRDtpQ0FBTSxJQUFJLGdCQUFnQixLQUFLLEdBQUcsRUFBRTtnQ0FDbkMsT0FBTyxHQUFHLGVBQUssQ0FBQyxHQUFHLENBQUMscUJBQXFCLENBQUMsQ0FBQzs2QkFDNUM7aUNBQU07Z0NBQ0wsT0FBTyxHQUFHLGVBQUssQ0FBQyxVQUFVLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEdBQUcsVUFBVSxXQUFXLENBQUMsQ0FBQzs2QkFDL0U7NEJBRUQsc0NBQXNDOzRCQUN0QyxPQUFPLENBQUMsR0FBRyxDQUNULEdBQUcsT0FBTyxJQUNSLE1BQU0sSUFBSSxJQUFJLENBQUMsQ0FBQyxDQUFDLE1BQU0sZUFBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUNwRCxNQUFNLGVBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxXQUFXLEVBQUUsQ0FDM0QsQ0FBQzt3QkFDSixDQUFDLENBQUMsQ0FBQztxQkFDSjtvQkFDRCxJQUFJLFlBQVksQ0FBQyxPQUFPO3dCQUFFLFlBQVksQ0FBQyxrQ0FBa0MsQ0FBQyxDQUFDO2lCQUM1RTtnQkFDRCxPQUFPLE1BQU0sQ0FBQztZQUNoQixDQUFDLENBQUMsQ0FDSCxDQUFDO1NBQ0g7UUFBQyxPQUFPLEtBQUssRUFBRTtZQUNkLHVEQUF1RDtZQUN2RCxJQUFJLEdBQUcsQ0FBQyxVQUFVLEtBQUssR0FBRztnQkFBRSxHQUFHLENBQUMsVUFBVSxHQUFHLEtBQUssQ0FBQyxNQUFNLElBQUksS0FBSyxDQUFDLFVBQVUsSUFBSSxHQUFHLENBQUM7WUFFckYsNEJBQTRCO1lBQzVCLFdBQVcsR0FBRyxLQUFLLENBQUM7WUFDcEIsT0FBTyxHQUFHLENBQUMsRUFBRSxNQUFNLEVBQUUsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUM7WUFFaEMsa0RBQWtEO1lBQ2xELElBQUksR0FBRyxDQUFDLFVBQVUsS0FBSyxHQUFHO2dCQUN4QixzQ0FBc0M7Z0JBQ3RDLE9BQU8sQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDO1NBQzlCO2dCQUFTO1lBQ1IsMkNBQTJDO1lBQzNDLElBQUksQ0FBQyxXQUFXLEVBQUU7Z0JBQ2hCLElBQUksR0FBRyxDQUFDLFVBQVUsS0FBSyxHQUFHLElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsRUFBRTtvQkFDbkQsR0FBRyxDQUFDLFVBQVUsR0FBRyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVyxDQUFDO2lCQUN6QztnQkFDRCxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxHQUFHLFNBQVMsQ0FBQzthQUNuQztZQUVELEdBQUcsQ0FBQyxTQUFTLENBQUMsY0FBYyxFQUFFLGlDQUFpQyxDQUFDLENBQUM7WUFDakUsTUFBTSxFQUFFLFVBQVUsRUFBRSxNQUFNLEVBQUUsR0FBRyxVQUFVLENBQ3ZDLHVCQUF1QixFQUN2QjtnQkFDRSxVQUFVLEVBQUUsR0FBRyxDQUFDLFVBQVU7Z0JBQzFCLE1BQU0sRUFBRSxXQUFXLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBRTthQUM1QyxFQUNEO2dCQUNFLE9BQU87Z0JBQ1AsV0FBVztnQkFDWCxHQUFHO2dCQUNILEdBQUc7YUFDSixDQUNGLENBQUM7WUFFRixJQUFJLFVBQVUsRUFBRTtnQkFDZCxHQUFHLENBQUMsVUFBVSxHQUFHLFVBQVUsQ0FBQzthQUM3QjtZQUNELEdBQUcsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDO1lBRWhDLElBQUksWUFBWSxDQUFDLE9BQU87Z0JBQ3RCLFlBQVksQ0FBQyxVQUFVLEdBQUcsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsb0JBQW9CLENBQUMsQ0FBQztTQUN6RjtJQUNILENBQUMsQ0FBQztJQUVGOzs7Ozs7Ozs7O09BVUc7SUFDSCxNQUFNLFVBQVUsR0FBUSxDQUFDLENBQU0sRUFBRSxDQUFNLEVBQUUsQ0FBTSxFQUFFLEVBQUU7UUFDakQsc0VBQXNFO1FBQ3RFLG9CQUFvQjtRQUNwQixJQUFJLHdCQUFRLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxFQUFFO1lBQ2xCLHdDQUF3QztZQUN4QyxNQUFNLEdBQUcsR0FBRyxDQUFlLENBQUM7WUFDNUIsTUFBTSxJQUFJLEdBQUcsQ0FBa0MsQ0FBQztZQUNoRCxPQUFPLDBCQUFhLENBQUMsR0FBRyxFQUFFLElBQUksRUFBRSxjQUFjLENBQUMsQ0FBQztTQUNqRDthQUFNO1lBQ0wseUVBQXlFO1lBQ3pFLHFFQUFxRTtZQUNyRSxpQkFBaUI7WUFDakIsTUFBTSxHQUFHLEdBQUcsQ0FBb0IsQ0FBQztZQUNqQyxNQUFNLEdBQUcsR0FBRyxDQUFtQixDQUFDO1lBQ2hDLE1BQU0sSUFBSSxHQUFHLENBQUMsSUFBSSxZQUFZLENBQUMsR0FBRyxFQUFFLEdBQUcsQ0FBQyxDQUFDO1lBRXpDLHVGQUF1RjtZQUN2RixjQUFjLENBQUMsR0FBRyxFQUFFLEdBQUcsRUFBRSxJQUFJLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUM7U0FDNUM7SUFDSCxDQUFDLENBQUM7SUFFRixVQUFVLENBQUMsZ0JBQWdCLEdBQUcsWUFBWSxDQUFDO0lBQzNDLFVBQVUsQ0FBQyxXQUFXLEdBQUcsV0FBVyxDQUFDO0lBQ3JDLFVBQVUsQ0FBQyxNQUFNLEdBQUcsTUFBTSxDQUFDO0lBQzNCLFVBQVUsQ0FBQyxpQ0FBaUMsR0FBRyxpQ0FBaUMsQ0FBQztJQUNqRixVQUFVLENBQUMsWUFBWSxHQUFHLFlBQVksQ0FBQztJQUN2QyxVQUFVLENBQUMsT0FBTyxHQUFHLE9BQU8sQ0FBQztJQUU3QixNQUFNLGdCQUFnQixHQUFHLFVBQVUsQ0FBQyx5QkFBeUIsRUFBRSxVQUFVLEVBQUU7UUFDekUsT0FBTztLQUNSLENBQUMsQ0FBQztJQUNILGdCQUFnQjtJQUNoQixJQUFJLENBQUMsZ0JBQWdCLENBQUMsZ0JBQWdCLEVBQUU7UUFDdEMsTUFBTSxJQUFJLEtBQUssQ0FDYixnSUFBZ0ksQ0FDakksQ0FBQztLQUNIO0lBRUQsT0FBTyxnQkFBc0MsQ0FBQztBQUNoRCxDQUFDO0FBdndCRCx1REF1d0JDO0FBRUQ7Ozs7Ozs7Ozs7O0dBV0c7QUFDSCxTQUFTLGNBQWMsQ0FBQyxHQUFtQjtJQUN6QyxHQUFHLENBQUMsU0FBUyxDQUFDLDZCQUE2QixFQUFFLEdBQUcsQ0FBQyxDQUFDO0lBQ2xELEdBQUcsQ0FBQyxTQUFTLENBQUMsOEJBQThCLEVBQUUsaUJBQWlCLENBQUMsQ0FBQztJQUNqRSxHQUFHLENBQUMsU0FBUyxDQUNYLDhCQUE4QixFQUM5QjtRQUNFLFFBQVE7UUFDUixrQkFBa0I7UUFDbEIsd0VBQXdFO1FBQ3hFLGtDQUFrQztRQUNsQyxRQUFRO1FBQ1IsMENBQTBDO1FBQzFDLGVBQWU7UUFDZiw4REFBOEQ7UUFDOUQsa0JBQWtCO1FBQ2xCLHFFQUFxRTtRQUNyRSwwQkFBMEI7UUFDMUIsY0FBYztRQUNkLGdCQUFnQjtLQUNqQixDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FDYixDQUFDO0lBQ0YsR0FBRyxDQUFDLFNBQVMsQ0FBQywrQkFBK0IsRUFBRSxDQUFDLHdCQUF3QixDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7QUFDeEYsQ0FBQztBQUVELFNBQVMsaUNBQWlDO0lBQ3hDLE9BQU8sU0FBUyxDQUFDLEdBQUcsRUFBRSxrRUFBa0UsQ0FBQyxDQUFDO0FBQzVGLENBQUM7QUFFRDs7Ozs7Ozs7Ozs7OztHQWFHO0FBQ0gsTUFBTSxzQkFBc0IsR0FBRyx3Q0FBd0MsQ0FBQztBQUV4RTs7Ozs7Ozs7O0dBU0c7QUFDSCxTQUFTLFdBQVcsQ0FBQyxPQUF3QjtJQUMzQyxNQUFNLEVBQUUsYUFBYSxFQUFFLEdBQUcsT0FBTyxDQUFDLE9BQU8sQ0FBQztJQUMxQyxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsYUFBYSxDQUFDO1FBQUUsTUFBTSxpQ0FBaUMsRUFBRSxDQUFDO0lBRTVFLDBEQUEwRDtJQUMxRCxJQUFJLGFBQWEsSUFBSSxJQUFJO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFFdkMsTUFBTSxLQUFLLEdBQUcsc0JBQXNCLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxDQUFDO0lBRXpELHlFQUF5RTtJQUN6RSxxQkFBcUI7SUFDckIsSUFBSSxDQUFDLEtBQUs7UUFBRSxNQUFNLGlDQUFpQyxFQUFFLENBQUM7SUFFdEQsbUNBQW1DO0lBQ25DLE9BQU8sS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2xCLENBQUMifQ==